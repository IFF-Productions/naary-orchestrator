/**
 * Activities — the ONLY place side effects are allowed (CLAUDE.md Tier-1 rule 3).
 * This module (and its @naary/secrets / @naary/usage / @naary/db imports) loads
 * in the worker PROCESS, never in the deterministic workflow bundle — workflows.ts
 * imports it type-only.
 */
import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
} from "node:crypto";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { ApplicationFailure } from "@temporalio/activity";
import { SignJWT, importPKCS8 } from "jose";
import nodemailer from "nodemailer";
import { XMLBuilder, XMLParser } from "fast-xml-parser";
import { parse as parseHtml } from "node-html-parser";
import Papa from "papaparse";
import { getQuickJS, shouldInterruptAfterDeadline } from "quickjs-emscripten";
import {
  canonicalize,
  getByPath,
  buildIntegrationRequest,
  getIntegrationAction,
  getIntegrationProvider,
  validateIntegrationConfig,
} from "@naary/dsl";
import type {
  CodeNodeConfig,
  IntegrationNodeConfig,
  GraphDef,
  PollTriggerNodeConfig,
  ResolvedHash,
  ResolvedHmac,
  ResolvedJwt,
  ResolvedRss,
  ResolvedSendEmail,
} from "@naary/dsl";
// Re-export so the interpreter e2e can reference these as activities.* (the hmac/
// jwt/sendEmail/rss activity args are the DSL's Resolved* types).
export type {
  CodeNodeConfig,
  ResolvedHash,
  ResolvedHmac,
  ResolvedJwt,
  ResolvedRss,
  ResolvedSendEmail,
} from "@naary/dsl";
import {
  AuthConfigError,
  BlockedEgressError,
  ConnectionService,
  MissingConnectionTokenError,
  NeedsReauthError,
  assertEgressAllowed,
  assertHostPublic,
  callMcpTool as mcpCall,
  resolveAuthHeader,
  resolveDbConnection,
  resolveSigningKey,
  resolveSmtpUri,
  resolveMcpTarget,
  safeFetch,
} from "@naary/connections";
import { getAdapter } from "@naary/sql";
import { getPrisma } from "@naary/db";
import { createLogger } from "@naary/logging";
import {
  activityDuration,
  activityRuns,
  agentTokens,
  runCostUsd,
  secondsSince,
} from "../metrics";
import { CredentialsService, MissingCredentialError } from "@naary/secrets";
import {
  getObjectStore,
  maybeOffload,
  resolveClaimChecks,
} from "@naary/storage";
import {
  computeCost,
  estimateCallCost,
  getBudget,
  monthToDateSpend,
  recordUsage,
  releaseReservation,
  reserveBudget,
} from "@naary/usage";
import {
  APICallError,
  Output,
  embed,
  embedMany,
  generateText,
  jsonSchema,
} from "ai";

const MAX_OUTPUT_TOKENS = 1024;

// Activities run in the worker PROCESS (a side-effect zone), so structured
// logging is fine here — unlike workflows.ts, which must stay deterministic.
// Logs carry execution-correlated ids (executionId/nodeId/tenantId) and token/
// cost numbers only — never prompts, completions, or keys (the logger scrubs).
const log = createLogger({ component: "worker" });

/**
 * Sanitize a transient error before it leaves the activity. A thrown error is
 * serialized into Temporal history + worker logs; AI-SDK `APICallError` carries
 * `requestBodyValues` / URL / request headers that can include the `Authorization`
 * (provider key) header. We rethrow a fresh, RETRYABLE `ApplicationFailure` that
 * keeps only a status code + generic message — dropping every secret-bearing field —
 * so retryability is preserved (CLAUDE.md: don't burn retries; don't leak secrets).
 */
export function toSanitizedRetryable(
  e: unknown,
  type: string,
): ApplicationFailure {
  if (APICallError.isInstance(e)) {
    return ApplicationFailure.retryable(
      `Provider request failed (status ${e.statusCode ?? "unknown"})`,
      type,
      { statusCode: e.statusCode },
    );
  }
  // Non-provider transient (network blip, timeout): its message is safe, but wrap it
  // so any structured/secret-bearing fields on the original object are not serialized.
  const message = e instanceof Error ? e.message : "Transient activity error";
  return ApplicationFailure.retryable(message, type);
}

export interface AgentConfig {
  provider: string;
  model: string;
  systemPrompt: string;
  /** Per-node structured-output JSON Schema (Slice #6 / QA#9). When set, the agent
   *  is constrained to it; otherwise the default {category, urgency} schema. */
  outputSchema?: Record<string, unknown>;
  /** Sampling temperature (0–2). Omitted ⇒ provider default. */
  temperature?: number;
  /** Per-node output cap; omitted ⇒ MAX_OUTPUT_TOKENS. Also sizes the budget estimate. */
  maxOutputTokens?: number;
  /** Opt-in Anthropic prompt caching of the system prompt (default off). Only worthwhile for a
   *  high-volume agent reusing a large, stable system prompt within Anthropic's ~5-min TTL. */
  cacheSystemPrompt?: boolean;
}

export interface AgentMeta {
  tenantId: string;
  executionId: string;
  nodeId: string;
}

/**
 * Record run ownership (tenant + workflowKey) so EVERY run — manual, webhook, or
 * scheduled — appears in the Runs list and can be authorized by tenant. Idempotent
 * upsert: manual/webhook runs are pre-created by the API (this is then a no-op);
 * scheduled runs (started by Temporal) are created here. Called once at workflow
 * start, behind a `patched()` gate so in-flight runs aren't broken on replay.
 */
export async function recordExecution(meta: {
  workflowId: string;
  tenantId: string;
  workflowKey?: string;
  graphVersion?: number;
}): Promise<void> {
  await getPrisma().execution.upsert({
    where: { workflowId: meta.workflowId },
    create: {
      workflowId: meta.workflowId,
      tenantId: meta.tenantId,
      workflowKey: meta.workflowKey ?? null,
      // Only scheduled runs create here (API runs are pre-created with the version);
      // record the snapshotted version so scheduled runs show it too.
      graphVersion: meta.graphVersion ?? null,
    },
    update: {}, // already recorded — don't clobber the original createdAt
  });
}

/**
 * Push the run's current status + accumulated cost to its Execution row — the
 * read-model the Runs list reads (so listing needs no per-run Temporal calls).
 * Best-effort: a missing row (race before recordExecution) is ignored.
 */
export async function setExecutionStatus(meta: {
  workflowId: string;
  status: string;
  costUsd?: number;
}): Promise<void> {
  await getPrisma()
    .execution.update({
      where: { workflowId: meta.workflowId },
      data: {
        status: meta.status,
        ...(meta.costUsd !== undefined ? { costUsd: meta.costUsd } : {}),
      },
    })
    .catch(() => undefined);
}

/**
 * Durable chat session (design §2.1b, option A): load the last `limit` MESSAGES of a session
 * (oldest-first) so a freshly (re)started session workflow resumes with memory — the ChatMessage
 * table is the durable backing store; the session's in-Temporal history is the live working copy.
 * Mirrors the API's ChatService.loadHistory (ordered by the monotonic `seq`). Empty for a new
 * session. Side effect (DB read) → activity, per Tier-1 #3.
 */
export async function loadChatHistory(meta: {
  tenantId: string;
  chatId: string;
  sessionId: string;
  limit?: number;
}): Promise<{ role: string; text: string }[]> {
  if (!meta.sessionId) return [];
  const rows = await getPrisma().chatMessage.findMany({
    where: {
      tenantId: meta.tenantId,
      chatId: meta.chatId,
      sessionId: meta.sessionId,
    },
    orderBy: { seq: "desc" },
    take: Math.min(Math.max(meta.limit ?? 40, 1), 200),
    select: { role: true, text: true },
  });
  return rows.reverse();
}

/**
 * Durable chat session: persist a completed turn (user + assistant rows) ATOMICALLY, so the table
 * stays the durable record of the conversation even after the session workflow idle-expires. Mirrors
 * ChatService.appendTurn. Side effect (DB write) → activity.
 */
export async function appendChatTurn(meta: {
  tenantId: string;
  chatId: string;
  sessionId: string;
  userText: string;
  assistantText: string;
}): Promise<void> {
  if (!meta.sessionId) return;
  const prisma = getPrisma();
  const base = {
    tenantId: meta.tenantId,
    chatId: meta.chatId,
    sessionId: meta.sessionId,
  };
  await prisma.$transaction([
    prisma.chatMessage.create({
      data: { ...base, role: "user", text: meta.userText },
    }),
    prisma.chatMessage.create({
      data: { ...base, role: "assistant", text: meta.assistantText },
    }),
  ]);
}

export interface DateTimeResult {
  /** ISO-8601 string (UTC). */
  iso: string;
  /** Milliseconds since the Unix epoch. */
  epochMs: number;
}

/**
 * dateTime node — resolve a base time (the current clock when `base` is null, else
 * a passed epoch-ms number / ISO string) and apply an optional offset. The CLOCK
 * READ is the non-deterministic part, which is exactly why this is an activity and
 * not workflow code (CLAUDE.md rule 2/3). No secrets, no egress.
 */
export async function computeDateTime(input: {
  base: string | number | null;
  addSeconds?: number;
}): Promise<DateTimeResult> {
  let baseMs: number;
  if (input.base === null || input.base === undefined) {
    baseMs = Date.now();
  } else if (typeof input.base === "number") {
    baseMs = input.base;
  } else {
    const parsed = Date.parse(input.base);
    baseMs = Number.isNaN(parsed) ? Date.now() : parsed;
  }
  const epochMs = baseMs + (input.addSeconds ?? 0) * 1000;
  return { iso: new Date(epochMs).toISOString(), epochMs };
}

/** A child graph resolved for an executeSubWorkflow node, pinned to its version. */
export interface SubWorkflowGraph {
  graph: GraphDef;
  contentHash: string;
  version: number;
}

/**
 * Resolve the child graph for an `executeSubWorkflow` node: fetch the tenant's
 * latest saved graph for `workflowKey` and snapshot its content hash + version, so
 * the parent run pins an immutable child version (a later edit can't corrupt an
 * in-flight parent — same guarantee as top-level start). The DB read (I/O) lives
 * here, never in the deterministic workflow. A missing graph is a user error (save
 * it first) → non-retryable, so we don't burn Temporal retries on it.
 */
export async function resolveSubWorkflowGraph(meta: {
  tenantId: string;
  workflowKey: string;
}): Promise<SubWorkflowGraph> {
  const row = await getPrisma().graphDefinition.findFirst({
    where: { tenantId: meta.tenantId, workflowKey: meta.workflowKey },
    orderBy: { version: "desc" },
  });
  if (!row) {
    throw ApplicationFailure.nonRetryable(
      `No saved graph for workflowKey '${meta.workflowKey}' — save it before calling it as a sub-workflow`,
      "SUBWORKFLOW_GRAPH_NOT_FOUND",
    );
  }
  const graph = row.graph as unknown as GraphDef;
  const contentHash = createHash("sha256")
    .update(canonicalize(graph))
    .digest("hex");
  return { graph, contentHash, version: row.version };
}

// Signing key resolution is the injectable I/O seam for the hmac/jwt activities
// (swapped in unit tests so no DB/secret store is needed).
export const __signingDeps = { resolveSigningKey };

/** Map a missing/invalid signing key to a clear non-retryable failure; anything
 *  else is a sanitized transient (never leaks the key). */
function toSigningFailure(e: unknown, type: string): ApplicationFailure {
  if (e instanceof ApplicationFailure) return e;
  if (
    e instanceof MissingConnectionTokenError ||
    e instanceof NeedsReauthError
  ) {
    return ApplicationFailure.nonRetryable(
      "Signing connection has no usable key — reconnect it",
      "CONNECTION_REAUTH",
    );
  }
  return toSanitizedRetryable(e, type);
}

export interface HmacResult {
  status: "ok";
  digest: string;
  costUsd: number;
}

/** Coerce a rehydrated payload to the bytes that get signed (objects → JSON). */
function toSignedString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * hmac node — sign the resolved payload with the `signing` connection's key. The
 * key is read here and used in memory only (never returned/logged/in history). A
 * bound payload that was claim-checked upstream is rehydrated FIRST, so we sign the
 * real data, not the `{__claimCheck}` reference (mirrors callSqlQuery/callHttpRequest).
 */
export async function callHmac(
  cfg: ResolvedHmac,
  _input: unknown,
  meta: AgentMeta,
): Promise<HmacResult> {
  const startedAt = process.hrtime.bigint();
  try {
    const store = getObjectStore();
    const key = await __signingDeps.resolveSigningKey(
      meta.tenantId,
      cfg.connectionId,
    );
    const payload = toSignedString(
      await resolveClaimChecks(cfg.payload, store),
    );
    const digest = createHmac(cfg.algorithm, key)
      .update(payload)
      .digest(cfg.encoding);
    activityRuns.inc({ activity: "callHmac", outcome: "ok" });
    activityDuration.observe({ activity: "callHmac" }, secondsSince(startedAt));
    return { status: "ok", digest, costUsd: 0 };
  } catch (e) {
    activityRuns.inc({ activity: "callHmac", outcome: "error" });
    activityDuration.observe({ activity: "callHmac" }, secondsSince(startedAt));
    throw toSigningFailure(e, "HMAC_ERROR");
  }
}

export interface HashResult {
  status: "ok";
  digest: string;
  costUsd: number;
}

/**
 * hash node — a keyless one-way digest of the resolved input (n8n's String.hash()). Runs in
 * an activity (node:crypto isn't in the deterministic bundle). A claim-checked bound input is
 * rehydrated FIRST so we hash the real data, not the `{__claimCheck}` reference. No secrets.
 */
export async function callHash(
  cfg: ResolvedHash,
  _input: unknown,
  meta: AgentMeta,
): Promise<HashResult> {
  const startedAt = process.hrtime.bigint();
  try {
    const store = getObjectStore();
    const value = toSignedString(await resolveClaimChecks(cfg.input, store));
    const digest = createHash(cfg.algorithm).update(value).digest(cfg.encoding);
    activityRuns.inc({ activity: "callHash", outcome: "ok" });
    activityDuration.observe({ activity: "callHash" }, secondsSince(startedAt));
    return { status: "ok", digest, costUsd: 0 };
  } catch {
    activityRuns.inc({ activity: "callHash", outcome: "error" });
    activityDuration.observe({ activity: "callHash" }, secondsSince(startedAt));
    throw ApplicationFailure.nonRetryable("Hash failed", "HASH_ERROR");
  }
}

export interface JwtResult {
  status: "ok";
  token: string;
  costUsd: number;
}

/**
 * jwt node — mint an HS256 JWT from the resolved claims, signed by the `signing`
 * connection's key. `iat` is stamped; `exp` set when `expiresInSeconds` is given.
 */
