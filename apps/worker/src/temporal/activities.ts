/**
 * Activities — the ONLY place side effects are allowed (CLAUDE.md Tier-1 rule 3).
 * This module (and its @naary/secrets / @naary/usage / @naary/db imports) loads
 * in the worker PROCESS, never in the deterministic workflow bundle — workflows.ts
 * imports it type-only.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { ApplicationFailure } from "@temporalio/activity";
import {
  MissingConnectionTokenError,
  NeedsReauthError,
  callMcpTool as mcpCall,
  resolveMcpTarget,
} from "@naary/connections";
import { CredentialsService, MissingCredentialError } from "@naary/secrets";
import {
  computeCost,
  estimateCallCost,
  getBudget,
  monthToDateSpend,
  recordUsage,
} from "@naary/usage";
import { APICallError, Output, generateText, jsonSchema } from "ai";

const MAX_OUTPUT_TOKENS = 1024;

export interface AgentConfig {
  provider: string;
  model: string;
  systemPrompt: string;
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
  output: AgentOutput;
  /** The model that actually ran (may differ from cfg.model after a downgrade). */
  model: string;
  /** Cost of THIS call — the workflow accumulates these deterministically. */
  costUsd: number;
}

// Slice #2 ships one structured-output schema. It can't ride in JSON graph
// config, so it lives here; per-node schema routing is a later slice. Using the
// AI SDK's jsonSchema<T> (vs zod) gives an explicit output type and avoids a
// TS2589 deep-instantiation blow-up in generateText's generics.
const outputSchema = jsonSchema<AgentOutput>({
  type: "object",
  properties: {
    category: { type: "string" },
    urgency: { type: "number" },
  },
  required: ["category", "urgency"],
  additionalProperties: false,
});

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
  try {
    // In memory only — never returned from the activity, never logged.
    const apiKey = await __agentDeps
      .getCredentials()
      .getDecryptedKey(meta.tenantId, cfg.provider);

    // Pre-flight budget check (I/O — reads the ledger). If month-to-date spend
    // plus this call's estimate would breach the monthly cap, apply the policy:
    // reject (non-retryable) or downgrade to a cheaper model. No budget set ⇒ no cap.
    let model = cfg.model;
    const budget = await __agentDeps.getBudget(meta.tenantId);
    if (budget) {
      const mtd = await __agentDeps.monthToDateSpend(meta.tenantId);
      const estimate = estimateCallCost(
        {
          provider: cfg.provider,
          model,
          systemPrompt: cfg.systemPrompt,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
        },
        input,
      );
      if (mtd + estimate > budget.monthlyCapUsd) {
        if (budget.onBudgetExceeded === "downgrade" && budget.fallbackModel) {
          model = budget.fallbackModel;
        } else {
          throw ApplicationFailure.nonRetryable(
            "Monthly budget exceeded",
            "BUDGET",
            { tenantId: meta.tenantId },
          );
        }
      }
    }

    const result = await generateText({
      model: buildModel(cfg.provider, model, apiKey),
      system: cfg.systemPrompt,
      prompt: JSON.stringify(input),
      output: Output.object({ schema: outputSchema }),
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    });

    // BILLING (CLAUDE.md rule 6): totalUsage sums across tool steps; guard the
    // ai@6 undefined-usage bug so we never silently record a free call.
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

    return { status: "ok", output: result.output, model, costUsd };
  } catch (e) {
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
    // Genuine transient error: rethrow BARE (no logging — AI-SDK errors can
    // carry request headers incl. the key) so Temporal's retry policy handles it.
    throw e;
  }
}

export interface McpToolConfig {
  connectionId: string;
  tool: string;
  /** Tool arguments, already resolved from upstream outputs by the interpreter. */
  arguments?: Record<string, unknown>;
}

export interface McpToolResult {
  status: "ok";
  content: unknown;
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
    const target = await __mcpDeps.resolveMcpTarget(
      meta.tenantId,
      cfg.connectionId,
    );
    const result = await __mcpDeps.callMcpTool({
      serverUrl: target.serverUrl,
      headers: target.headers,
      tool: cfg.tool,
      arguments: cfg.arguments ?? (input as Record<string, unknown>) ?? {},
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
    return { status: "ok", content: result.content };
  } catch (e) {
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
    throw e; // transient — let Temporal retry
  }
}
