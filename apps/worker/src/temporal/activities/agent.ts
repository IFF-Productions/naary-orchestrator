// agent node — the AI-SDK model call (BYOK, budget reservation, billing).
import { createLogger } from "@naary/logging";
import { ApplicationFailure } from "@temporalio/activity";
import { getDefaultEnvironmentId } from "@naary/db";
import { callMcpTool as mcpCall, resolveMcpTarget } from "@naary/connections";
import { MissingCredentialError } from "@naary/secrets";
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
  activityDuration,
  activityRuns,
  agentTokens,
  runCostUsd,
  secondsSince,
} from "../../metrics";
import {
  type AgentMeta,
  aiSdk,
  anthropicSdk,
  estimateTokens,
  getCredentials,
  googleSdk,
  openaiSdk,
  toSanitizedRetryable,
} from "./shared";
import { sendNotification } from "./notifications";

// Activities run in the worker PROCESS (a side-effect zone), so structured
// logging is fine here — unlike workflows.ts, which must stay deterministic.
// Logs carry execution-correlated ids (executionId/nodeId/tenantId) and token/
// cost numbers only — never prompts, completions, or keys (the logger scrubs).
const log = createLogger({ component: "worker" });

const MAX_OUTPUT_TOKENS = 1024;
/** Default loop bound for a tooled agent (#449) — generateText's own default is 1 step,
 *  which would emit a tool call and STOP before answering, so a tooled agent must always
 *  pass an explicit stopWhen. Bounds runaway loops + Temporal history growth. */
const DEFAULT_MAX_TOOL_STEPS = 8;