export async function callJwt(
  cfg: ResolvedJwt,
  _input: unknown,
  meta: AgentMeta,
): Promise<JwtResult> {
  const startedAt = process.hrtime.bigint();
  try {
    const store = getObjectStore();
    const key = await __signingDeps.resolveSigningKey(
      meta.tenantId,
      cfg.connectionId,
    );
    // Rehydrate any claim-checked bound claim value before signing (so the token
    // carries the real data, not a `{__claimCheck}` reference).
    const claims = (await resolveClaimChecks(cfg.claims, store)) as Record<
      string,
      unknown
    >;
    // HS256: the key is the shared secret. RS256: the key is a PEM PKCS#8 RSA
    // private key, imported into a CryptoKey.
    const signKey =
      cfg.algorithm === "RS256"
        ? await importPKCS8(key, "RS256")
        : new TextEncoder().encode(key);
    let signer = new SignJWT(claims)
      .setProtectedHeader({ alg: cfg.algorithm })
      .setIssuedAt();
    if (cfg.expiresInSeconds && cfg.expiresInSeconds > 0) {
      signer = signer.setExpirationTime(
        new Date(Date.now() + cfg.expiresInSeconds * 1000),
      );
    }
    const token = await signer.sign(signKey);
    activityRuns.inc({ activity: "callJwt", outcome: "ok" });
    activityDuration.observe({ activity: "callJwt" }, secondsSince(startedAt));
    return { status: "ok", token, costUsd: 0 };
  } catch (e) {
    activityRuns.inc({ activity: "callJwt", outcome: "error" });
    activityDuration.observe({ activity: "callJwt" }, secondsSince(startedAt));
    throw toSigningFailure(e, "JWT_ERROR");
  }
}

/** Decode an RFC-4648 base32 string (the TOTP seed) to bytes. Case-insensitive,
 *  ignores whitespace and padding. Throws on an invalid character (message carries
 *  no secret). */
function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = input.replace(/[=\s]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of clean) {
    const idx = alphabet.indexOf(c);
    if (idx === -1) throw new Error("invalid base32 TOTP seed");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC-4226 HOTP → the `digits`-length code for `counter`. */
function hotp(
  secret: Buffer,
  counter: number,
  digits: number,
  algorithm: string,
): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm, secret).update(buf).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin =
    ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff);
  return (bin % 10 ** digits).toString().padStart(digits, "0");
}

export interface TotpConfig {
  connectionId: string;
  digits?: number;
  period?: number;
  algorithm?: "sha1" | "sha256" | "sha512";
}

export interface TotpResult {
  status: "ok";
  code: string;
  costUsd: number;
}

// Injectable seam: the seed resolver + the clock (so tests are deterministic).
export const __totpDeps = { resolveSigningKey, now: () => Date.now() };

/**
 * totp node — generate the current RFC-6238 code from a `signing` connection's
 * base32 seed. The seed is read + used here only (never returned/logged/in
 * history); the clock read is why this is an activity, not workflow code.
 */
export async function callTotp(
  cfg: TotpConfig,
  _input: unknown,
  meta: AgentMeta,
): Promise<TotpResult> {
  const startedAt = process.hrtime.bigint();
  try {
    const seed = await __totpDeps.resolveSigningKey(
      meta.tenantId,
      cfg.connectionId,
    );
    const secret = base32Decode(seed);
    const period = cfg.period && cfg.period > 0 ? cfg.period : 30;
    const digits = cfg.digits && cfg.digits > 0 ? cfg.digits : 6;
    const counter = Math.floor(__totpDeps.now() / 1000 / period);
    const code = hotp(secret, counter, digits, cfg.algorithm ?? "sha1");
    activityRuns.inc({ activity: "callTotp", outcome: "ok" });
    activityDuration.observe({ activity: "callTotp" }, secondsSince(startedAt));
    return { status: "ok", code, costUsd: 0 };
  } catch (e) {
    activityRuns.inc({ activity: "callTotp", outcome: "error" });
    activityDuration.observe({ activity: "callTotp" }, secondsSince(startedAt));
    throw toSigningFailure(e, "TOTP_ERROR");
  }
}

export interface SendEmailResult {
  status: "ok";
  messageId: string;
  costUsd: number;
}

// Injectable I/O seam for the sendEmail activity (swapped in unit tests so no real
// SMTP/DNS is touched): the SMTP-URI resolver, the transport factory, and the host
// SSRF check.
export const __emailDeps = {
  resolveSmtpUri,
  assertHostPublic,
  createTransport: (uri: string) => nodemailer.createTransport(uri),
};

/**
 * sendEmail node — send a message via an `smtp` connection. The SMTP URI (with
 * credentials) is read + used here and never returned/logged/in history. SSRF: the
 * SMTP host is resolved and required to be public BEFORE connecting (a
 * tenant-supplied host could otherwise point at an internal service). `from`
 * defaults to the URI's user when unset.
 */
export async function callSendEmail(
  cfg: ResolvedSendEmail,
  _input: unknown,
  meta: AgentMeta,
): Promise<SendEmailResult> {
  const startedAt = process.hrtime.bigint();
  try {
    const uri = await __emailDeps.resolveSmtpUri(
      meta.tenantId,
      cfg.connectionId,
    );
    const parsed = new URL(uri);
    // SSRF guard: reject a private/reserved SMTP host (checked at call time).
    await __emailDeps.assertHostPublic(parsed.hostname);
    const from =
      cfg.from ||
      (parsed.username ? decodeURIComponent(parsed.username) : undefined);
    const transport = __emailDeps.createTransport(uri);
    const info = await transport.sendMail({
      from,
      to: cfg.to,
      subject: cfg.subject,
      ...(cfg.text !== undefined ? { text: cfg.text } : {}),
      ...(cfg.html !== undefined ? { html: cfg.html } : {}),
    });
    log.info(
      {
        activity: "callSendEmail",
        executionId: meta.executionId,
        nodeId: meta.nodeId,
        tenantId: meta.tenantId,
        connectionId: cfg.connectionId,
        costUsd: cfg.costUsd ?? 0,
      },
      "email sent",
    );
    activityRuns.inc({ activity: "callSendEmail", outcome: "ok" });
    activityDuration.observe(
      { activity: "callSendEmail" },
      secondsSince(startedAt),
    );
    if ((cfg.costUsd ?? 0) > 0) runCostUsd.inc(cfg.costUsd ?? 0);
    return {
      status: "ok",
      messageId: info.messageId ?? "",
      costUsd: cfg.costUsd ?? 0,
    };
  } catch (e) {
    activityRuns.inc({ activity: "callSendEmail", outcome: "error" });
    activityDuration.observe(
      { activity: "callSendEmail" },
      secondsSince(startedAt),
    );
    if (e instanceof ApplicationFailure) throw e;
    // A missing SMTP URI, or a blocked host: the user must fix it — non-retryable.
    if (
      e instanceof MissingConnectionTokenError ||
      e instanceof NeedsReauthError
    ) {
      throw ApplicationFailure.nonRetryable(
        "SMTP connection has no usable URI — reconnect it",
        "CONNECTION_REAUTH",
      );
    }
    if (e instanceof BlockedEgressError) {
      throw ApplicationFailure.nonRetryable(e.message, "EGRESS_BLOCKED");
    }
    // Transient SMTP failure (timeout, greylisting, auth). Drop the original message
    // ENTIRELY — nodemailer errors can embed the host/URI/credentials — so nothing
    // secret-bearing reaches history/logs.
    throw ApplicationFailure.retryable(
      "Email send failed (transient SMTP error)",
      "SEND_EMAIL_ERROR",
      { connectionId: cfg.connectionId },
    );
  }
}

export interface RssItem {
  title: string;
  link: string;
  summary: string;
  published: string;
  id: string;
}
export interface RssResult {
  status: "ok";
  items: RssItem[];
  count: number;
  costUsd: number;
}

const DEFAULT_RSS_TIMEOUT_MS = 15_000;
const MAX_RSS_TIMEOUT_MS = 30_000;
const MAX_RSS_ITEMS = 100; // feeds are small; bound the inline payload anyway.

// Injectable I/O seam for the rssRead activity (swapped in unit tests).
export const __rssDeps = {
  // SSRF-hardened: guarded connector re-checks every redirect hop + pins the
  // validated IP (closes S-1 redirect-bypass + S-2 DNS-rebind).
  fetch: (url: string, init?: RequestInit) =>
    safeFetch(url, init as never) as unknown as Promise<Response>,
  assertEgressAllowed,
};

/** Flatten an XML text node (fast-xml-parser may give a string or {#text}). */
function xmlText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object" && "#text" in (v as Record<string, unknown>)) {
    return String((v as Record<string, unknown>)["#text"]);
  }
  return typeof v === "object" ? "" : String(v);
}

/** Normalize RSS 2.0 `channel.item` or Atom `feed.entry` into items. */
function normalizeFeed(parsed: Record<string, unknown>): RssItem[] {
  const rss = parsed.rss as { channel?: { item?: unknown } } | undefined;
  const feed = parsed.feed as { entry?: unknown } | undefined;
  const raw = rss?.channel?.item ?? feed?.entry ?? [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr
    .filter(Boolean)
    .slice(0, MAX_RSS_ITEMS)
    .map((it) => {
      const item = it as Record<string, unknown>;
      // Atom <link href="…"> vs RSS <link>text</link>.
      const rawLink = item.link as unknown;
      const link =
        typeof rawLink === "string"
          ? rawLink
          : xmlText((rawLink as Record<string, unknown>)?.["@_href"]) ||
            xmlText(rawLink);
      return {
        title: xmlText(item.title),
        link,
        summary: xmlText(item.description ?? item.summary ?? item.content),
        published: xmlText(item.pubDate ?? item.published ?? item.updated),
        id: xmlText(item.guid ?? item.id) || link,
      };
    });
}

/**
 * rssRead node — fetch an RSS/Atom feed (egress-guarded, https + public host) and
 * parse it into normalized items. No secrets; the URL is non-secret.
 */
export async function callRssRead(
  cfg: ResolvedRss,
  _input: unknown,
  meta: AgentMeta,
): Promise<RssResult> {
  const startedAt = process.hrtime.bigint();
  void meta;
  try {
    await __rssDeps.assertEgressAllowed(cfg.url); // https + public (SSRF guard)
    const controller = new AbortController();
    const timeoutMs = Math.min(
      cfg.timeoutMs ?? DEFAULT_RSS_TIMEOUT_MS,
      MAX_RSS_TIMEOUT_MS,
    );
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let xml: string;
    try {
      const res = await __rssDeps.fetch(cfg.url, { signal: controller.signal });
      xml = await res.text();
    } finally {
      clearTimeout(timer);
    }
    const parsed = new XMLParser({ ignoreAttributes: false }).parse(xml) as
      Record<string, unknown> | undefined;
    const items = parsed ? normalizeFeed(parsed) : [];
    activityRuns.inc({ activity: "callRssRead", outcome: "ok" });
    activityDuration.observe(
      { activity: "callRssRead" },
      secondsSince(startedAt),
    );
    return { status: "ok", items, count: items.length, costUsd: 0 };
  } catch (e) {
    activityRuns.inc({ activity: "callRssRead", outcome: "error" });
    activityDuration.observe(
      { activity: "callRssRead" },
      secondsSince(startedAt),
    );
    if (e instanceof ApplicationFailure) throw e;
    if (e instanceof BlockedEgressError) {
      throw ApplicationFailure.nonRetryable(e.message, "EGRESS_BLOCKED");
    }
    // Fetch/parse failure — the feed URL is non-secret, so a sanitized retryable is fine.
    throw toSanitizedRetryable(e, "RSS_READ_ERROR");
  }
}

/** Change-detection state for a pollTrigger, keyed by (tenant, workflow, node) so it
 *  persists across the scheduled runs (NOT executionId, which changes each run). */
export interface PollMeta {
  tenantId: string;
  workflowKey: string;
  nodeId: string;
}
export interface PollResult {
  status: "ok";
  changed: boolean;
  body: unknown;
  costUsd: number;
}

const DEFAULT_POLL_TIMEOUT_MS = 15_000;
const MAX_POLL_TIMEOUT_MS = 30_000;

// Test seam: egress fetch + the cursor read/write, swappable in unit tests.
export const __pollDeps = {
  fetch: (url: string, init?: RequestInit) =>
    safeFetch(url, init as never) as unknown as Promise<Response>,
  assertEgressAllowed,
  readCursor: (meta: PollMeta): Promise<string | null> =>
    getPrisma()
      .pollState.findUnique({
        where: {
          tenantId_workflowKey_nodeId: {
            tenantId: meta.tenantId,
            workflowKey: meta.workflowKey,
            nodeId: meta.nodeId,
          },
        },
      })
      .then((r) => r?.lastKey ?? null),
  writeCursor: async (meta: PollMeta, lastKey: string): Promise<void> => {
    await getPrisma().pollState.upsert({
      where: {
        tenantId_workflowKey_nodeId: {
          tenantId: meta.tenantId,
          workflowKey: meta.workflowKey,
          nodeId: meta.nodeId,
        },
      },
      create: { ...meta, lastKey },
      update: { lastKey },
    });
  },
};

/**
 * pollTrigger node — fetch a URL and report whether the source CHANGED since the last
 * poll. The change key is the configured JSON path (or the whole body) hashed; it is
 * compared to a persisted per-(tenant, workflow, node) cursor and the cursor is
 * advanced. Side-effecting (egress + DB), so it's an activity. The URL is non-secret.
 * On the FIRST poll (no cursor) `changed` is true so the flow runs once to seed.
 */
export async function callPoll(
  cfg: PollTriggerNodeConfig,
  meta: PollMeta,
): Promise<PollResult> {
  const startedAt = process.hrtime.bigint();
  try {
    await __pollDeps.assertEgressAllowed(cfg.url); // https + public host (SSRF guard)
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.min(DEFAULT_POLL_TIMEOUT_MS, MAX_POLL_TIMEOUT_MS),
    );
    let text: string;
    try {
      const res = await __pollDeps.fetch(cfg.url, {
        signal: controller.signal,
      });
      text = await res.text();
    } finally {
      clearTimeout(timer);
    }

    // Parse JSON when possible so `changeKey` can select a field + the body is usable
    // downstream; fall back to the raw text.
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON — keep the text body */
    }

    // The change value: a selected path, or the whole body. Hash it to a compact,
    // storable key (avoids persisting large payloads in PollState).
    const value = cfg.changeKey
      ? getByPath(body, cfg.changeKey)
      : (body ?? text);
    const key = createHash("sha256")
      .update(typeof value === "string" ? value : JSON.stringify(value ?? null))
      .digest("hex");

    const previous = await __pollDeps.readCursor(meta);
    const changed = previous !== key; // first poll (previous null) ⇒ changed
    if (changed) await __pollDeps.writeCursor(meta, key);

    activityRuns.inc({ activity: "callPoll", outcome: "ok" });
    activityDuration.observe({ activity: "callPoll" }, secondsSince(startedAt));
    return { status: "ok", changed, body, costUsd: 0 };
  } catch (e) {
    activityRuns.inc({ activity: "callPoll", outcome: "error" });
    activityDuration.observe({ activity: "callPoll" }, secondsSince(startedAt));
    if (e instanceof ApplicationFailure) throw e;
    if (e instanceof BlockedEgressError) {
      throw ApplicationFailure.nonRetryable(e.message, "EGRESS_BLOCKED");
    }
    throw toSanitizedRetryable(e, "POLL_ERROR");
  }
}

