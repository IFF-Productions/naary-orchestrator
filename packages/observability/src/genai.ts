/**
 * OpenTelemetry **GenAI semantic-convention** span mapping (#581) — the SINGLE module the
 * `gen_ai.*` attribute names live in, so a convention rename is a one-file change instead of a
 * grep across every activity.
 *
 * CONVENTION VERSION (pinned, read this before renaming anything). We target the `gen_ai`
 * namespace as published alongside OpenTelemetry Semantic Conventions **v1.41.0**. That namespace
 * is still **development** status (pre-1.0) and has MOVED to its own repository
 * (open-telemetry/semantic-conventions-genai), so churn is expected and EXPLICITLY tolerated here:
 *   - `gen_ai.system` is already DEPRECATED in favor of `gen_ai.provider.name`. We emit BOTH,
 *     because backends that ingested the 1.36-era conventions still key dashboards on the old
 *     name. Drop `gen_ai.system` once our backends read `gen_ai.provider.name`.
 *   - `gen_ai.operation.name` well-known values used here: `chat`, `embeddings`, `execute_tool`.
 *   - `gen_ai.tool.type` well-known values are `function` / `extension` / `datastore`. An MCP tool
 *     is exposed to the model as a callable function, so it is `function` — we deliberately do NOT
 *     invent a value (e.g. "mcp") inside the reserved `gen_ai.` namespace.
 * Anything of ours that has no convention attribute is namespaced `naary.` — never squatted into
 * `gen_ai.` (see the cost/estimated attributes below).
 *
 * PRIVACY HARD LINE — NOT CONFIGURABLE (CLAUDE.md: the usage ledger records tokens + cost only,
 * never prompt/completion text). The conventions define OPTIONAL content capture — the
 * `gen_ai.input.messages` / `gen_ai.output.messages` attributes and the legacy `gen_ai.content.*`
 * events — carrying the full prompt and completion. We never emit them, and there is deliberately
 * NO flag to turn them on. The mechanism enforcing that is the TYPES in this file: every input is a
 * token count, a model name, a finish reason, or a cost. There is no parameter through which text
 * could reach a span. Do not add one.
 *
 * EGRESS. These are ordinary Sentry span attributes, so they leave via the existing exporter path
 * and are scrubbed by `beforeSendTransaction` → scrubEvent like every other span (see initSentry).
 * Token counts are ALSO dual-emitted as the convention's `gen_ai.client.token.usage` metric, which
 * rides metrics.ts → the OTLP sink (#462) so a Datadog/OTLP backend gets the counts natively.
 *
 * DETERMINISM (CLAUDE.md Tier-1 rule 2). Activities + API only — NEVER workflow code: opening a
 * span reads the clock / async context and would break deterministic replay.
 */
import { metricDistribution } from "./metrics";
import { setSpanAttributes, withSpan, type SpanAttrs } from "./spans";

/** The semantic-conventions release whose `gen_ai` namespace this mapping targets (see header). */
export const GEN_AI_SEMCONV_VERSION = "1.41.0";

/** `gen_ai.operation.name` values we emit. `chat` = an LLM call; `embeddings` = an embedding call
 *  (input-only: it reports input tokens and no output tokens); `execute_tool` = a tool call. All
 *  three are well-known convention values — we never invent one inside the `gen_ai.` namespace. */
export type GenAiOperation = "chat" | "embeddings" | "execute_tool";

/**
 * Map OUR provider id to the convention's `gen_ai.provider.name` well-known value. Only `google`
 * differs (the conventions distinguish the Gemini API from Vertex AI); anything unrecognized is
 * passed through unchanged so a newly added provider still gets a usable — if non-well-known —
 * dimension rather than a silently dropped attribute.
 */
export function genAiProviderName(provider: string): string {
  if (provider === "google") return "gcp.gemini";
  return provider;
}

