/**
 * Activities — the ONLY place side effects are allowed (CLAUDE.md Tier-1 rule 3).
 * This module (and its @naary/secrets / @naary/usage / @naary/db imports) loads
 * in the worker PROCESS, never in the deterministic workflow bundle — workflows.ts
 * imports it type-only.
 */
import { createHash, createHmac } from "node:crypto";
import { createAnthropic } from "@ai-sdk/anthropic";
import { ApplicationFailure } from "@temporalio/activity";
import { SignJWT, importPKCS8 } from "jose";
import nodemailer from "nodemailer";
import { XMLBuilder, XMLParser } from "fast-xml-parser";
import { parse as parseHtml } from "node-html-parser";
import { marked } from "marked";
import TurndownService from "turndown";
import Papa from "papaparse";
import { getQuickJS, shouldInterruptAfterDeadline } from "quickjs-emscripten";
import { canonicalize } from "@naary/dsl";
import type {
  CodeNodeConfig,
  GraphDef,
  ResolvedHmac,
  ResolvedJwt,
  ResolvedRss,
  ResolvedSendEmail,
} from "@naary/dsl";
// Re-export so the interpreter e2e can reference these as activities.* (the hmac/
// jwt/sendEmail/rss activity args are the DSL's Resolved* types).
export type {
  CodeNodeConfig,
  ResolvedHmac,
  ResolvedJwt,
  ResolvedRss,
  ResolvedSendEmail,
} from "@naary/dsl";
import {
  BlockedEgressError,
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
import { APICallError, Output, generateText, jsonSchema } from "ai";

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
}): Promise<void> {
  await getPrisma().execution.upsert({
    where: { workflowId: meta.workflowId },
    create: {
      workflowId: meta.workflowId,
      tenantId: meta.tenantId,
      workflowKey: meta.workflowKey ?? null,
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
  fetch: (url: string, init?: RequestInit) => fetch(url, init),
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

/** Shared shape for the text-parsing activities (html/markdown/csv). */
export interface TextResult {
  status: "ok";
  result: unknown;
  costUsd: number;
}

async function textActivity(
  activity: string,
  errType: string,
  input: unknown,
  meta: AgentMeta,
  run: (value: unknown) => unknown,
): Promise<TextResult> {
  const startedAt = process.hrtime.bigint();
  const store = getObjectStore();
  const value = await resolveClaimChecks(input, store);
  try {
    const result = await maybeOffload(run(value), store, {
      keyPrefix: `${activity}/${meta.tenantId}`,
    });
    activityRuns.inc({ activity, outcome: "ok" });
    activityDuration.observe({ activity }, secondsSince(startedAt));
    return { status: "ok", result, costUsd: 0 };
  } catch {
    activityRuns.inc({ activity, outcome: "error" });
    activityDuration.observe({ activity }, secondsSince(startedAt));
    // Parse/convert failures are the user's data problem — non-retryable, no secrets.
    throw ApplicationFailure.nonRetryable(`${activity} failed`, errType);
  }
}

export interface HtmlConfig {
  selector: string;
  return?: "text" | "html" | "attribute";
  attribute?: string;
}
/** html node — extract via a CSS selector → { items }. */
export function callHtml(
  cfg: HtmlConfig,
  input: unknown,
  meta: AgentMeta,
): Promise<TextResult> {
  return textActivity("callHtml", "HTML_ERROR", input, meta, (value) => {
    const nodes = parseHtml(String(value)).querySelectorAll(cfg.selector);
    const items = nodes.map((n) =>
      cfg.return === "html"
        ? n.innerHTML
        : cfg.return === "attribute"
          ? (n.getAttribute(cfg.attribute ?? "") ?? "")
          : n.text,
    );
    return { items };
  });
}

export interface MarkdownConfig {
  operation: "toHtml" | "toMarkdown";
}
/** markdown node — convert markdown↔HTML → { text }. */
export function callMarkdown(
  cfg: MarkdownConfig,
  input: unknown,
  meta: AgentMeta,
): Promise<TextResult> {
  return textActivity(
    "callMarkdown",
    "MARKDOWN_ERROR",
    input,
    meta,
    (value) => {
      const text =
        cfg.operation === "toMarkdown"
          ? new TurndownService({ headingStyle: "atx" }).turndown(String(value))
          : (marked.parse(String(value), { async: false }) as string);
      return { text };
    },
  );
}

export interface CsvConfig {
  operation: "parse" | "build";
  header?: boolean;
  delimiter?: string;
}
/** csv node — parse CSV text → { rows }, or build rows → { csv }. */
export function callCsv(
  cfg: CsvConfig,
  input: unknown,
  meta: AgentMeta,
): Promise<TextResult> {
  return textActivity("callCsv", "CSV_ERROR", input, meta, (value) => {
    if (cfg.operation === "build") {
      return {
        csv: Papa.unparse(value as object[], {
          delimiter: cfg.delimiter ?? ",",
        }),
      };
    }
    const parsed = Papa.parse(String(value), {
      header: cfg.header ?? true,
      delimiter: cfg.delimiter,
      skipEmptyLines: true,
    });
    return { rows: parsed.data };
  });
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

    const result = await generateText({
      model: buildModel(provider, model, apiKey),
      system: cfg.systemPrompt,
      prompt: JSON.stringify(input),
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
    // arrive separately as cachedInputTokens), so input and cached are independent
    // billing buckets — computeCost must not subtract one from the other.
    const u = result.totalUsage ?? result.usage;
    const real = {
      inputTokens: u?.inputTokens ?? 0,
      outputTokens: u?.outputTokens ?? 0,
      totalTokens: u?.totalTokens,
      cachedInputTokens: u?.cachedInputTokens,
      reasoningTokens: u?.reasoningTokens,
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
}

export interface HttpRequestResult {
  status: "ok";
  /** HTTP response status code — the graph branches on this (e.g. status gt 399). */
  httpStatus: number;
  headers: Record<string, string>;
  body: unknown;
  /** Metered cost of this call — the workflow accumulates it (Arch§4.6). */
  costUsd: number;
}

/** Test seam: the network call + connection/egress resolution, swappable in tests. */
export const __httpDeps = {
  fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
  resolveAuthHeader,
  assertEgressAllowed,
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

    // Append static query params, then SSRF-guard the FULLY-RESOLVED URL at call
    // time (https + public host only; defeats DNS rebinding + upstream-built hosts).
    let rawUrl = cfg.url;
    const qs = new URLSearchParams(cfg.query ?? {}).toString();
    if (qs) rawUrl += (rawUrl.includes("?") ? "&" : "?") + qs;
    const url = await __httpDeps.assertEgressAllowed(rawUrl);
    host = url.host;

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

    // Bound the request with a deadline so a hung server can't pin the activity.
    const controller = new AbortController();
    const timeoutMs = Math.min(
      cfg.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS,
      MAX_HTTP_TIMEOUT_MS,
    );
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await __httpDeps.fetch(url, { ...init, signal: controller.signal });
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

    if (cfg.failOnErrorStatus && res.status >= 400) {
      throw ApplicationFailure.nonRetryable(
        `HTTP request returned status ${res.status}`,
        "HTTP_ERROR_STATUS",
        { httpStatus: res.status },
      );
    }

    // Offload a large body so it can't blow Temporal's ~2MB payload cap (Arch§4.6).
    const offloaded = await maybeOffload(body, store, {
      keyPrefix: `http/${meta.tenantId}`,
    });
    // Drop response-side credentials (Set-Cookie) before the headers land in ctx →
    // Temporal history. The rest (content-type, etc.) is useful for branching.
    const responseHeaders: Record<string, string> = {};
    for (const [k, v] of res.headers.entries()) {
      if (k.toLowerCase() === "set-cookie") continue;
      responseHeaders[k] = v;
    }

    log.info(
      {
        activity: "callHttpRequest",
        executionId: meta.executionId,
        nodeId: meta.nodeId,
        tenantId: meta.tenantId,
        method: cfg.method,
        host,
        httpStatus: res.status,
        costUsd: cfg.costUsd ?? 0,
      },
      "http request completed",
    );
    activityRuns.inc({ activity: "callHttpRequest", outcome: "ok" });
    activityDuration.observe(
      { activity: "callHttpRequest" },
      secondsSince(startedAt),
    );
    if ((cfg.costUsd ?? 0) > 0) runCostUsd.inc(cfg.costUsd ?? 0);
    return {
      status: "ok",
      httpStatus: res.status,
      headers: responseHeaders,
      body: offloaded,
      costUsd: cfg.costUsd ?? 0,
    };
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
};

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