export type NotificationKind = "approval_pending" | "run_failed";
export interface NotificationInput {
  tenantId: string;
  kind: NotificationKind;
  workflowId: string;
  workflowKey?: string;
  /** For approval_pending: the approval node's title (from the graph). */
  title?: string;
  /** For run_failed: the terminal status / error type. */
  detail?: string;
}

// Test seam: settings read + egress fetch, swappable so tests need no DB/network.
export const __notifyDeps = {
  readSettings: (
    tenantId: string,
  ): Promise<{
    webhookUrl: string | null;
    channel: string | null;
    onApprovalPending: boolean;
    onRunFailed: boolean;
  } | null> =>
    getPrisma().notificationSettings.findUnique({ where: { tenantId } }),
  fetch: (url: string, init?: RequestInit) =>
    safeFetch(url, init as never) as unknown as Promise<Response>,
  assertEgressAllowed,
};

/**
 * Signed approve/reject decision link for the pause notification (the notification-links gap). MUST
 * match the API's `mintApprovalToken` (apps/api/.../approval-token.ts): HMAC-SHA256(ENCRYPTION_KEY,
 * "approval:"+workflowId) — the API verifies it. `APP_BASE_URL` prepends the host; it returns
 * undefined when EITHER the encryption key OR APP_BASE_URL is missing (a relative /approve/… link
 * is useless as a Slack button). The recipient clicks it to Approve/Reject WITHOUT opening the app.
 */
function approvalUrl(workflowId: string): string | undefined {
  const key = process.env.ENCRYPTION_KEY;
  const base = (process.env.APP_BASE_URL ?? "").replace(/\/$/, "");
  // Both are required for an absolute, clickable link. Without APP_BASE_URL the URL would be
  // relative (`/approve/…`) — useless as a Slack url-button — so omit it (like runUrl).
  if (!key || !base) return undefined;
  const token = createHmac("sha256", key)
    .update(`approval:${workflowId}`)
    .digest("hex");
  return `${base}/approve/${encodeURIComponent(workflowId)}?token=${token}`;
}

/** Deep link to the run detail page — the resource the recipient needs to act on. Needs
 *  APP_BASE_URL (the SPA host); without it there's no absolute URL to build, so undefined. */
function runUrl(workflowId: string): string | undefined {
  const base = (process.env.APP_BASE_URL ?? "").replace(/\/$/, "");
  if (!base) return undefined;
  return `${base}/app/runs/${encodeURIComponent(workflowId)}`;
}

/** Human-readable line for the notification (what a Slack/Teams webhook shows). Includes a
 *  deep link to the resource to act on: the signed approve/reject link for a pause, otherwise
 *  the run detail page. */
function notificationText(input: NotificationInput): string {
  const wf = input.workflowKey ? `"${input.workflowKey}"` : "a workflow";
  const run = runUrl(input.workflowId);
  if (input.kind === "approval_pending") {
    const url = approvalUrl(input.workflowId);
    return `⏳ Approval needed on ${wf}${input.title ? `: ${input.title}` : ""} (run ${input.workflowId}).${url ? ` Approve or reject: ${url}` : ""}`;
  }
  return `❌ ${wf} run failed${input.detail ? ` (${input.detail})` : ""} — run ${input.workflowId}.${run ? ` View: ${run}` : ""}`;
}

/**
 * Slack Block Kit blocks: a header + a fields section (where the run is an actual inline
 * `<url|…>` link, not a bare id reference) + an `actions` row of link-buttons — the
 * "multiple entries" a recipient can act on (Approve/Reject, View run). Slack renders
 * `blocks` when present; generic/Teams hooks fall back to top-level `text` + the flat
 * fields. Buttons carry absolute `url`s, so no Slack interactivity wiring is needed.
 */
/** Escape the three characters Slack treats as mrkdwn control chars (& < >) so an id/label
 *  containing them can't break a `<url|label>` link or inject markup. `&` first, always. */
function slackEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

type NotificationAction = {
  label: string;
  url: string;
  /** Slack button colour: primary (green) for approve, danger (red) for reject. */
  style?: "primary" | "danger";
};

/** Short headline for the notification, shared by the Slack header + the Teams card. */
function notificationHeader(input: NotificationInput): string {
  return input.kind === "approval_pending"
    ? "⏳ Approval needed"
    : "❌ Run failed";
}

/** The action links a recipient can act on — Approve/Reject for a pause (each with the
 *  choice pre-selected on the signed page) plus View run. Shared by the Slack blocks and
 *  the Teams card so both stay in step. */
function notificationActions(input: NotificationInput): NotificationAction[] {
  const actions: NotificationAction[] = [];
  if (input.kind === "approval_pending") {
    const approve = approvalUrl(input.workflowId);
    if (approve) {
      // Two one-click buttons instead of one "Approve / Reject": each deep-links to the
      // signed decision page with the choice pre-selected (?…&decision=approve|reject).
      // The page still requires an explicit confirm click, so a link-prefetch can't decide.
      actions.push({
        label: "✅ Approve",
        url: `${approve}&decision=approve`,
        style: "primary",
      });
      actions.push({
        label: "❌ Reject",
        url: `${approve}&decision=reject`,
        style: "danger",
      });
    }
  }
  const run = runUrl(input.workflowId);
  if (run) actions.push({ label: "View run", url: run });
  return actions;
}

function notificationBlocks(
  input: NotificationInput,
  _text: string,
): { blocks: unknown[]; actions: NotificationAction[] } {
  const isApproval = input.kind === "approval_pending";

  const actions = notificationActions(input);
  const run = runUrl(input.workflowId);

  // The run as an ACTUAL clickable link when we have a URL, not a bare id reference. The
  // label is escaped so a workflowId with & < > can't break the `<url|label>` markup (the
  // URL itself is already encodeURIComponent'd by runUrl, so it needs no escaping).
  const runId = slackEscape(input.workflowId);
  const runField = run ? `<${run}|run ${runId}>` : `\`${runId}\``;
  const fields: { type: "mrkdwn"; text: string }[] = [
    {
      type: "mrkdwn",
      text: `*Workflow*\n${input.workflowKey ? `\`${slackEscape(input.workflowKey)}\`` : "_unnamed_"}`,
    },
    { type: "mrkdwn", text: `*Run*\n${runField}` },
  ];
  if (isApproval && input.title)
    fields.push({
      type: "mrkdwn",
      text: `*Awaiting*\n${slackEscape(input.title)}`,
    });
  if (!isApproval && input.detail)
    fields.push({
      type: "mrkdwn",
      text: `*Reason*\n\`${slackEscape(input.detail)}\``,
    });

  const blocks: unknown[] = [
    {
      type: "header",
      // header is plain_text only; unicode emoji render with emoji:true.
      text: {
        type: "plain_text",
        text: notificationHeader(input),
        emoji: true,
      },
    },
    { type: "section", fields },
  ];
  if (actions.length)
    blocks.push({
      type: "actions",
      elements: actions.map((a, i) => ({
        type: "button",
        // Slack rejects an actions block whose buttons lack an action_id (invalid_blocks),
        // even for url-only buttons — derive a stable one from the label.
        action_id: `${a.label.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_${i}`,
        // emoji:true so the ✅/❌ in the label render as icons on the buttons.
        text: { type: "plain_text", text: a.label, emoji: true },
        url: a.url,
        ...(a.style ? { style: a.style } : {}),
      })),
    });
  return { blocks, actions };
}

/**
 * Microsoft Teams payload: an Adaptive Card wrapped in the {type:"message",attachments:[…]}
 * envelope a Teams Workflows / Incoming-Webhook renders (the legacy MessageCard connector is
 * retiring). Same header + facts + Approve/Reject/View-run buttons as Slack, but as an
 * Adaptive Card — FactSet facts are PLAIN JSON strings (NOT mrkdwn, so no slackEscape — that
 * would double-encode into visible `&amp;`), and links are `Action.OpenUrl` (Teams supports
 * OpenUrl/ShowCard/ToggleVisibility, NOT Action.Submit). Shape verified against Microsoft's
 * docs; not yet verified against a live Teams tenant (use the settings "send test" path).
 */
function notificationTeamsCard(input: NotificationInput): unknown {
  const isApproval = input.kind === "approval_pending";
  const facts: { title: string; value: string }[] = [
    { title: "Workflow", value: input.workflowKey ?? "(unnamed)" },
    { title: "Run", value: input.workflowId },
  ];
  if (isApproval && input.title)
    facts.push({ title: "Awaiting", value: input.title });
  if (!isApproval && input.detail)
    facts.push({ title: "Reason", value: input.detail });

  const body: unknown[] = [
    {
      type: "TextBlock",
      text: notificationHeader(input),
      weight: "Bolder",
      size: "Large",
      wrap: true,
    },
    { type: "FactSet", facts },
  ];

  const actions = notificationActions(input).map((a) => ({
    type: "Action.OpenUrl",
    title: a.label,
    url: a.url,
    // Adaptive Card action styles — Teams renders positive (green) / destructive (red).
    ...(a.style === "primary"
      ? { style: "positive" }
      : a.style === "danger"
        ? { style: "destructive" }
        : {}),
  }));

  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.2",
          body,
          ...(actions.length ? { actions } : {}),
        },
      },
    ],
  };
}

/**
 * Fire a tenant notification for an approval-pending or failed run. BEST-EFFORT: reads
 * the tenant's NotificationSettings, and — only if a webhook is set and the event is
 * enabled — POSTs an egress-guarded JSON payload (Slack/Teams/generic compatible). A
 * no-op when unconfigured or disabled. This activity NEVER throws (a notification
 * problem must not affect the run); the caller also wraps it defensively.
 */
export async function sendNotification(
  input: NotificationInput,
): Promise<void> {
  try {
    const settings = await __notifyDeps.readSettings(input.tenantId);
    if (!settings?.webhookUrl) return;
    if (input.kind === "approval_pending" && !settings.onApprovalPending)
      return;
    if (input.kind === "run_failed" && !settings.onRunFailed) return;

    await __notifyDeps.assertEgressAllowed(settings.webhookUrl); // https + public
    const text = notificationText(input);
    // Teams needs its own Adaptive Card envelope; anything else (default) gets the
    // Slack/generic payload. Unknown/legacy channel values fall back to Slack.
    const payload =
      settings.channel === "teams"
        ? notificationTeamsCard(input)
        : (() => {
            const { blocks, actions } = notificationBlocks(input, text);
            // `text` is the Slack/generic fallback line; `blocks` render the action
            // buttons in Slack; the flat fields + `actions`/`runUrl` serve generic hooks.
            return {
              text,
              blocks,
              kind: input.kind,
              workflowId: input.workflowId,
              workflowKey: input.workflowKey,
              title: input.title,
              runUrl: runUrl(input.workflowId),
              actions,
              ...(input.kind === "approval_pending"
                ? { approvalUrl: approvalUrl(input.workflowId) }
                : {}),
            };
          })();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      await __notifyDeps.fetch(settings.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    activityRuns.inc({ activity: "sendNotification", outcome: "ok" });
  } catch {
    // Best-effort: swallow everything (bad URL, blocked egress, timeout, 5xx).
    activityRuns.inc({ activity: "sendNotification", outcome: "error" });
  }
}

export interface XmlConfig {
  operation: "parse" | "build";
}
export interface XmlResult {
  status: "ok";
  result: unknown;
  costUsd: number;
}

/**
 * xml node — parse an XML string → object, or build an object → XML string. Pure
 * transform (no secrets, no egress), but runs in an activity to keep the parser out
 * of the deterministic workflow bundle. Claim-checked input is rehydrated first; a
 * large result is offloaded.
 */
export interface HtmlExtraction {
  key: string;
  selector: string;
  return?: "text" | "html" | "attribute";
  attribute?: string;
  all?: boolean;
}
export interface HtmlExtractConfig {
  extractions: HtmlExtraction[];
}
export interface HtmlExtractResult {
  status: "ok";
  result: Record<string, unknown>;
  costUsd: number;
}

/**
 * htmlExtract node — pull values out of an HTML string with CSS selectors. Pure transform
 * (no secrets, no egress — the fetch is a separate httpRequest node), but runs in an activity
 * to keep the HTML parser out of the deterministic workflow bundle (like callXml). Each
 * extraction reads a matched element's text / inner HTML / attribute; `all` returns every
 * match. Claim-checked input is rehydrated first; a large result is offloaded.
 */
export async function callHtmlExtract(
  cfg: HtmlExtractConfig,
  input: unknown,
  meta: AgentMeta,
): Promise<HtmlExtractResult> {
  const startedAt = process.hrtime.bigint();
  const store = getObjectStore();
  const value = await resolveClaimChecks(input, store);
  try {
    const root = parseHtml(String(value));
    const readEl = (
      el: ReturnType<typeof root.querySelector>,
      ex: HtmlExtraction,
    ): string | null => {
      if (!el) return null;
      if (ex.return === "html") return el.innerHTML;
      if (ex.return === "attribute")
        return el.getAttribute(ex.attribute ?? "") ?? null;
      return el.text.trim();
    };
    const out: Record<string, unknown> = {};
    for (const ex of cfg.extractions ?? []) {
      if (!ex.key || !ex.selector) continue;
      out[ex.key] = ex.all
        ? root.querySelectorAll(ex.selector).map((el) => readEl(el, ex))
        : readEl(root.querySelector(ex.selector), ex);
    }
    const offloaded = await maybeOffload(out, store, {
      keyPrefix: `html/${meta.tenantId}`,
    });
    activityRuns.inc({ activity: "callHtmlExtract", outcome: "ok" });
    activityDuration.observe(
      { activity: "callHtmlExtract" },
      secondsSince(startedAt),
    );
    return {
      status: "ok",
      result: offloaded as Record<string, unknown>,
      costUsd: 0,
    };
  } catch {
    activityRuns.inc({ activity: "callHtmlExtract", outcome: "error" });
    activityDuration.observe(
      { activity: "callHtmlExtract" },
      secondsSince(startedAt),
    );
    throw ApplicationFailure.nonRetryable("HTML extract failed", "HTML_ERROR");
  }
}

export interface MarkdownResult {
  status: "ok";
  result: Record<string, unknown>;
  costUsd: number;
}

/**
 * markdown node — convert an HTML string to Markdown. Pure transform (no secrets, no egress), but
 * runs in an activity to keep the HTML parser out of the deterministic workflow bundle (like
 * callHtmlExtract). Covers the common tags (headings, p, br, strong/em, a, ul/ol/li, code/pre,
 * blockquote, hr); unknown tags fall through to their children's text. Not a full CommonMark
 * round-trip — a pragmatic converter for feeding scraped HTML to an agent as clean Markdown.
 */
export async function callMarkdown(
  input: unknown,
  meta: AgentMeta,
): Promise<MarkdownResult> {
  const startedAt = process.hrtime.bigint();
  const store = getObjectStore();
  const value = await resolveClaimChecks(input, store);
  try {
    const markdown = htmlToMarkdown(String(value ?? ""));
    const offloaded = await maybeOffload({ markdown }, store, {
      keyPrefix: `md/${meta.tenantId}`,
    });
    activityRuns.inc({ activity: "callMarkdown", outcome: "ok" });
    activityDuration.observe(
      { activity: "callMarkdown" },
      secondsSince(startedAt),
    );
    return {
      status: "ok",
      result: offloaded as Record<string, unknown>,
      costUsd: 0,
    };
  } catch {
    activityRuns.inc({ activity: "callMarkdown", outcome: "error" });
    activityDuration.observe(
      { activity: "callMarkdown" },
      secondsSince(startedAt),
    );
    throw ApplicationFailure.nonRetryable(
      "Markdown conversion failed",
      "MARKDOWN_ERROR",
    );
  }
}

/** Pure HTML→Markdown conversion (exported for unit tests; the activity wraps it with the store).
 *  Common-tag subset — not a full CommonMark round-trip. */
export function htmlToMarkdown(html: string): string {
  return normalizeMarkdown(htmlNodeToMarkdown(parseHtml(html) as HtmlNodeLike));
}

/** Minimal node shape from node-html-parser we rely on (avoids importing its classes). */
interface HtmlNodeLike {
  nodeType: number; // 1 = element, 3 = text
  rawTagName?: string;
  rawText?: string;
  text?: string;
  childNodes?: HtmlNodeLike[];
  getAttribute?: (name: string) => string | null | undefined;
}

/** Recursively render a parsed HTML node to Markdown (common-tag subset). */
function htmlNodeToMarkdown(node: HtmlNodeLike): string {
  if (node.nodeType === 3) {
    // Text node — collapse internal whitespace (block structure adds the newlines).
    return String(node.rawText ?? node.text ?? "").replace(/\s+/g, " ");
  }
  const kids = () => (node.childNodes ?? []).map(htmlNodeToMarkdown).join("");
  const tag = (node.rawTagName ?? "").toLowerCase();
  switch (tag) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return `\n\n${"#".repeat(Number(tag[1]))} ${kids().trim()}\n\n`;
    case "p":
    case "div":
    case "section":
    case "article":
      return `\n\n${kids().trim()}\n\n`;
    case "br":
      return "  \n";
    case "hr":
      return "\n\n---\n\n";
    case "strong":
    case "b":
      return `**${kids().trim()}**`;
    case "em":
    case "i":
      return `_${kids().trim()}_`;
    case "code":
      return `\`${(node.text ?? "").trim()}\``;
    case "pre":
      return `\n\n\`\`\`\n${(node.text ?? "").replace(/\s+$/, "")}\n\`\`\`\n\n`;
    case "a": {
      const href = node.getAttribute?.("href");
      const label = kids().trim();
      return href ? `[${label}](${href})` : label;
    }
    case "blockquote":
      return `\n\n> ${kids().trim().replace(/\n+/g, "\n> ")}\n\n`;
    case "ul":
      return `\n\n${renderList(node, false)}\n\n`;
    case "ol":
      return `\n\n${renderList(node, true)}\n\n`;
    case "li":
      return kids().trim(); // list markers are added by renderList
    default:
      return kids();
  }
}