/** What is known BEFORE the call — safe to set at span creation. No content, by type. */
export interface GenAiRequest {
  operation: GenAiOperation;
  /** Our provider id (anthropic/openai/google) — mapped via {@link genAiProviderName}. */
  provider: string;
  /** The model we are about to ask for (post-downgrade, i.e. what actually runs). */
  model: string;
  maxOutputTokens?: number;
  temperature?: number;
}

/**
 * What is known AFTER the call: counts, the model that answered, why it stopped. Token counts are
 * whatever the ledger records — the provider's real usage, or the rule-6 fail-safe estimate, in
 * which case `estimated` must be set so a dashboard can tell the difference.
 */
export interface GenAiResponse {
  /** The model that actually answered, when the provider reports it (may differ from the request). */
  responseModel?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Prompt-cache reads — a separate billing bucket for Anthropic (see agent.ts QA#2 note). */
  cachedInputTokens?: number;
  /** Convention shape is a LIST (a call can stop for several reasons across steps). */
  finishReasons?: string[];
  /** Token cost of THIS call. Not a convention attribute → emitted under `naary.`. */
  costUsd?: number;
  /** True when the counts are our fail-safe ESTIMATE, not provider-reported (Tier-1 rule 6). */
  estimated?: boolean;
}

/** A tool call (the agent's in-loop MCP tools, and the standalone mcpTool node). */
export interface GenAiToolCall {
  /** The tool name as the model sees it (the exposed name), never the raw connection/URL. */
  toolName: string;
  /** Provider-assigned tool-call id, when we have one. */
  toolCallId?: string;
}

/**
 * Span attribute values, widened over {@link SpanAttrs} with the LIST form the conventions use for
 * `gen_ai.response.finish_reasons`. Sentry/OTel accept string arrays, and deepScrub walks arrays,
 * so a list value is still scrubbed on egress.
 */
export type GenAiAttrs = Record<string, string | number | boolean | string[]>;

/**
 * Span NAME per the conventions: `{operation} {model}` for a model call (e.g. `chat claude-opus-4-8`)
 * — low-cardinality and immediately readable in a trace waterfall.
 */
export function genAiSpanName(
  operation: GenAiOperation,
  target: string,
): string {
  return `${operation} ${target}`;
}

/** Request-side attributes. Only ids/numbers — nothing derived from the prompt. */
export function genAiRequestAttrs(req: GenAiRequest): SpanAttrs {
  const provider = genAiProviderName(req.provider);
  return {
    "gen_ai.operation.name": req.operation,
    "gen_ai.provider.name": provider,
    // Deprecated since ~1.36 but still what many backends key on — see the header.
    "gen_ai.system": provider,
    "gen_ai.request.model": req.model,
    ...(req.maxOutputTokens !== undefined
      ? { "gen_ai.request.max_tokens": req.maxOutputTokens }
      : {}),
    ...(req.temperature !== undefined
      ? { "gen_ai.request.temperature": req.temperature }
      : {}),
  };
}

/**
 * Response-side attributes. Every field is omitted when absent rather than emitted as 0 — a zero
 * token count reads as "a free call" on a dashboard, the same trap CLAUDE.md rule 6 calls out for
 * the ledger.
 */
export function genAiResponseAttrs(res: GenAiResponse): GenAiAttrs {
  return {
    ...(res.responseModel
      ? { "gen_ai.response.model": res.responseModel }
      : {}),
    ...(res.inputTokens !== undefined
      ? { "gen_ai.usage.input_tokens": res.inputTokens }
      : {}),
    ...(res.outputTokens !== undefined
      ? { "gen_ai.usage.output_tokens": res.outputTokens }
      : {}),
    ...(res.cachedInputTokens !== undefined
      ? { "gen_ai.usage.cached_input_tokens": res.cachedInputTokens }
      : {}),
    ...(res.finishReasons?.length
      ? { "gen_ai.response.finish_reasons": res.finishReasons }
      : {}),
    // Not convention attributes — namespaced so a future `gen_ai.*` addition can't collide.
    ...(res.costUsd !== undefined
      ? { "naary.gen_ai.usage.cost_usd": res.costUsd }
      : {}),
    ...(res.estimated !== undefined
      ? { "naary.gen_ai.usage.estimated": res.estimated }
      : {}),
  };
}

/** Tool-call attributes (`execute_tool`). The tool NAME only — never its arguments or result. */
export function genAiToolAttrs(call: GenAiToolCall): SpanAttrs {
  return {
    "gen_ai.operation.name": "execute_tool",
    "gen_ai.tool.name": call.toolName,
    // An MCP tool is a callable function from the model's point of view (see header).
    "gen_ai.tool.type": "function",
    ...(call.toolCallId ? { "gen_ai.tool.call.id": call.toolCallId } : {}),
  };
}

/**
 * Dual-emit the convention's token-usage metric so an OTLP/Datadog backend gets the counts as a
 * first-class metric, not only as span attributes (our OTLP exporter is metrics-only — #462).
 * Dimensions are LOW-CARDINALITY per metrics.ts: operation/provider/model/token type — deliberately
 * NO tenantId/executionId/nodeId (those belong on spans, not on metric labels).
 */
function recordTokenUsageMetric(req: GenAiRequest, res: GenAiResponse): void {
  const dims = {
    "gen_ai.operation.name": req.operation,
    "gen_ai.provider.name": genAiProviderName(req.provider),
    "gen_ai.request.model": req.model,
    // Carry the fail-safe flag as a DIMENSION, not just a span attribute: the OTLP sink is
    // metrics-only (#462), so a Datadog/OTLP dashboard sees these series and nothing else.
    // Without it, a rule-6 ESTIMATE is indistinguishable from provider-reported usage and
    // would silently skew token/cost reporting (Copilot review, #581). Always present (never
    // conditional) so the series has a stable dimension set — absent flag ⇒ reported.
    "naary.gen_ai.usage.estimated": res.estimated === true,
  };
  if (res.inputTokens !== undefined) {
    metricDistribution(
      "gen_ai.client.token.usage",
      res.inputTokens,
      { ...dims, "gen_ai.token.type": "input" },
      "{token}",
    );
  }
  if (res.outputTokens !== undefined) {
    metricDistribution(
      "gen_ai.client.token.usage",
      res.outputTokens,
      { ...dims, "gen_ai.token.type": "output" },
      "{token}",
    );
  }
}

/**
 * Run an LLM call inside a GenAI-convention span. Wrap ONLY the model call (plus the pure usage
 * derivation whose numbers the span reports) — never the surrounding credential fetch or budget
 * reservation, or the span's duration would stop meaning "model latency".
 *
 * `fn` receives a `record` callback for the after-the-fact figures (tokens, finish reason, cost).
 * It must be called WHILE `fn` is still running — that's when the span is active. Calling it is
 * optional (a throwing call records nothing but still leaves an errored span).
 */
export function withGenAiSpan<T>(
  req: GenAiRequest,
  fn: (record: (res: GenAiResponse) => void) => Promise<T>,
): Promise<T> {
  const record = (res: GenAiResponse): void => {
    setSpanAttributes(genAiResponseAttrs(res));
    recordTokenUsageMetric(req, res);
  };
  return withSpan(genAiSpanName(req.operation, req.model), () => fn(record), {
    op: `gen_ai.${req.operation}`,
    // Thunk: the mapping runs only when a span is actually created (tracing on).
    attributes: () => genAiRequestAttrs(req),
  });
}

/**
 * Run a TOOL call inside a GenAI-convention `execute_tool` span. Used both for an agent's in-loop
 * MCP tools (where it nests under the `chat` span) and for the standalone mcpTool node (where it
 * nests under that node's `activity.callMcpTool` span). Tool ARGUMENTS and RESULTS are never
 * attached — same privacy line as the prompt.
 */
export function withGenAiToolSpan<T>(call: GenAiToolCall, fn: () => T): T {
  return withSpan(genAiSpanName("execute_tool", call.toolName), fn, {
    op: "gen_ai.execute_tool",
    attributes: () => genAiToolAttrs(call),
  });
}