/** One MCP tool the agent may call mid-reasoning (#449). */
export interface AgentToolConfig {
  /** Tenant MCP connection the tool call authenticates through. */
  connectionId: string;
  /** Remote tool name on that MCP server. */
  tool: string;
  /** Name exposed to the model (defaults to `tool`). */
  name?: string;
  /** What the tool does — the model reads this to decide when to call it. */
  description?: string;
  /** JSON Schema for the tool's arguments; omitted ⇒ open object. */
  inputSchema?: Record<string, unknown>;
  /** Flat per-call cost (parity with the mcpTool node — MCP tools carry no token cost). */
  costUsd?: number;
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
  /** MCP tools the agent may call mid-reasoning (#449). Non-empty ⇒ generateText runs a
   *  multi-step tool loop (bounded by maxToolSteps) instead of a single call. */
  tools?: AgentToolConfig[];
  /** Max reasoning+tool steps before the loop must produce a final answer (default 8). */
  maxToolSteps?: number;
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
  /** Total tokens of THIS call (same figure the ledger records — real or the fail-safe
   *  estimate, never zero for a real call). Rides into ctx so the run detail can show a
   *  per-step TOKENS stat without a ledger read (Slice 2). Optional: results recorded
   *  before this field replay without it. */
  totalTokens?: number;
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
// The AI SDK's `jsonSchema()` wrapper is applied lazily inside runAgent (the `ai` package is
// ESM-only, loaded via dynamic import) — this stays a plain JSON-schema object with no SDK dep.

async function buildModel(provider: string, model: string, apiKey: string) {
  if (provider === "anthropic") {
    return (await anthropicSdk()).createAnthropic({ apiKey })(model);
  }
  if (provider === "openai") {
    return (await openaiSdk()).createOpenAI({ apiKey })(model);
  }
  if (provider === "google") {
    return (await googleSdk()).createGoogleGenerativeAI({ apiKey })(model);
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
  getDefaultEnvId: getDefaultEnvironmentId,
  recordUsage,
  getBudget,
  monthToDateSpend,
  reserveBudget,
  releaseReservation,
  /** In-loop MCP tool wiring (#449): connection→target resolution + the MCP call, swappable
   *  in tests so the tool loop can be exercised without a live MCP server. Mirrors __mcpDeps
   *  in mcp.ts so both the standalone mcpTool node and the in-agent loop hit the same path. */
  resolveMcpTarget,
  callMcpTool: mcpCall,
  /** Budget alert-threshold notification (Slice 3). Routed through the same channel
   *  fan-out as run notifications; swappable so specs can capture/fail the send. */
  sendNotification,
};

/**
 * Fire the budgetThreshold alert FIRE-AND-FORGET (Slice 3). FAIL-SAFE by construction
 * (CLAUDE.md rule 6 posture): never awaited on the reservation path and every failure
 * mode — sync throw, rejection — is caught and only logged, so a notification problem
 * can never block the reservation or the run. A missed alert is the accepted trade.
 */
function fireBudgetThresholdAlert(
  meta: AgentMeta,
  crossed: { pct: number; spendUsd: number; capUsd: number },
): void {
  try {
    void Promise.resolve(
      __agentDeps.sendNotification({
        tenantId: meta.tenantId,
        environmentId: meta.environmentId,
        kind: "budget_threshold",
        workflowId: meta.executionId,
        thresholdPct: crossed.pct,
        capUsd: crossed.capUsd,
        spendUsd: crossed.spendUsd,
      }),
    ).catch((e: unknown) => {
      log.warn(
        {
          activity: "runAgent",
          tenantId: meta.tenantId,
          thresholdPct: crossed.pct,
          error: e instanceof Error ? e.message : String(e),
        },
        "budget threshold alert failed (ignored — never blocks the run)",
      );
    });
  } catch (e) {
    log.warn(
      {
        activity: "runAgent",
        tenantId: meta.tenantId,
        error: e instanceof Error ? e.message : String(e),
      },
      "budget threshold alert failed (ignored — never blocks the run)",
    );
  }
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

    // In memory only — never returned from the activity, never logged. Env-scoped creds (Slice 5):
    // use the run's env (5b, threaded via meta) so a sandbox run reads the sandbox key; a pre-5b run
    // has no meta.environmentId → fall back to the tenant default (byte-identical to pre-Slice-5).
    const envId =
      meta.environmentId ?? (await __agentDeps.getDefaultEnvId(meta.tenantId));
    const apiKey = await __agentDeps
      .getCredentials()
      .getDecryptedKey(meta.tenantId, envId, provider);

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
        undefined,
        budget.alertThresholdPct,
      );
      if (!res.ok) {
        // Pause-not-fail (Slice 3): the policy is read LIVE per reservation (this
        // getBudget call), so the marker type — not workflow state — carries the
        // decision. BUDGET_PAUSE is thrown ONLY under policy "pause" (a value no
        // pre-Slice-3 tenant has); the interpreter parks the run on it (behind
        // wf.patched("budget-pause-v1")) instead of failing terminally.
        if (budget.onBudgetExceeded === "pause") {
          throw ApplicationFailure.nonRetryable(
            "Monthly budget exceeded — run paused until the cap is raised or the month rolls over",
            "BUDGET_PAUSE",
            { tenantId: meta.tenantId },
          );
        }
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
            undefined,
            budget.alertThresholdPct,
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
      // Alert threshold crossed by THIS reservation (exactly-once-per-month, claimed
      // transactionally inside reserveBudget). Fire-and-forget — see the helper.
      if (res.thresholdCrossed) {
        fireBudgetThresholdAlert(meta, res.thresholdCrossed);
      }
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

    const { generateText, Output, jsonSchema, tool, stepCountIs } =
      await aiSdk();

    // In-loop tools (#449): each configured MCP tool becomes an AI-SDK tool whose `execute`
    // resolves the connection + calls the remote tool IN-ACTIVITY (token never crosses the
    // workflow boundary — Tier-1 §4), routed through the SAME __mcpDeps-equivalent path the
    // standalone mcpTool node uses. The model decides when to call them; the loop is bounded
    // by stopWhen below. MCP tools carry no token cost, so their flat costUsd is summed here
    // and folded into the node's returned cost (parity with the mcpTool node — no UsageEvent).
    const toolConfigs = cfg.tools ?? [];
    const tooled = toolConfigs.length > 0;
    let toolCostUsd = 0;
    const builtTools: Record<string, unknown> = {};
    for (const t of toolConfigs) {
      const exposedName = t.name?.trim() || t.tool;
      builtTools[exposedName] = tool({
        description: t.description ?? `MCP tool '${t.tool}'`,
        inputSchema: jsonSchema(
          (t.inputSchema ?? {
            type: "object",
            additionalProperties: true,
          }) as unknown as Parameters<typeof jsonSchema>[0],
        ),
        execute: async (args: unknown) => {
          const target = await __agentDeps.resolveMcpTarget(
            meta.tenantId,
            t.connectionId,
          );
          const r = await __agentDeps.callMcpTool({
            serverUrl: target.serverUrl,
            headers: target.headers,
            tool: t.tool,
            arguments: (args ?? {}) as Record<string, unknown>,
          });
          // A tool-level error is NOT success — surface it (non-retryable: same args fail the
          // same way) so the model doesn't proceed on a phantom result.
          if (r.isError) {
            throw ApplicationFailure.nonRetryable(
              `MCP tool '${t.tool}' returned an error`,
              "MCP_TOOL_ERROR",
              { connectionId: t.connectionId },
            );
          }
          toolCostUsd += t.costUsd ?? 0;
          return r.content;
        },
      });
    }

    // Structured output is applied when there are no tools (historical behaviour), OR when a
    // tooled agent explicitly configures an `outputSchema`. A tooled agent WITHOUT a schema
    // returns free text — forcing the default {category,urgency} shape onto "fetch-and-summarize"
    // would be nonsense, and tools-returns-text is the well-trodden AI-SDK path.
    const wantStructured = !tooled || cfg.outputSchema !== undefined;
    const outputOpt = wantStructured
      ? {
          output: Output.object({
            // Per-node schema when configured (QA#9), else the default shape. `as const` literals
            // widen to the mutable JSONSchema7 the SDK expects (runtime schema unchanged).
            schema: jsonSchema<Record<string, unknown>>(
              (cfg.outputSchema ??
                DEFAULT_OUTPUT_SCHEMA) as unknown as Parameters<
                typeof jsonSchema
              >[0],
            ),
          }),
        }
      : {};

    const result = await generateText({
      model: await buildModel(provider, model, apiKey),
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
      ...(tooled
        ? {
            // Cast keeps generateText's tool generics shallow — combining ToolSet + Output
            // inference otherwise risks a TS2589 deep-instantiation blow-up (see jsonSchema note).
            tools: builtTools as Parameters<typeof generateText>[0]["tools"],
            stopWhen: stepCountIs(cfg.maxToolSteps ?? DEFAULT_MAX_TOOL_STEPS),
          }
        : {}),
      ...outputOpt,
      maxOutputTokens,
      ...(cfg.temperature !== undefined
        ? { temperature: cfg.temperature }
        : {}),
    });

    // The node's output: the structured object when a schema drove the call, else the model's
    // final free-text answer as { text } (a stable shape downstream expressions can read).
    const nodeOutput: Record<string, unknown> = wantStructured
      ? (result.output as Record<string, unknown>)
      : { text: result.text };

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
      environmentId: meta.environmentId, // per-env cost tag (Slice 6)
      executionId: meta.executionId,
      nodeId: meta.nodeId,
      nodeType: "agent", // Slice 2: by-node-type rollups without a graph join
      durationMs: Math.round(secondsSince(startedAt) * 1000), // measured in-activity
      provider,
      model, // the model that actually ran (post-downgrade)
      usage,
    });