/** Render <ul>/<ol> children <li> as a bulleted/numbered Markdown list. */
function renderList(node: HtmlNodeLike, ordered: boolean): string {
  const items = (node.childNodes ?? []).filter(
    (c) => (c.rawTagName ?? "").toLowerCase() === "li",
  );
  return items
    .map((li, i) => {
      const marker = ordered ? `${i + 1}. ` : "- ";
      return `${marker}${htmlNodeToMarkdown(li).trim()}`;
    })
    .join("\n");
}

/** Collapse the extra whitespace the block rules emit into tidy Markdown. */
function normalizeMarkdown(s: string): string {
  return s
    .replace(/[ \t]+\n/g, "\n") // strip trailing spaces (a <br> becomes a plain newline)
    .replace(/\n{3,}/g, "\n\n") // at most one blank line between blocks
    .replace(/[ \t]{2,}(?=\S)/g, " ") // collapse runs of spaces before text
    .trim();
}

export interface RandomConfig {
  operation: "uuid" | "hex" | "base64" | "alphanumeric" | "int";
  length?: number;
  min?: number;
  max?: number;
}
export interface RandomResult {
  status: "ok";
  value: string | number;
  costUsd: number;
}

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * random node — generate a fresh random value. In an activity because randomness is
 * non-deterministic (Math.random/randomBytes must never run in workflow code). No secrets.
 */
export async function callRandom(
  cfg: RandomConfig,
  meta: AgentMeta,
): Promise<RandomResult> {
  const startedAt = process.hrtime.bigint();
  try {
    const len = Math.min(1024, Math.max(1, Math.floor(cfg.length ?? 16)));
    let value: string | number;
    switch (cfg.operation) {
      case "uuid":
        value = randomUUID();
        break;
      case "hex":
        value = randomBytes(len).toString("hex");
        break;
      case "base64":
        value = randomBytes(len).toString("base64url");
        break;
      case "alphanumeric": {
        const bytes = randomBytes(len);
        let out = "";
        for (let i = 0; i < len; i++) out += ALNUM[bytes[i] % ALNUM.length];
        value = out;
        break;
      }
      case "int": {
        const min = Math.floor(cfg.min ?? 0);
        const max = Math.floor(cfg.max ?? 100);
        // randomInt's upper bound is exclusive; make [min, max] inclusive. Guard min<=max.
        value = max <= min ? min : randomInt(min, max + 1);
        break;
      }
      default:
        value = "";
    }
    activityRuns.inc({ activity: "callRandom", outcome: "ok" });
    activityDuration.observe(
      { activity: "callRandom" },
      secondsSince(startedAt),
    );
    return { status: "ok", value, costUsd: 0 };
  } catch {
    activityRuns.inc({ activity: "callRandom", outcome: "error" });
    activityDuration.observe(
      { activity: "callRandom" },
      secondsSince(startedAt),
    );
    throw ApplicationFailure.nonRetryable(
      "Random generate failed",
      "RANDOM_ERROR",
    );
  }
}

export interface EncodeConfig {
  operation:
    | "base64Encode"
    | "base64Decode"
    | "base64urlEncode"
    | "base64urlDecode"
    | "hexEncode"
    | "hexDecode"
    | "urlEncode"
    | "urlDecode";
}
export interface EncodeResult {
  status: "ok";
  result: string;
  costUsd: number;
}

/**
 * encode node — string ↔ base64 / base64url / hex / URL. In an activity because base64/hex
 * use Node's Buffer (not in the deterministic workflow bundle). Claim-checked input is
 * rehydrated first; malformed input (e.g. bad hex) is the user's data problem → non-retryable.
 */
export async function callEncode(
  cfg: EncodeConfig,
  input: unknown,
  meta: AgentMeta,
): Promise<EncodeResult> {
  const startedAt = process.hrtime.bigint();
  const store = getObjectStore();
  const s = String((await resolveClaimChecks(input, store)) ?? "");
  try {
    let result: string;
    switch (cfg.operation) {
      case "base64Encode":
        result = Buffer.from(s, "utf8").toString("base64");
        break;
      case "base64Decode":
        result = Buffer.from(s, "base64").toString("utf8");
        break;
      case "base64urlEncode":
        result = Buffer.from(s, "utf8").toString("base64url");
        break;
      case "base64urlDecode":
        result = Buffer.from(s, "base64url").toString("utf8");
        break;
      case "hexEncode":
        result = Buffer.from(s, "utf8").toString("hex");
        break;
      case "hexDecode":
        result = Buffer.from(s, "hex").toString("utf8");
        break;
      case "urlEncode":
        result = encodeURIComponent(s);
        break;
      case "urlDecode":
        result = decodeURIComponent(s);
        break;
      default:
        result = s;
    }
    activityRuns.inc({ activity: "callEncode", outcome: "ok" });
    activityDuration.observe(
      { activity: "callEncode" },
      secondsSince(startedAt),
    );
    return { status: "ok", result, costUsd: 0 };
  } catch {
    activityRuns.inc({ activity: "callEncode", outcome: "error" });
    activityDuration.observe(
      { activity: "callEncode" },
      secondsSince(startedAt),
    );
    throw ApplicationFailure.nonRetryable("Encode failed", "ENCODE_ERROR");
  }
}

export interface CsvConfig {
  operation: "parse" | "build";
  header?: boolean;
  delimiter?: string;
}
export interface CsvResult {
  status: "ok";
  result: unknown;
  costUsd: number;
}

/**
 * csv node — parse CSV text → rows, or build rows → CSV text. Pure transform (no secrets,
 * no egress), in an activity to keep the parser out of the deterministic workflow bundle
 * (like callXml). `header` (default true) uses/emits a header row. Claim-checked input is
 * rehydrated; a large result is offloaded; malformed input is the user's data problem.
 */
export async function callCsv(
  cfg: CsvConfig,
  input: unknown,
  meta: AgentMeta,
): Promise<CsvResult> {
  const startedAt = process.hrtime.bigint();
  const store = getObjectStore();
  const value = await resolveClaimChecks(input, store);
  const header = cfg.header !== false;
  const delimiter = cfg.delimiter || ",";
  try {
    let result: unknown;
    if (cfg.operation === "build") {
      const rows = Array.isArray(value) ? value : [value];
      result = { csv: Papa.unparse(rows as object[], { header, delimiter }) };
    } else {
      const parsed = Papa.parse(String(value), {
        header,
        delimiter,
        skipEmptyLines: true,
      });
      result = parsed.data;
    }
    const offloaded = await maybeOffload(result, store, {
      keyPrefix: `csv/${meta.tenantId}`,
    });
    activityRuns.inc({ activity: "callCsv", outcome: "ok" });
    activityDuration.observe({ activity: "callCsv" }, secondsSince(startedAt));
    return { status: "ok", result: offloaded, costUsd: 0 };
  } catch {
    activityRuns.inc({ activity: "callCsv", outcome: "error" });
    activityDuration.observe({ activity: "callCsv" }, secondsSince(startedAt));
    throw ApplicationFailure.nonRetryable(
      `CSV ${cfg.operation} failed`,
      "CSV_ERROR",
    );
  }
}

export async function callXml(
  cfg: XmlConfig,
  input: unknown,
  meta: AgentMeta,
): Promise<XmlResult> {
  const startedAt = process.hrtime.bigint();
  const store = getObjectStore();
  const value = await resolveClaimChecks(input, store);
  try {
    let result: unknown;
    if (cfg.operation === "build") {
      const xml = new XMLBuilder({
        ignoreAttributes: false,
        format: true,
      }).build(value);
      result = { xml };
    } else {
      result = new XMLParser({ ignoreAttributes: false }).parse(String(value));
    }
    const offloaded = await maybeOffload(result, store, {
      keyPrefix: `xml/${meta.tenantId}`,
    });
    activityRuns.inc({ activity: "callXml", outcome: "ok" });
    activityDuration.observe({ activity: "callXml" }, secondsSince(startedAt));
    return { status: "ok", result: offloaded, costUsd: 0 };
  } catch {
    activityRuns.inc({ activity: "callXml", outcome: "error" });
    activityDuration.observe({ activity: "callXml" }, secondsSince(startedAt));
    // Parser/builder errors are the user's data problem — non-retryable, no secrets.
    throw ApplicationFailure.nonRetryable(
      `XML ${cfg.operation} failed`,
      "XML_ERROR",
    );
  }
}

export interface CodeInput {
  input: unknown;
  ctx: Record<string, unknown>;
}
export interface CodeResult {
  status: "ok";
  result: unknown;
  costUsd: number;
}

const DEFAULT_CODE_TIMEOUT_MS = 2000;
const MAX_CODE_TIMEOUT_MS = 5000;
const DEFAULT_CODE_MEM_MB = 64;
const MAX_CODE_MEM_MB = 128;

// The QuickJS/WASM module is loaded once per worker process (the WASM compile is
// expensive). Memoized promise — safe under concurrent activities.
let __qjsPromise: ReturnType<typeof getQuickJS> | undefined;
function getQjs(): ReturnType<typeof getQuickJS> {
  return (__qjsPromise ??= getQuickJS());
}
// Test seam.
export const __codeDeps = { getQjs };

/** JSON for embedding as a JS literal in the guest source — escape the line
 *  separators JSON.stringify leaves raw (valid JSON, historically invalid JS). */
function jsonForSource(v: unknown): string {
  // U+2028/U+2029 are valid in JSON strings but broke JS string literals pre-ES2019;
  // escape them. Built via new RegExp so no raw line-separator sits in this file.
  return JSON.stringify(v ?? null)
    .replace(new RegExp("\\u2028", "g"), "\\u2028")
    .replace(new RegExp("\\u2029", "g"), "\\u2029");
}

/**
 * code node — run user JavaScript in a QuickJS/WASM sandbox. No host access
 * (process/require/fetch are undefined in the guest); memory + wall-clock capped;
 * the runtime is always disposed. The code runs as `(function($input,$ctx){…})(…)`
 * and its return value becomes the node output. User-code failures are
 * non-retryable (the user must fix the code) — CODE_TIMEOUT for a deadline/OOM
 * interrupt, CODE_ERROR otherwise; only the guest error message is surfaced.
 */
export async function callCode(
  cfg: CodeNodeConfig,
  input: CodeInput,
  meta: AgentMeta,
): Promise<CodeResult> {
  const startedAt = process.hrtime.bigint();
  const store = getObjectStore();
  // Rehydrate any claim-checked upstream value BEFORE the sandbox sees it.
  const rehydrated = (await resolveClaimChecks(input, store)) as CodeInput;
  const QuickJS = await __codeDeps.getQjs();
  const runtime = QuickJS.newRuntime();
  const timeoutMs = Math.min(
    cfg.timeoutMs ?? DEFAULT_CODE_TIMEOUT_MS,
    MAX_CODE_TIMEOUT_MS,
  );
  const deadline = Date.now() + timeoutMs;
  try {
    runtime.setMemoryLimit(
      Math.min(cfg.memoryMb ?? DEFAULT_CODE_MEM_MB, MAX_CODE_MEM_MB) *
        1024 *
        1024,
    );
    runtime.setMaxStackSize(1024 * 1024);
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadline));
    const context = runtime.newContext();
    try {
      const src = `(function($input,$ctx){\n${cfg.code}\n})(${jsonForSource(
        rehydrated.input,
      )},${jsonForSource(rehydrated.ctx)})`;
      const res = context.evalCode(src);
      if (res.error) {
        const dumped = context.dump(res.error) as { message?: string } | string;
        res.error.dispose();
        const message =
          (typeof dumped === "object" ? dumped.message : String(dumped)) ||
          "code error";
        // A deadline/OOM interrupt vs a genuine user error.
        const interrupted = Date.now() >= deadline;
        activityRuns.inc({ activity: "callCode", outcome: "error" });
        activityDuration.observe(
          { activity: "callCode" },
          secondsSince(startedAt),
        );
        throw ApplicationFailure.nonRetryable(
          interrupted
            ? `Code timed out or exceeded memory after ${timeoutMs}ms`
            : `Code error: ${message.slice(0, 300)}`,
          interrupted ? "CODE_TIMEOUT" : "CODE_ERROR",
        );
      }
      const result = context.dump(res.value);
      res.value.dispose();
      // Offload a large return value so it can't blow the Temporal payload cap.
      const offloaded = await maybeOffload(result, store, {
        keyPrefix: `code/${meta.tenantId}`,
      });
      activityRuns.inc({ activity: "callCode", outcome: "ok" });
      activityDuration.observe(
        { activity: "callCode" },
        secondsSince(startedAt),
      );
      return { status: "ok", result: offloaded, costUsd: 0 };
    } finally {
      context.dispose();
    }
  } catch (e) {
    if (e instanceof ApplicationFailure) throw e;
    // Host-side failure (module load, marshalling) — sanitized, non-retryable.
    activityRuns.inc({ activity: "callCode", outcome: "error" });
    activityDuration.observe({ activity: "callCode" }, secondsSince(startedAt));
    throw ApplicationFailure.nonRetryable(
      "Code execution failed to run",
      "CODE_ERROR",
    );
  } finally {
    runtime.dispose();
  }
}

