/**
 * Activities — the ONLY place side effects are allowed (CLAUDE.md Tier-1 rule 3).
 * This module (and its @naary/secrets / @naary/usage / @naary/db imports) loads
 * in the worker PROCESS, never in the deterministic workflow bundle — workflows.ts
 * imports it type-only.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { ApplicationFailure } from "@temporalio/activity";
import {
  BlockedEgressError,
  MissingConnectionTokenError,
  NeedsReauthError,
  assertEgressAllowed,
  callMcpTool as mcpCall,
  resolveAuthHeader,
  resolveDbConnection,
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