    // Same cost recordUsage computed — returned so the workflow can accumulate
    // it deterministically (no DB read in workflow code). For a tooled call, add the
    // flat MCP tool costs accrued during the loop (#449): the ledger records token
    // spend, while the returned costUsd is the node's total spend the run accumulates —
    // exactly how the standalone mcpTool node contributes its flat cost (no UsageEvent).
    const tokenCostUsd = computeCost({
      provider,
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedInputTokens: (usage as { cachedInputTokens?: number })
        .cachedInputTokens,
    });
    const costUsd = tokenCostUsd + toolCostUsd;

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
      output: nodeOutput,
      model,
      costUsd,
      // Same figure the ledger just recorded (real or fail-safe estimate) — per-step
      // TOKENS for the run detail (Slice 2). The estimate path has no totalTokens
      // field, so sum the buckets (mirrors recordUsage's own default).
      totalTokens:
        (usage as { totalTokens?: number }).totalTokens ??
        usage.inputTokens + usage.outputTokens,
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
    // Load APICallError defensively: `ai` is already cached here (the generateText call above
    // resolved it), so this can't realistically fail — but if it ever did, don't let the import
    // error mask the ORIGINAL provider error; fall through to the sanitized retryable below.
    const aiMod = await aiSdk().catch(() => undefined);
    if (aiMod?.APICallError.isInstance(e)) {
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