export interface AgentOutput {
  category: string;
  urgency: number;
}

export interface AgentResult {
  status: "ok";
  /** The structured output; shape depends on the node's outputSchema (QA#9). */
  output: Record<string, unknown>;
  /** The model that actually ran (may differ from cfg.model after a downgrade). */
  model: string;
  /** Cost of THIS call — the workflow accumulates these deterministically. */
  costUsd: number;
}

// Slice #2 ships one structured-output schema. It can't ride in JSON graph
// config, so it lives here; per-node schema routing is a later slice. Using the
// AI SDK's jsonSchema<T> (vs zod) gives an explicit output type and avoids a
// TS2589 deep-instantiation blow-up in generateText's generics.
const DEFAULT_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    category: { type: "string" },
    urgency: { type: "number" },
  },
  required: ["category", "urgency"],
  additionalProperties: false,
} as const;
// Typed as Record<string, unknown> (not AgentOutput) so it unifies with the
// per-node schema branch below — `Output.object` needs one schema type, and the
// result is returned as Record<string, unknown> anyway. The `as const` literal is
// widened to the mutable JSONSchema7 the SDK expects (runtime schema unchanged).
const defaultOutputSchema = jsonSchema<Record<string, unknown>>(
  // `as const` (needed for the literal `type`/`additionalProperties` fields) makes
  // this readonly; widen to the mutable JSONSchema7 the SDK wants via unknown.
  DEFAULT_OUTPUT_SCHEMA as unknown as Parameters<typeof jsonSchema>[0],
);

// Constructed lazily so importing this module doesn't require ENCRYPTION_KEY
// until an agent actually runs.
let credentials: CredentialsService | undefined;
function getCredentials(): CredentialsService {
  credentials ??= new CredentialsService();
  return credentials;
}

function buildModel(provider: string, model: string, apiKey: string) {
  if (provider === "anthropic") {
    return createAnthropic({ apiKey })(model);
  }
  if (provider === "openai") {
    return createOpenAI({ apiKey })(model);
  }
  if (provider === "google") {
    return createGoogleGenerativeAI({ apiKey })(model);
  }
  throw ApplicationFailure.nonRetryable(
    `Unsupported provider: ${provider}`,
    "UNSUPPORTED_PROVIDER",
  );
}

/**
 * Test seam: the credential source and usage sink, swappable in unit tests so
 * the activity's orchestration (in-activity key fetch, billing fallback, error
 * mapping) can be exercised without a live DB or LLM. Cost-from-tokens
 * correctness is covered by @naary/usage's own tests.
 */
export const __agentDeps = {
  getCredentials,
  recordUsage,
  getBudget,
  monthToDateSpend,
  reserveBudget,
  releaseReservation,
};

/** Crude char/4 token estimate — only used when the provider omits usage. */
function estimateTokens(
  systemPrompt: string,
  input: unknown,
  outputText: string,
) {
  const inputChars = systemPrompt.length + JSON.stringify(input).length;
  return {
    inputTokens: Math.max(1, Math.ceil(inputChars / 4)),
    outputTokens: Math.max(1, Math.ceil(outputText.length / 4)),
  };
}

/**
 * The real agent node. Fetches the tenant's key INSIDE the activity (never as a
 * workflow arg / return), calls the model with structured output, records spend,
 * and maps auth/quota failures to non-retryable so Temporal doesn't burn retries
 * on a key the user must fix.
 */
export async function runAgent(
  cfg: AgentConfig,
  input: unknown,
  meta: AgentMeta,
): Promise<AgentResult> {
  const startedAt = process.hrtime.bigint();
  // Released in `finally` (Arch§4.3) — whether the call succeeds or throws — so a
  // failed/retried activity never leaves a dangling reservation.
  let reservationId: string | undefined;
  try {
    // Defaults for graphs whose agent node didn't persist provider/model (e.g. the
    // canvas inspector showed the default but the user never changed the dropdown).
    // anthropic is the only supported provider today; opus is a safe default model.
    const provider = cfg.provider?.trim() || "anthropic";

    // In memory only — never returned from the activity, never logged.
    const apiKey = await __agentDeps
      .getCredentials()
      .getDecryptedKey(meta.tenantId, provider);

    // Pre-flight budget enforcement via an atomic RESERVATION (Arch§4.3): reserve
    // this call's estimated cost against the monthly cap BEFORE the LLM call, so
    // concurrent runs for one tenant can't all overshoot. The reservation counts
    // committed spend + other in-flight reservations. No budget set ⇒ no cap.
    let model = cfg.model?.trim() || "claude-opus-4-8";
    // Per-node output cap (sizes both the budget estimate and the actual call) and
    // optional sampling temperature.
    const maxOutputTokens = cfg.maxOutputTokens ?? MAX_OUTPUT_TOKENS;
    const budget = await __agentDeps.getBudget(meta.tenantId);
    if (budget) {
      const estimateFor = (m: string) =>
        estimateCallCost(
          {
            provider,
            model: m,
            systemPrompt: cfg.systemPrompt,
            maxOutputTokens,
          },
          input,
        );
      let res = await __agentDeps.reserveBudget(
        meta.tenantId,
        estimateFor(model),
        budget.monthlyCapUsd,
      );
      if (!res.ok) {
        if (budget.onBudgetExceeded === "downgrade" && budget.fallbackModel) {
          // Re-validate the cheaper model (QA#6): it must be priced AND its own
          // reservation must fit the cap — else reject.
          let fallbackEstimate: number;
          try {
            fallbackEstimate = estimateFor(budget.fallbackModel);
          } catch {
            throw ApplicationFailure.nonRetryable(
              "Configured fallback model has no pricing",
              "FALLBACK_UNPRICED",
              { tenantId: meta.tenantId },
            );
          }
          res = await __agentDeps.reserveBudget(
            meta.tenantId,
            fallbackEstimate,
            budget.monthlyCapUsd,
          );
          if (!res.ok) {
            throw ApplicationFailure.nonRetryable(
              "Monthly budget exceeded (even after downgrade)",
              "BUDGET",
              { tenantId: meta.tenantId },
            );
          }
          model = budget.fallbackModel;
        } else {
          throw ApplicationFailure.nonRetryable(
            "Monthly budget exceeded",
            "BUDGET",
            { tenantId: meta.tenantId },
          );
        }
      }
      reservationId = res.id;
    }

    // Opt-in Anthropic prompt caching (default off): mark the STABLE system prompt as an
    // ephemeral cache breakpoint so repeated calls reuse it within Anthropic's ~5-min TTL.
    // Anthropic-only (cacheControl is its provider option) and needs the `messages` form to
    // carry providerOptions; a short prompt is a no-op below Anthropic's min cacheable size,
    // and billing already meters cache-read tokens separately (see the usage read below).
    const cachePrompt =
      cfg.cacheSystemPrompt === true &&
      provider === "anthropic" &&
      !!cfg.systemPrompt;

    const result = await generateText({
      model: buildModel(provider, model, apiKey),
      ...(cachePrompt
        ? {
            messages: [
              {
                role: "system" as const,
                content: cfg.systemPrompt as string,
                providerOptions: {
                  anthropic: { cacheControl: { type: "ephemeral" } },
                },
              },
              { role: "user" as const, content: JSON.stringify(input) },
            ],
          }
        : { system: cfg.systemPrompt, prompt: JSON.stringify(input) }),
      output: Output.object({
        // Per-node schema when configured (QA#9), else the default shape.
        schema: cfg.outputSchema
          ? jsonSchema<Record<string, unknown>>(
              cfg.outputSchema as Parameters<typeof jsonSchema>[0],
            )
          : defaultOutputSchema,
      }),
      maxOutputTokens,
      ...(cfg.temperature !== undefined
        ? { temperature: cfg.temperature }
        : {}),
    });

    // BILLING (CLAUDE.md rule 6): totalUsage sums across tool steps; guard the
    // ai@6 undefined-usage bug so we never silently record a free call.
    // NOTE (QA#2): for Anthropic, `inputTokens` EXCLUDES cache-read tokens (those
    // arrive separately as cache-read tokens), so input and cached are independent
    // billing buckets — computeCost must not subtract one from the other.
    // ai@7 moved the cache/reasoning counts into inputTokenDetails/outputTokenDetails.
    const u = result.totalUsage ?? result.usage;
    const real = {
      inputTokens: u?.inputTokens ?? 0,
      outputTokens: u?.outputTokens ?? 0,
      totalTokens: u?.totalTokens,
      cachedInputTokens: u?.inputTokenDetails?.cacheReadTokens,
      reasoningTokens: u?.outputTokenDetails?.reasoningTokens,
    };
    const usage =
      real.inputTokens || real.outputTokens
        ? real
        : estimateTokens(
            cfg.systemPrompt,
            input,
            // output text may be empty under structured output — fall back to the object
            result.text || JSON.stringify(result.output ?? ""),
          );

    await __agentDeps.recordUsage({
      tenantId: meta.tenantId,
      executionId: meta.executionId,
      nodeId: meta.nodeId,
      provider,
      model, // the model that actually ran (post-downgrade)
      usage,
    });

    // Same cost recordUsage computed — returned so the workflow can accumulate
    // it deterministically (no DB read in workflow code).
    const costUsd = computeCost({
      provider,
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedInputTokens: (usage as { cachedInputTokens?: number })
        .cachedInputTokens,
    });

    log.info(
      {
        activity: "runAgent",
        executionId: meta.executionId,
        nodeId: meta.nodeId,
        tenantId: meta.tenantId,
        provider,
        model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costUsd,
      },
      "agent node completed",
    );

    activityRuns.inc({ activity: "runAgent", outcome: "ok" });
    activityDuration.observe({ activity: "runAgent" }, secondsSince(startedAt));
    agentTokens.inc({ kind: "input" }, usage.inputTokens);
    agentTokens.inc({ kind: "output" }, usage.outputTokens);
    if (costUsd > 0) runCostUsd.inc(costUsd);

    return {
      status: "ok",
      output: result.output as Record<string, unknown>,
      model,
      costUsd,
    };
  } catch (e) {
    activityRuns.inc({ activity: "runAgent", outcome: "error" });
    activityDuration.observe({ activity: "runAgent" }, secondsSince(startedAt));
    // Our own deliberate failures (BUDGET, UNSUPPORTED_PROVIDER, …) are already
    // safe + correctly (non-)retryable — pass them through untouched.
    if (e instanceof ApplicationFailure) throw e;
    if (e instanceof MissingCredentialError) {
      throw ApplicationFailure.nonRetryable(
        "Missing or invalid provider credential",
        "AUTH",
        { tenantId: meta.tenantId },
      );
    }
    if (APICallError.isInstance(e)) {
      if (e.statusCode === 401 || e.statusCode === 403) {
        throw ApplicationFailure.nonRetryable(
          "Invalid provider credentials",
          "AUTH",
          { tenantId: meta.tenantId },
        );
      }
      if (e.statusCode === 429) {
        throw ApplicationFailure.nonRetryable(
          "Provider rate limit / quota (tenant key)",
          "QUOTA",
        );
      }
    }
    // Genuine transient error: rethrow a SANITIZED retryable failure (the raw
    // AI-SDK error can carry the key in request headers) so Temporal retries
    // without that material ever reaching durable history/logs.
    throw toSanitizedRetryable(e, "AGENT_TRANSIENT");
  } finally {
    // Reconcile: the actual cost is now a UsageEvent (on success) or the call
    // failed — either way the estimate reservation is no longer needed. Best-
    // effort; a missed release is reaped by the reservation TTL.
    if (reservationId !== undefined) {
      await __agentDeps
        .releaseReservation(reservationId)
        .catch(() => undefined);
    }
  }
}

export interface McpToolConfig {
  connectionId: string;
  tool: string;
  /** Tool arguments, already resolved from upstream outputs by the interpreter. */
  arguments?: Record<string, unknown>;
  /** Flat per-call cost (Arch§4.6) — MCP tools have no token cost, so spend is
   *  operator-configured. Returned + accumulated so tool spend hits the budget. */
  costUsd?: number;
}

export interface McpToolResult {
  status: "ok";
  content: unknown;
  /** Metered cost of this tool call — the workflow accumulates it (Arch§4.6). */
  costUsd: number;
}

/** Test seam: connection→target resolution + the MCP call, swappable in tests. */
export const __mcpDeps = {
  resolveMcpTarget,
  callMcpTool: mcpCall,
};

/**
 * MCP Tool node: resolve the connection's server URL + auth header IN-ACTIVITY
 * (token never crosses the workflow boundary), call the remote tool, return its
 * content. Missing-token / needs-reauth map to non-retryable (the user must fix
 * the connection); transient errors retry.
 */
export async function callMcpTool(
  cfg: McpToolConfig,
  input: unknown,
  meta: AgentMeta,
): Promise<McpToolResult> {
  const startedAt = process.hrtime.bigint();
  try {
    const store = getObjectStore();
    const target = await __mcpDeps.resolveMcpTarget(
      meta.tenantId,
      cfg.connectionId,
    );
    // Resolve any claim-checked upstream args back to their real values before the
    // call (Arch§4.6) — the workflow only ever carried the small reference.
    const args = (await resolveClaimChecks(
      cfg.arguments ?? (input as Record<string, unknown>) ?? {},
      store,
    )) as Record<string, unknown>;
    const result = await __mcpDeps.callMcpTool({
      serverUrl: target.serverUrl,
      headers: target.headers,
      tool: cfg.tool,
      arguments: args,
    });
    // A tool-level error (isError) is NOT success — surface it instead of
    // letting the workflow proceed as if the call worked. Non-retryable: the
    // same arguments usually fail the same way, so don't burn Temporal retries.
    if (result.isError) {
      throw ApplicationFailure.nonRetryable(
        `MCP tool '${cfg.tool}' returned an error`,
        "MCP_TOOL_ERROR",
        { connectionId: cfg.connectionId, content: result.content },
      );
    }
    // Offload a large result to object storage and return a small reference, so it
    // can't blow Temporal's ~2MB payload cap (Arch§4.6). Small results stay inline.
    const content = await maybeOffload(result.content, store, {
      keyPrefix: `mcp/${meta.tenantId}`,
    });
    log.info(
      {
        activity: "callMcpTool",
        executionId: meta.executionId,
        nodeId: meta.nodeId,
        tenantId: meta.tenantId,
        tool: cfg.tool,
        connectionId: cfg.connectionId,
        costUsd: cfg.costUsd ?? 0,
      },
      "mcp tool completed",
    );
    activityRuns.inc({ activity: "callMcpTool", outcome: "ok" });
    activityDuration.observe(
      { activity: "callMcpTool" },
      secondsSince(startedAt),
    );
    if ((cfg.costUsd ?? 0) > 0) runCostUsd.inc(cfg.costUsd ?? 0);
    return { status: "ok", content, costUsd: cfg.costUsd ?? 0 };
  } catch (e) {
    activityRuns.inc({ activity: "callMcpTool", outcome: "error" });
    activityDuration.observe(
      { activity: "callMcpTool" },
      secondsSince(startedAt),
    );
    // Our own deliberate failures (e.g. MCP_TOOL_ERROR) are already safe + correctly
    // non-retryable — pass them through untouched.
    if (e instanceof ApplicationFailure) throw e;
    // A blocked egress target is a misconfiguration (SSRF guard) — retrying the
    // same URL won't help, so fail non-retryable.
    if (e instanceof BlockedEgressError) {
      throw ApplicationFailure.nonRetryable(
        "Connection target is not allowed",
        "BLOCKED_EGRESS",
        { connectionId: cfg.connectionId },
      );
    }
    if (e instanceof AuthConfigError) {
      // Platform misconfig (e.g. GitHub App env unset) — retrying can't fix it.
      throw ApplicationFailure.nonRetryable(e.message, "AUTH_NOT_CONFIGURED");
    }
    if (
      e instanceof MissingConnectionTokenError ||
      e instanceof NeedsReauthError
    ) {
      throw ApplicationFailure.nonRetryable(
        "Connection needs re-authorization",
        "CONNECTION_REAUTH",
        { connectionId: cfg.connectionId },
      );
    }
    // Transient: sanitized retryable (an MCP transport error can carry the
    // connection's bearer token in its request fields).
    throw toSanitizedRetryable(e, "MCP_TRANSIENT");
  }
}

