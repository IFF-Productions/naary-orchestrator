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
  callMcpTool as mcpCall,
  resolveMcpTarget,
} from "@naary/connections";
import { createLogger } from "@naary/logging";
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
}

export interface AgentMeta {
  tenantId: string;
  executionId: string;
  nodeId: string;
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
  // Released in `finally` (Arch§4.3) — whether the call succeeds or throws — so a
  // failed/retried activity never leaves a dangling reservation.
  let reservationId: string | undefined;
  try {
    // In memory only — never returned from the activity, never logged.
    const apiKey = await __agentDeps
      .getCredentials()
      .getDecryptedKey(meta.tenantId, cfg.provider);

    // Pre-flight budget enforcement via an atomic RESERVATION (Arch§4.3): reserve
    // this call's estimated cost against the monthly cap BEFORE the LLM call, so
    // concurrent runs for one tenant can't all overshoot. The reservation counts
    // committed spend + other in-flight reservations. No budget set ⇒ no cap.
    let model = cfg.model;
    const budget = await __agentDeps.getBudget(meta.tenantId);
    if (budget) {
      const estimateFor = (m: string) =>
        estimateCallCost(
          {
            provider: cfg.provider,
            model: m,
            systemPrompt: cfg.systemPrompt,
            maxOutputTokens: MAX_OUTPUT_TOKENS,
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
      model: buildModel(cfg.provider, model, apiKey),
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
      maxOutputTokens: MAX_OUTPUT_TOKENS,
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
      provider: cfg.provider,
      model, // the model that actually ran (post-downgrade)
      usage,
    });

    // Same cost recordUsage computed — returned so the workflow can accumulate
    // it deterministically (no DB read in workflow code).
    const costUsd = computeCost({
      provider: cfg.provider,
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
        provider: cfg.provider,
        model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costUsd,
      },
      "agent node completed",
    );

    return {
      status: "ok",
      output: result.output as Record<string, unknown>,
      model,
      costUsd,
    };
  } catch (e) {
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
    return { status: "ok", content, costUsd: cfg.costUsd ?? 0 };
  } catch (e) {
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