const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
/** Hard cap on the per-request deadline. MUST stay below the callHttpRequest
 *  proxy's startToCloseTimeout (150s) so the AbortController — not Temporal — is
 *  the real deadline; otherwise a slow request would be killed + RETRIED (Temporal),
 *  duplicating non-idempotent writes. */
const MAX_HTTP_TIMEOUT_MS = 120_000;

/** A resolved HTTP request (bindings already applied by the interpreter). Mirrors
 *  @naary/dsl's ResolvedHttpRequest — kept independent so workflow↔activity stays
 *  type-only. NO secrets: the auth header is attached here, from `connectionId`. */
export interface HttpRequestConfig {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  connectionId?: string;
  failOnErrorStatus?: boolean;
  timeoutMs?: number;
  costUsd?: number;
  /** Auto-follow pages (mirrors @naary/dsl's HttpPaginationConfig); the loop runs
   *  entirely in this activity so the workflow stays deterministic. */
  pagination?: {
    mode: "cursor" | "page" | "url";
    itemsPath?: string;
    cursorPath?: string;
    cursorParam?: string;
    pageParam?: string;
    startPage?: number;
    nextUrlPath?: string;
    stopOnEmpty?: boolean;
    maxPages?: number;
  };
}

export interface HttpRequestResult {
  status: "ok";
  /** HTTP response status code — the graph branches on this (e.g. status gt 399).
   *  When paginating, the status of the LAST page fetched. */
  httpStatus: number;
  headers: Record<string, string>;
  body: unknown;
  /** Metered cost of this call — the workflow accumulates it (Arch§4.6). */
  costUsd: number;
  /** Pages fetched when paginating (absent for a single request). */
  pages?: number;
}

/** Test seam: the network call + connection/egress resolution, swappable in tests. */
export const __httpDeps = {
  // SSRF-hardened (see safeFetch): validates every redirect hop at connect time and
  // pins the checked IP, so a public URL can't redirect/rebind into internal hosts.
  fetch: (url: string | URL, init?: RequestInit): Promise<Response> =>
    safeFetch(String(url), init as never) as unknown as Promise<Response>,
  resolveAuthHeader,
  assertEgressAllowed,
  // The connection's site URL (base for connection-based providers like Jira) + its authMode
  // (so a "basic"-scheme provider keeps Bearer for OAuth and only Basic-wraps a token).
  getConnection: async (
    tenantId: string,
    connectionId: string,
  ): Promise<{ serverUrl: string; authMode: string } | null> => {
    const conn = await new ConnectionService().getById(tenantId, connectionId);
    return conn ? { serverUrl: conn.serverUrl, authMode: conn.authMode } : null;
  },
};

/**
 * HTTP Request node: call a plain HTTP/REST endpoint and return the structured
 * response so the graph can branch on `.httpStatus`. Auth (if any) is resolved
 * from `connectionId` IN-ACTIVITY — the token never crosses the workflow boundary.
 *
 * Behavior contract: a non-2xx response is NOT an error by default — it's returned
 * for the graph to branch on. Only transport/DNS/timeout failures throw (retryable);
 * a blocked egress target (SSRF guard) throws non-retryable. `failOnErrorStatus`
 * opts a flow into a hard non-retryable fail on status ≥ 400.
 */
export async function callHttpRequest(
  cfg: HttpRequestConfig,
  input: unknown,
  meta: AgentMeta,
): Promise<HttpRequestResult> {
  void input; // entry-node input flows via bindings, not directly into the request
  const startedAt = process.hrtime.bigint();
  let host = "unknown";
  try {
    const store = getObjectStore();

    // Auth comes ONLY from the connection, resolved in-memory here (never in config,
    // never in workflow history). Static config headers are non-secret; the auth
    // header takes precedence over any same-named static header.
    const authHeaders = cfg.connectionId
      ? await __httpDeps.resolveAuthHeader(meta.tenantId, cfg.connectionId)
      : {};
    const headers: Record<string, string> = {
      ...(cfg.headers ?? {}),
      ...authHeaders,
    };

    // A claim-checked upstream value (e.g. a large bound body) is resolved back to
    // its real value before the call — the workflow only carried the small reference.
    const resolvedBody = await resolveClaimChecks(cfg.body, store);

    const init: RequestInit = { method: cfg.method, headers };
    if (cfg.method !== "GET" && resolvedBody !== undefined) {
      if (typeof resolvedBody === "string") {
        init.body = resolvedBody;
      } else {
        init.body = JSON.stringify(resolvedBody);
        if (!("content-type" in mapKeysLower(headers))) {
          headers["Content-Type"] = "application/json";
        }
      }
    }

    // The connection-derived auth header must NEVER ride to a different host. A
    // paginated `url`-mode `next` URL comes from the (untrusted) response body, so a
    // cross-origin next page gets the static, non-secret headers only — mirroring how
    // browsers/curl drop `Authorization` across origins (Tier-1 rule 4).
    const authKeys = new Set(
      Object.keys(authHeaders).map((k) => k.toLowerCase()),
    );
    const headersNoAuth: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (!authKeys.has(k.toLowerCase())) headersNoAuth[k] = v;
    }
    const originOf = (u: string): string | null => {
      try {
        return new URL(u).origin;
      } catch {
        return null;
      }
    };
    const baseOrigin = originOf(cfg.url);

    const timeoutMs = Math.min(
      cfg.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS,
      MAX_HTTP_TIMEOUT_MS,
    );

    // One page fetch. The egress guard runs on EVERY page URL — a response-supplied
    // `next` URL (url mode) is attacker-influenceable, so pagination can never escape
    // the https-and-public-host SSRF check. Bound each request with the deadline too.
    const fetchPage = async (
      reqUrl: string,
      reqQuery: Record<string, string>,
      useHeaders: Record<string, string> = headers,
    ): Promise<{
      res: Response;
      body: unknown;
      responseHeaders: Record<string, string>;
    }> => {
      let rawUrl = reqUrl;
      const qs = new URLSearchParams(reqQuery).toString();
      if (qs) rawUrl += (rawUrl.includes("?") ? "&" : "?") + qs;
      const url = await __httpDeps.assertEgressAllowed(rawUrl);
      host = url.host;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res: Response;
      try {
        res = await __httpDeps.fetch(url, {
          ...init,
          headers: useHeaders,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      const contentType = res.headers.get("content-type") ?? "";
      const raw = await res.text();
      let body: unknown = raw;
      if (contentType.includes("json")) {
        try {
          body = raw.length > 0 ? JSON.parse(raw) : null;
        } catch {
          body = raw; // malformed JSON — hand back the text rather than failing
        }
      }
      // Drop response-side credentials (Set-Cookie) before the headers land in ctx →
      // Temporal history. The rest (content-type, etc.) is useful for branching.
      const responseHeaders: Record<string, string> = {};
      for (const [k, v] of res.headers.entries()) {
        if (k.toLowerCase() === "set-cookie") continue;
        responseHeaders[k] = v;
      }
      return { res, body, responseHeaders };
    };

    // `failOnErrorStatus` opts a flow into a hard non-retryable fail on status ≥ 400.
    const checkStatus = (status: number): void => {
      if (cfg.failOnErrorStatus && status >= 400) {
        throw ApplicationFailure.nonRetryable(
          `HTTP request returned status ${status}`,
          "HTTP_ERROR_STATUS",
          { httpStatus: status },
        );
      }
    };

    const finish = (
      httpStatus: number,
      responseHeaders: Record<string, string>,
      body: unknown,
      cost: number,
      pages?: number,
    ): HttpRequestResult => {
      log.info(
        {
          activity: "callHttpRequest",
          executionId: meta.executionId,
          nodeId: meta.nodeId,
          tenantId: meta.tenantId,
          method: cfg.method,
          host,
          httpStatus,
          costUsd: cost,
          ...(pages !== undefined ? { pages } : {}),
        },
        "http request completed",
      );
      activityRuns.inc({ activity: "callHttpRequest", outcome: "ok" });
      activityDuration.observe(
        { activity: "callHttpRequest" },
        secondsSince(startedAt),
      );
      if (cost > 0) runCostUsd.inc(cost);
      return {
        status: "ok",
        httpStatus,
        headers: responseHeaders,
        body,
        costUsd: cost,
        ...(pages !== undefined ? { pages } : {}),
      };
    };

    const pg = cfg.pagination;
    if (!pg) {
      const { res, body, responseHeaders } = await fetchPage(
        cfg.url,
        cfg.query ?? {},
      );
      checkStatus(res.status);
      // Offload a large body so it can't blow Temporal's ~2MB payload cap (Arch§4.6).
      const offloaded = await maybeOffload(body, store, {
        keyPrefix: `http/${meta.tenantId}`,
      });
      return finish(res.status, responseHeaders, offloaded, cfg.costUsd ?? 0);
    }

    // --- Paginated: fetch pages until a stop condition; `body` is the accumulated
    // items array. The whole loop is in this activity, so the workflow is unaffected. ---
    const maxPages = Math.min(Math.max(pg.maxPages ?? 10, 1), 100);
    const stopOnEmpty = pg.stopOnEmpty ?? true;
    const items: unknown[] = [];
    let cursor: unknown;
    let nextUrl: string | undefined;
    let page = pg.startPage ?? 1;
    let lastStatus = 0;
    let lastHeaders: Record<string, string> = {};
    let pages = 0;

    while (pages < maxPages) {
      let reqUrl: string;
      let reqQuery: Record<string, string>;
      // Same-origin pages carry the auth header; a cross-origin `url`-mode next page
      // gets the non-secret headers only (never leak the connection token off-host).
      let reqHeaders = headers;
      if (pg.mode === "url" && pages > 0) {
        // A response-supplied next URL is already complete — don't re-append query.
        reqUrl = nextUrl as string;
        reqQuery = {};
        if (baseOrigin === null || originOf(reqUrl) !== baseOrigin)
          reqHeaders = headersNoAuth;
      } else {
        reqUrl = cfg.url;
        reqQuery = { ...(cfg.query ?? {}) };
        if (pg.mode === "page") reqQuery[pg.pageParam ?? "page"] = String(page);
        if (pg.mode === "cursor" && cursor != null)
          reqQuery[pg.cursorParam ?? "cursor"] = String(cursor);
      }

      const { res, body, responseHeaders } = await fetchPage(
        reqUrl,
        reqQuery,
        reqHeaders,
      );
      pages++; // count every fetch performed (drives the page count + per-page cost)
      checkStatus(res.status);
      lastStatus = res.status;
      lastHeaders = responseHeaders;

      const raw = pg.itemsPath ? getByPath(body, pg.itemsPath) : body;
      const pageItems = Array.isArray(raw) ? raw : [];
      // Append without spreading (a huge page would overflow the arg stack).
      for (const it of pageItems) items.push(it);
      if (stopOnEmpty && pageItems.length === 0) break;

      if (pg.mode === "cursor") {
        const c = pg.cursorPath ? getByPath(body, pg.cursorPath) : undefined;
        if (c == null || c === "") break;
        cursor = c;
      } else if (pg.mode === "url") {
        const nu = pg.nextUrlPath ? getByPath(body, pg.nextUrlPath) : undefined;
        if (nu == null || nu === "") break;
        nextUrl = String(nu);
      } else {
        page++;
      }
    }

    const offloaded = await maybeOffload(items, store, {
      keyPrefix: `http/${meta.tenantId}`,
    });
    // Each page is a real HTTP call → meter the flat cost per page.
    return finish(
      lastStatus,
      lastHeaders,
      offloaded,
      (cfg.costUsd ?? 0) * pages,
      pages,
    );
  } catch (e) {
    activityRuns.inc({ activity: "callHttpRequest", outcome: "error" });
    activityDuration.observe(
      { activity: "callHttpRequest" },
      secondsSince(startedAt),
    );
    // Our own deliberate failures (HTTP_ERROR_STATUS) are already safe — pass through.
    if (e instanceof ApplicationFailure) throw e;
    // A blocked egress target is a misconfiguration (SSRF guard) — retrying the same
    // URL won't help, so fail non-retryable (mirrors the mcpTool handling).
    if (e instanceof BlockedEgressError) {
      throw ApplicationFailure.nonRetryable(
        "Request target is not allowed",
        "BLOCKED_EGRESS",
        { host },
      );
    }
    if (e instanceof AuthConfigError) {
      throw ApplicationFailure.nonRetryable(e.message, "AUTH_NOT_CONFIGURED");
    }
    if (
      e instanceof MissingConnectionTokenError ||
      e instanceof NeedsReauthError
    ) {
      throw ApplicationFailure.nonRetryable(
        "Connection needs re-authorization",
        "CONNECTION_REAUTH",
        { connectionId: cfg.connectionId },
      );
    }
    // Transient (network blip, DNS, abort/timeout): sanitized retryable so a request
    // object carrying the auth header can't be serialized into history.
    throw toSanitizedRetryable(e, "HTTP_TRANSIENT");
  }
}

/** Structured result of an integration action — mirrors HttpRequestResult's branchable shape. */
export interface IntegrationResult {
  status: "ok";
  httpStatus: number;
  ok: boolean;
  body: unknown;
}

/**
 * Native integration node (design docs/design/INTEGRATION-NODES.md): a curated,
 * connection-authed REST call. The catalog (in @naary/dsl) maps { provider, action } →
 * method + path + body; this activity resolves auth IN-ACTIVITY (never in config/history),
 * runs the SSRF egress guard, and returns the structured response so the graph can branch
 * on `<id>.status`. A non-2xx is RETURNED (not thrown), like httpRequest. `fields` are the
 * interpreter-resolved field values (static + bindings) — no ctx, no secrets, cross this boundary.
 *
 * WRITE actions are proxied AT-MOST-ONCE by the interpreter (no retry) — a lost response
 * must not duplicate a create/comment (design §4).
 */
export async function callIntegration(
  cfg: IntegrationNodeConfig,
  fields: Record<string, unknown>,
  meta: AgentMeta,
): Promise<IntegrationResult> {
  const startedAt = process.hrtime.bigint();
  // Full catalog-aware validation (unknown provider/action, missing required/path field) →
  // non-retryable, so a misconfigured node fails clearly rather than firing a bad request.
  const invalid = validateIntegrationConfig(cfg);
  if (invalid) {
    throw ApplicationFailure.nonRetryable(
      invalid,
      "INTEGRATION_INVALID_CONFIG",
    );
  }
  const provider = getIntegrationProvider(cfg.provider)!;

  // Fetch the connection once if we need its site URL (Jira base) or its authMode (to decide
  // Basic-vs-Bearer for a "basic"-scheme provider). GitHub needs neither.
  const needsConnection =
    provider.baseUrlFromConnection || provider.authScheme === "basic";
  const conn = needsConnection
    ? await __httpDeps.getConnection(meta.tenantId, cfg.connectionId)
    : null;

  // Base URL: static (GitHub) or the connection's site (Jira). A connection-based provider
  // with no serverUrl is a config error, not a retry.
  let base = provider.baseUrl ?? null;
  if (provider.baseUrlFromConnection) {
    base = conn?.serverUrl ?? null;
    if (!base) {
      throw ApplicationFailure.nonRetryable(
        `integration '${cfg.provider}': connection '${cfg.connectionId}' has no server URL`,
        "INTEGRATION_NO_BASE_URL",
      );
    }
  }
  const req = buildIntegrationRequest(cfg.provider, cfg.action, fields);
  const url = `${base!.replace(/\/$/, "")}${req.path}`;
  const action = getIntegrationAction(cfg.provider, cfg.action);
  // req.path is "path + query string" — log the PATH ONLY so query-param values can't leak
  // into logs (and to keep cardinality low). The template placeholders are non-secret ids.
  const loggedPath = req.path.split("?")[0];

  try {
    // Auth resolved in-memory here (Tier-1 rule 4) — never in config, never in history.
    const authHeaders = await __httpDeps.resolveAuthHeader(
      meta.tenantId,
      cfg.connectionId,
    );
    // A "basic"-scheme provider (Jira Cloud) with an API TOKEN uses HTTP Basic
    // (`base64(email:token)`): the connection stores `email:token`, resolveAuthHeader hands it
    // back as `Bearer email:token`, and we re-wrap it. But an OAuth connection's access token IS
    // a Bearer — pass it through unchanged (so Jira-over-OAuth keeps working).
    if (
      provider.authScheme === "basic" &&
      conn?.authMode !== "oauth" &&
      authHeaders.Authorization
    ) {
      const raw = authHeaders.Authorization.replace(/^Bearer\s+/i, "");
      authHeaders.Authorization = `Basic ${Buffer.from(raw).toString("base64")}`;
    }
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(provider.headers ?? {}),
      // Per-action header overrides (e.g. GitHub's diff media type) win over the provider
      // defaults but never over auth (auth is spread last so it can't be clobbered).
      ...(action?.headers ?? {}),
      ...authHeaders,
    };
    const init: RequestInit = { method: req.method, headers };
    if (req.method !== "GET" && req.body !== undefined) {
      init.body = JSON.stringify(req.body);
      headers["Content-Type"] = "application/json";
    }

    const checked = await __httpDeps.assertEgressAllowed(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_HTTP_TIMEOUT_MS);
    let res: Response;
    try {
      res = await __httpDeps.fetch(checked, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const contentType = res.headers.get("content-type") ?? "";
    const raw = await res.text();
    let body: unknown = raw;
    if (contentType.includes("json")) {
      try {
        body = raw.length > 0 ? JSON.parse(raw) : null;
      } catch {
        body = raw; // malformed JSON — hand back the text rather than failing
      }
    }

    // A side-effecting WRITE action that comes back non-2xx FAILS the node loudly — a POST
    // that didn't happen must not read as success by handing back the error body as "output"
    // (which silently buries e.g. a 404). READ actions still RETURN the status so a graph can
    // branch on it (a 404 "not found" is a meaningful read result). Writes are at-most-once, so
    // a clean non-retryable failure can't double-post. The message carries the resolved path
    // (owner/repo/number — no secrets; auth lives in headers) so the cause is diagnosable, plus
    // a GitHub-specific hint: GitHub returns 404/403 when a token can't see a PRIVATE repo — the
    // most common cause of a "correct endpoint but 404" write.
    if (action?.write && !res.ok) {
      const detail =
        body && typeof body === "object" && "message" in body
          ? String((body as { message: unknown }).message)
          : typeof body === "string" && body.length > 0
            ? body.slice(0, 200)
            : res.statusText;
      const hint =
        cfg.provider === "github" && (res.status === 404 || res.status === 403)
          ? " — GitHub returns 404/403 when the connection's token lacks access to a (private) repo; check the token has repo / issues:write scope on this repository, or verify the resolved owner/repo/number."
          : "";
      throw ApplicationFailure.nonRetryable(
        `integration '${cfg.provider}.${cfg.action}' failed: ${res.status} ${detail} [${req.method} ${req.path}]${hint}`,
        "INTEGRATION_WRITE_FAILED",
        { httpStatus: res.status },
      );
    }
    // Offload a large response so it can't blow Temporal's ~2MB payload cap (like httpRequest);
    // the interpreter resolves the claim-check back before a downstream node reads it.
    body = await maybeOffload(body, getObjectStore(), {
      keyPrefix: `integration/${meta.tenantId}`,
    });
    log.info(
      {
        activity: "callIntegration",
        executionId: meta.executionId,
        nodeId: meta.nodeId,
        tenantId: meta.tenantId,
        provider: cfg.provider,
        action: cfg.action,
        method: req.method,
        path: loggedPath,
        httpStatus: res.status,
        ok: res.ok,
        durationMs: Math.round(secondsSince(startedAt) * 1000),
      },
      "integration call completed",
    );
    activityRuns.inc({ activity: "callIntegration", outcome: "ok" });
    activityDuration.observe(
      { activity: "callIntegration" },
      secondsSince(startedAt),
    );
    return { status: "ok", httpStatus: res.status, ok: res.ok, body };
  } catch (e) {
    activityRuns.inc({ activity: "callIntegration", outcome: "error" });
    // Log the failure with call context (the logger scrubs; no secrets/bodies) so an
    // integration error — the 404/403 write-fail, a transient network error — is visible.
    log.warn(
      {
        activity: "callIntegration",
        executionId: meta.executionId,
        nodeId: meta.nodeId,
        tenantId: meta.tenantId,
        provider: cfg.provider,
        action: cfg.action,
        method: req.method,
        path: loggedPath,
        durationMs: Math.round(secondsSince(startedAt) * 1000),
        err: e instanceof Error ? e.message : String(e),
      },
      "integration call failed",
    );
    // Our own typed failures (e.g. INTEGRATION_WRITE_FAILED) are already sanitized +
    // carry the right retryability — rethrow as-is, never re-wrap them as retryable.
    if (e instanceof ApplicationFailure) throw e;
    if (e instanceof AuthConfigError) {
      // Platform misconfig (e.g. GitHub App env unset) — retrying can't fix it.
      throw ApplicationFailure.nonRetryable(e.message, "AUTH_NOT_CONFIGURED");
    }
    if (e instanceof NeedsReauthError) {
      throw ApplicationFailure.nonRetryable(
        "Connection needs re-authorization",
        "CONNECTION_REAUTH",
        { connectionId: cfg.connectionId },
      );
    }
    if (e instanceof MissingConnectionTokenError) {
      throw ApplicationFailure.nonRetryable(
        `integration '${cfg.provider}': connection '${cfg.connectionId}' has no token`,
        "INTEGRATION_NO_TOKEN",
      );
    }
    if (e instanceof BlockedEgressError) {
      throw ApplicationFailure.nonRetryable(
        "integration target blocked by egress policy (cloud hosts only)",
        "INTEGRATION_EGRESS_BLOCKED",
      );
    }
    // Transient — sanitized retryable (the interpreter runs WRITE actions at-most-once).
    throw toSanitizedRetryable(e, "INTEGRATION_TRANSIENT");
  }
}

/** Lower-case header keys for case-insensitive presence checks (HTTP is case-insensitive). */
function mapKeysLower(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(h)) out[k.toLowerCase()] = h[k];
  return out;
}

const DEFAULT_SQL_TIMEOUT_MS = 30_000;
/** Hard cap on per-query timeout. MUST stay below the callSqlQuery proxy's
 *  startToCloseTimeout so the DB driver — not Temporal — is the deadline. */
const MAX_SQL_TIMEOUT_MS = 120_000;

/** A resolved SQL query (bindings already applied by the interpreter). NO secrets:
 *  the DSN is read from the connection inside the activity. */
export interface SqlQueryConfig {
  connectionId: string;
  sql: string;
  params: unknown[];
  statementTimeoutMs?: number;
  costUsd?: number;
}

export interface SqlQueryResult {
  status: "ok";
  /** Result rows (a claim-check reference if large). The graph branches on rowCount. */
  rows: unknown;
  rowCount: number;
  costUsd: number;
}

/** Test seam: DB resolution + adapter lookup, swappable so tests need no live DB. */
export const __sqlDeps = {
  resolveDbConnection,
  getAdapter,
  assertHostPublic,
};

/** Best-effort host extraction from a DSN — a URL (postgres:// / mssql://) or an
 *  mssql key=value connection string (`Server=host,port;…`). null when unparseable
 *  (the driver will then fail on a malformed DSN anyway). */
export function dsnHost(dsn: string): string | null {
  try {
    const u = new URL(dsn);
    if (u.hostname) return u.hostname.replace(/^\[|\]$/g, "");
  } catch {
    /* not a URL — try the mssql key=value form below */
  }
  const m = dsn.match(
    /(?:^|;)\s*(?:server|data source|address|addr|network address)\s*=\s*([^;]+)/i,
  );
  if (!m) return null;
  // strip a `tcp:` prefix, an instance suffix (host\INSTANCE), and a ,port suffix.
  const host = m[1]
    .trim()
    .replace(/^tcp:/i, "")
    .split("\\")[0]
    .split(",")[0]
    .trim();
  return host || null;
}

/** mssql/tedious code for a bad login (wrong user/password in the DSN). */
const MSSQL_AUTH_CODE = "ELOGIN";
/** mssql/tedious codes that are deterministic query/timeout failures (NOT transient):
 *  EREQUEST = query error; ETIMEOUT = request timeout (the analogue of Postgres'
 *  57014 statement_timeout — re-running an expensive timed-out query just times out
 *  again, so don't retry). */
const MSSQL_QUERY_CODES = new Set(["EREQUEST", "ETIMEOUT"]);

/** The driver `code` if this is a deterministic DB error — a bad query, read-only
 *  violation, or query/timeout. pg uses a 5-char SQLSTATE; mssql uses EREQUEST/
 *  ETIMEOUT. The code is safe to surface — never the driver message, which can
 *  carry the DSN/host. (Auth + connection/transient codes are handled separately.) */
function sqlErrorCode(e: unknown): string | null {
  const code = (e as { code?: unknown }).code;
  if (typeof code !== "string") return null;
  if (/^[0-9A-Z]{5}$/.test(code)) return code; // pg SQLSTATE
  if (MSSQL_QUERY_CODES.has(code)) return code;
  return null;
}

/**
 * SQL Query node: run ONE read-only query against a tenant database and return its
 * rows so the graph can branch on `.rowCount`. The connection's DSN is resolved +
 * used IN-ACTIVITY (never crosses the workflow boundary). Read-only is enforced per
 * engine by the adapter (Postgres `READ ONLY` txn; MSSQL always-rollback).
 *
 * A query error (bad SQL / read-only violation) is non-retryable — the same query
 * fails the same way. Connection/transient errors retry, but are surfaced GENERICALLY
 * (never the driver message) so the DSN/host can't reach history or logs.
 */
export async function callSqlQuery(
  cfg: SqlQueryConfig,
  input: unknown,
  meta: AgentMeta,
): Promise<SqlQueryResult> {
  void input; // entry-node input flows via bindings, not directly into the query
  const startedAt = process.hrtime.bigint();
  try {
    const store = getObjectStore();
    const { engine, dsn } = await __sqlDeps.resolveDbConnection(
      meta.tenantId,
      cfg.connectionId,
    );
    // SSRF (audit S-3): the DSN host is tenant-supplied — reject an internal/reserved
    // target before connecting (mirrors callSendEmail's assertHostPublic). Wire
    // protocol, not HTTP, so this bounds internal reach/port-scanning.
    const dbHost = dsnHost(dsn);
    if (dbHost) await __sqlDeps.assertHostPublic(dbHost);
    // Resolve any claim-checked bound param back to its real value before the call.
    const params = (await resolveClaimChecks(
      cfg.params ?? [],
      store,
    )) as unknown[];
    const timeoutMs = Math.min(
      cfg.statementTimeoutMs ?? DEFAULT_SQL_TIMEOUT_MS,
      MAX_SQL_TIMEOUT_MS,
    );
    const result = await __sqlDeps
      .getAdapter(engine)
      .runReadOnly(dsn, cfg.sql, params, { timeoutMs });

    // Offload a large result set so it can't blow Temporal's ~2MB payload cap.
    const rows = await maybeOffload(result.rows, store, {
      keyPrefix: `sql/${meta.tenantId}`,
    });
    log.info(
      {
        activity: "callSqlQuery",
        executionId: meta.executionId,
        nodeId: meta.nodeId,
        tenantId: meta.tenantId,
        engine,
        connectionId: cfg.connectionId,
        rowCount: result.rowCount,
        costUsd: cfg.costUsd ?? 0,
      },
      "sql query completed",
    );
    activityRuns.inc({ activity: "callSqlQuery", outcome: "ok" });
    activityDuration.observe(
      { activity: "callSqlQuery" },
      secondsSince(startedAt),
    );
    if ((cfg.costUsd ?? 0) > 0) runCostUsd.inc(cfg.costUsd ?? 0);
    return {
      status: "ok",
      rows,
      rowCount: result.rowCount,
      costUsd: cfg.costUsd ?? 0,
    };
  } catch (e) {
    activityRuns.inc({ activity: "callSqlQuery", outcome: "error" });
    activityDuration.observe(
      { activity: "callSqlQuery" },
      secondsSince(startedAt),
    );
    if (e instanceof ApplicationFailure) throw e;
    // A DSN pointing at an internal/reserved host — the user must fix the connection.
    if (e instanceof BlockedEgressError) {
      throw ApplicationFailure.nonRetryable(e.message, "EGRESS_BLOCKED", {
        connectionId: cfg.connectionId,
      });
    }
    // A missing stored DSN, or an mssql bad-login (wrong user/password in the DSN):
    // the user must fix the connection — non-retryable, don't loop (CLAUDE.md).
    if (
      e instanceof MissingConnectionTokenError ||
      e instanceof NeedsReauthError ||
      (e as { code?: unknown }).code === MSSQL_AUTH_CODE
    ) {
      throw ApplicationFailure.nonRetryable(
        "Connection needs re-authorization",
        "CONNECTION_REAUTH",
        { connectionId: cfg.connectionId },
      );
    }
    // A DB-reported query error is deterministic — don't burn retries. Surface the
    // SQLSTATE/code ONLY (never the driver message — it can carry the DSN/host).
    const code = sqlErrorCode(e);
    if (code) {
      throw ApplicationFailure.nonRetryable(
        `SQL query failed (code ${code})`,
        "SQL_QUERY_ERROR",
        { connectionId: cfg.connectionId, code },
      );
    }
    // Connection/transient (refused, reset, timeout). Generic + retryable — drop the
    // original error entirely so the DSN/host never reaches history or logs.
    throw ApplicationFailure.retryable(
      "Database query failed transiently",
      "SQL_TRANSIENT",
      { connectionId: cfg.connectionId },
    );
  }
}

export interface SqlExecConfig {
  connectionId: string;
  sql: string;
  params: unknown[];
  statementTimeoutMs?: number;
  costUsd?: number;
}

export interface SqlExecResult {
  status: "ok";
  rowsAffected: number;
  costUsd: number;
}

/**
 * SQL Exec node: run ONE write (INSERT/UPDATE/DELETE) against a tenant database inside
 * a transaction (COMMIT on success, ROLLBACK on error) and return the affected row
 * count. Same DSN-in-activity + SSRF guard + binding rules as callSqlQuery.
 *
 * Writes are NOT idempotent, so this activity is registered AT-MOST-ONCE (retry: 1):
 * a partial/ambiguous failure fails the node rather than risk a double-write. Every
 * error is therefore NON-retryable here (surfaced generically so the DSN never leaks).
 */
export async function callSqlExec(
  cfg: SqlExecConfig,
  input: unknown,
  meta: AgentMeta,
): Promise<SqlExecResult> {
  void input;
  const startedAt = process.hrtime.bigint();
  try {
    const store = getObjectStore();
    const { engine, dsn } = await __sqlDeps.resolveDbConnection(
      meta.tenantId,
      cfg.connectionId,
    );
    const dbHost = dsnHost(dsn);
    if (dbHost) await __sqlDeps.assertHostPublic(dbHost);
    const params = (await resolveClaimChecks(
      cfg.params ?? [],
      store,
    )) as unknown[];
    const timeoutMs = Math.min(
      cfg.statementTimeoutMs ?? DEFAULT_SQL_TIMEOUT_MS,
      MAX_SQL_TIMEOUT_MS,
    );
    const result = await __sqlDeps
      .getAdapter(engine)
      .runWrite(dsn, cfg.sql, params, { timeoutMs });

    log.info(
      {
        activity: "callSqlExec",
        executionId: meta.executionId,
        nodeId: meta.nodeId,
        tenantId: meta.tenantId,
        engine,
        connectionId: cfg.connectionId,
        rowsAffected: result.rowsAffected,
        costUsd: cfg.costUsd ?? 0,
      },
      "sql exec completed",
    );
    activityRuns.inc({ activity: "callSqlExec", outcome: "ok" });
    activityDuration.observe(
      { activity: "callSqlExec" },
      secondsSince(startedAt),
    );
    if ((cfg.costUsd ?? 0) > 0) runCostUsd.inc(cfg.costUsd ?? 0);
    return {
      status: "ok",
      rowsAffected: result.rowsAffected,
      costUsd: cfg.costUsd ?? 0,
    };
  } catch (e) {
    activityRuns.inc({ activity: "callSqlExec", outcome: "error" });
    activityDuration.observe(
      { activity: "callSqlExec" },
      secondsSince(startedAt),
    );
    if (e instanceof ApplicationFailure) throw e;
    if (e instanceof BlockedEgressError) {
      throw ApplicationFailure.nonRetryable(e.message, "EGRESS_BLOCKED", {
        connectionId: cfg.connectionId,
      });
    }
    if (
      e instanceof MissingConnectionTokenError ||
      e instanceof NeedsReauthError ||
      (e as { code?: unknown }).code === MSSQL_AUTH_CODE
    ) {
      throw ApplicationFailure.nonRetryable(
        "Connection needs re-authorization",
        "CONNECTION_REAUTH",
        { connectionId: cfg.connectionId },
      );
    }
    // At-most-once: surface the code if we have one, else a generic failure. NEVER
    // retryable — a retry could double-write. The driver message (DSN/host) is dropped.
    const code = sqlErrorCode(e);
    throw ApplicationFailure.nonRetryable(
      code ? `SQL write failed (code ${code})` : "SQL write failed",
      "SQL_EXEC_ERROR",
      { connectionId: cfg.connectionId, ...(code ? { code } : {}) },
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Items model A3 (design docs/design/ITEMS-MODEL-CURRENT-ITEM.md §0.3): batched map.
// ─────────────────────────────────────────────────────────────────────────────

/** One per-item call: the ALREADY-RESOLVED config the interpreter built against frame `i` (the same
 *  payload execNode passes for a single call) + that item's `input` (the current item). */
export interface MapNodeItem {
  cfg: unknown;
  input: unknown;
}

export interface MapNodeResult {
  /** One output per item, in order — the node's normal output shape, or `{ error }` for a failed
   *  item (mapNode never throws for an item; the workflow applies the node's onError). */
  outputs: unknown[];
  /** Sum of the completed items' costUsd — the workflow accumulates it (Arch§4.6). */
  costUsd: number;
}

/** Swappable seam so unit tests + the interpreter e2e can fake the per-item calls (mapNode loops
 *  the SAME activity fns execNode uses, so each records its own usage row per item — fail-safe). */
export const __mapDeps = {
  runAgent,
  callHttpRequest,
  callMcpTool,
};

const MAP_NODE_DEFAULT_CONCURRENCY = 10;

/**
 * Fan a single "each" activity node out over N per-item inputs in ONE Temporal activity — never one
 * activity per item (that would grow event history O(items)). It loops the underlying activity fns,
 * each of which records its OWN usage row as it completes, so a mid-batch failure leaves completed
 * items already billed (fail-safe, Tier-1 #6). Per-item errors are CAUGHT and returned as `{ error }`
 * (never rethrown) so a bad item can't trigger a whole-batch Temporal retry (which would re-charge +
 * duplicate POST/email); the mapNode proxy is configured `maxAttempts: 1` for the same reason.
 */
export async function mapNode(
  nodeType: string,
  items: MapNodeItem[],
  meta: AgentMeta,
  maxParallel: number = MAP_NODE_DEFAULT_CONCURRENCY,
): Promise<MapNodeResult> {
  const outputs: unknown[] = new Array(items.length);
  let costUsd = 0;

  const runOne = async (item: MapNodeItem, i: number): Promise<void> => {
    try {
      if (nodeType === "agent") {
        const r = await __mapDeps.runAgent(
          item.cfg as AgentConfig,
          item.input,
          meta,
        );
        outputs[i] = r;
        costUsd += r.costUsd; // single-threaded: read-modify-write is uninterrupted (no await between)
      } else if (nodeType === "httpRequest") {
        const r = await __mapDeps.callHttpRequest(
          item.cfg as HttpRequestConfig,
          item.input,
          meta,
        );
        outputs[i] = { status: r.httpStatus, headers: r.headers, body: r.body };
        costUsd += r.costUsd;
      } else if (nodeType === "mcpTool") {
        const r = await __mapDeps.callMcpTool(
          item.cfg as McpToolConfig,
          item.input,
          meta,
        );
        outputs[i] = r;
        costUsd += r.costUsd;
      } else {
        throw ApplicationFailure.nonRetryable(
          `mapNode: unsupported node type '${nodeType}'`,
          "MAPNODE_TYPE",
        );
      }
    } catch (err) {
      // An unsupported type is a programming error → propagate (fail the node). Any other per-item
      // failure is returned as { error } so it never triggers a whole-batch retry.
      if (err instanceof ApplicationFailure && err.type === "MAPNODE_TYPE") {
        throw err;
      }
      // Cap the per-item message (× N items enters history — keep the payload bounded).
      const raw = err instanceof Error ? err.message : String(err);
      outputs[i] = {
        error: raw.length > 500 ? `${raw.slice(0, 500)}…` : raw,
      };
    }
  };

  // Bounded-concurrency pool over the N items. Result order is by index (deterministic to the
  // workflow — only mapNode's single return value enters history).
  let next = 0;
  const workerCount = Math.max(1, Math.min(maxParallel, items.length));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (next < items.length) {
        const i = next++;
        await runOne(items[i], i);
      }
    }),
  );
  return { outputs, costUsd };
}

// ─────────────────────────────────────────────────────────────────────────────
// RAG (design docs/design/CHAT-TRIGGER-RAG.md): pgvector vectorUpsert / vectorQuery.
// ─────────────────────────────────────────────────────────────────────────────

/** Embedding model — OpenAI text-embedding-3-small (1536 dims, matching VectorChunk.embedding). */
const EMBED_MODEL = "text-embedding-3-small";
const EMBED_DIM = 1536;

/** Swappable seam for tests (embed + DB writes) — mirrors __agentDeps/__mapDeps. */
export const __ragDeps = {
  getKey: (tenantId: string): Promise<string> =>
    getCredentials().getDecryptedKey(tenantId, "openai"),
  embedOne: async (
    apiKey: string,
    value: string,
  ): Promise<{ embedding: number[]; tokens: number }> => {
    const { createOpenAI } = await import("@ai-sdk/openai");
    const r = await embed({
      model: createOpenAI({ apiKey }).embedding(EMBED_MODEL),
      value,
    });
    return { embedding: r.embedding, tokens: r.usage?.tokens ?? 0 };
  },
  embedManyTexts: async (
    apiKey: string,
    values: string[],
  ): Promise<{ embeddings: number[][]; tokens: number }> => {
    const { createOpenAI } = await import("@ai-sdk/openai");
    const r = await embedMany({
      model: createOpenAI({ apiKey }).embedding(EMBED_MODEL),
      values,
    });
    return { embeddings: r.embeddings, tokens: r.usage?.tokens ?? 0 };
  },
};

/** pgvector wants a `'[1,2,3]'::vector` literal — the interpreter never sees this string. */
function toVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

/** Record embedding token usage (fail-safe — never a silent free call, Tier-1 #6). Embedding cost
 *  may be unpriced (computeCost returns 0), which is fine: tokens are still ledgered. */
async function recordEmbedUsage(
  meta: AgentMeta,
  tokens: number,
): Promise<number> {
  await __agentDeps.recordUsage({
    tenantId: meta.tenantId,
    executionId: meta.executionId,
    nodeId: meta.nodeId,
    provider: "openai",
    model: EMBED_MODEL,
    usage: { inputTokens: tokens, outputTokens: 0 },
  });
  try {
    return computeCost({
      provider: "openai",
      model: EMBED_MODEL,
      inputTokens: tokens,
      outputTokens: 0,
    });
  } catch {
    return 0; // embedding model not in the pricing table → tokens ledgered, cost 0
  }
}

export interface VectorUpsertResult {
  status: "ok";
  result: { upserted: number };
  costUsd: number;
}

/** vectorUpsert node: embed the chunk(s) with the tenant's BYOK OpenAI key and store them in the
 *  tenant-scoped VectorChunk store under `collection`. Missing key → non-retryable (user must fix). */
export async function callVectorUpsert(
  cfg: { collection: string },
  input: unknown,
  meta: AgentMeta,
): Promise<VectorUpsertResult> {
  const store = getObjectStore();
  const value = await resolveClaimChecks(input, store);
  const chunks = (Array.isArray(value) ? value : [value])
    .map((c) => (typeof c === "string" ? c : JSON.stringify(c)))
    .filter((c) => c.trim() !== "");
  if (chunks.length === 0) {
    return { status: "ok", result: { upserted: 0 }, costUsd: 0 };
  }
  let apiKey: string;
  try {
    apiKey = await __ragDeps.getKey(meta.tenantId);
  } catch {
    throw ApplicationFailure.nonRetryable(
      "No OpenAI key configured for embeddings",
      "RAG_NO_KEY",
      { tenantId: meta.tenantId },
    );
  }
  const { embeddings, tokens } = await __ragDeps.embedManyTexts(apiKey, chunks);
  for (let i = 0; i < chunks.length; i++) {
    await getPrisma().$executeRaw`
      INSERT INTO "VectorChunk" ("id", "tenantId", "collection", "chunkText", "embedding")
      VALUES (${randomUUID()}, ${meta.tenantId}, ${cfg.collection}, ${chunks[i]}, ${toVectorLiteral(embeddings[i])}::vector)`;
  }
  const costUsd = await recordEmbedUsage(meta, tokens);
  activityRuns.inc({ activity: "callVectorUpsert", outcome: "ok" });
  return { status: "ok", result: { upserted: chunks.length }, costUsd };
}

export interface VectorMatch {
  chunkText: string;
  score: number;
}
export interface VectorQueryResult {
  status: "ok";
  result: { matches: VectorMatch[] };
  costUsd: number;
}

/** vectorQuery node: embed the query and return the top-k nearest chunks (cosine similarity) from
 *  the tenant's `collection`. Exact search (`<=>`) — fine for v1 / small collections. */
export async function callVectorQuery(
  cfg: { collection: string; topK?: number },
  input: unknown,
  meta: AgentMeta,
): Promise<VectorQueryResult> {
  const store = getObjectStore();
  const value = await resolveClaimChecks(input, store);
  const query = typeof value === "string" ? value : JSON.stringify(value ?? "");
  if (query.trim() === "") {
    return { status: "ok", result: { matches: [] }, costUsd: 0 };
  }
  let apiKey: string;
  try {
    apiKey = await __ragDeps.getKey(meta.tenantId);
  } catch {
    throw ApplicationFailure.nonRetryable(
      "No OpenAI key configured for embeddings",
      "RAG_NO_KEY",
      { tenantId: meta.tenantId },
    );
  }
  const { embedding, tokens } = await __ragDeps.embedOne(apiKey, query);
  const topK = Math.min(Math.max(1, Math.floor(cfg.topK ?? 4)), 50);
  const vec = toVectorLiteral(embedding);
  const rows = await getPrisma().$queryRaw<
    { chunkText: string; score: number }[]
  >`
    SELECT "chunkText", 1 - ("embedding" <=> ${vec}::vector) AS "score"
    FROM "VectorChunk"
    WHERE "tenantId" = ${meta.tenantId} AND "collection" = ${cfg.collection}
    ORDER BY "embedding" <=> ${vec}::vector
    LIMIT ${topK}`;
  const matches = rows.map((r) => ({
    chunkText: r.chunkText,
    score: Number(r.score),
  }));
  const costUsd = await recordEmbedUsage(meta, tokens);
  activityRuns.inc({ activity: "callVectorQuery", outcome: "ok" });
  return { status: "ok", result: { matches }, costUsd };
}

// EMBED_DIM is asserted at build to match the migration's vector(1536).
void EMBED_DIM;
