// agent node — the AI-SDK model call (BYOK, budget reservation, billing).
import { createLogger } from "@naary/logging";
import { ApplicationFailure } from "@temporalio/activity";
import { getDefaultEnvironmentId } from "@naary/db";
import {
  AuthConfigError,
  BlockedEgressError,
  callMcpTool as mcpCall,
  MissingConnectionTokenError,
  NeedsReauthError,
  resolveMcpTarget,
} from "@naary/connections";
import { MissingCredentialError } from "@naary/secrets";
import {
  type AgentHandoff,
  HANDOFF_TARGET_FIELD,
  handoffOutputSchema,
  handoffTargetName,
} from "@naary/dsl";
import { withGenAiSpan, withGenAiToolSpan } from "@naary/observability";
import {
  containsClaimCheck,
  getObjectStore,
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
  runLog,
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
  /** Multi-agent handoff (#580 Phase 1). When set, the output schema is DERIVED from the
   *  declared targets (`handoffOutputSchema`) so the model must pick one of their names —
   *  an invalid route is unrepresentable — and the roster is appended to the system prompt
   *  so it knows what each specialist handles. `validateGraph` guarantees each target has a
   *  matching conditional edge, so routing is plain edge evaluation: the interpreter is
   *  untouched and the choice is made HERE, in an activity, keeping replay deterministic. */
  handoff?: AgentHandoff;
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

// Structured output is fully node-config-driven (#450): an agent returns a structured object
// ONLY when its config sets an explicit `outputSchema`, otherwise free text `{ text }`. There is
// no hardcoded fallback schema — the old default `{category,urgency}` was a Slice-#2 leftover that
// silently coerced every schema-less agent (e.g. "summarize this") into a classifier shape. The AI
// SDK's `jsonSchema()` wrapper is applied lazily inside runAgent (the `ai` package is ESM-only,
// loaded via dynamic import); the schema stays a plain JSON-schema object with no SDK dep.

/**
 * Map a connection/MCP transport error to the SAME non-retryable ApplicationFailure the
 * standalone mcpTool node uses (#449 review). Without this, an in-loop tool's reauth / blocked-
 * egress / missing-token / auth-misconfig error would fall through to runAgent's generic catch and
 * become a retryable AGENT_TRANSIENT — wrong semantics for a user-actionable connection problem
 * (and it would burn Temporal retries when NodeDef.retry is set). Returns undefined for anything
 * that isn't a known connection error, so genuine transient errors still retry.
 */
function mapMcpToolError(
  e: unknown,
  connectionId?: string,
): ApplicationFailure | undefined {
  const detail = connectionId ? { connectionId } : undefined;
  if (e instanceof BlockedEgressError) {
    return ApplicationFailure.nonRetryable(
      "Connection target is not allowed",
      "BLOCKED_EGRESS",
      detail,
    );
  }
  if (e instanceof AuthConfigError) {
    return ApplicationFailure.nonRetryable(e.message, "AUTH_NOT_CONFIGURED");
  }
  if (
    e instanceof MissingConnectionTokenError ||
    e instanceof NeedsReauthError
  ) {
    return ApplicationFailure.nonRetryable(
      "Connection needs re-authorization",
      "CONNECTION_REAUTH",
      detail,
    );
  }
  return undefined;
}

/**
 * The routing roster appended to a handoff supervisor's system prompt (#580). Prompt COPY,
 * so it lives here rather than in the DSL — but the names come from `handoffTargetName`,
 * the same function the derived enum and the edge conditions use, so the roster can never
 * name a target the model isn't allowed to pick.
 */
function handoffRoster(handoff: AgentHandoff): string {
  const lines = handoff.targets.map((t) => {
    const name = handoffTargetName(t);
    return t.description ? `- ${name}: ${t.description}` : `- ${name}`;
  });
  return [
    "You are routing this work to exactly ONE of the following specialists:",
    ...lines,
    "",
    `Set "${HANDOFF_TARGET_FIELD}" to the name of the single best specialist, and put everything that specialist needs to do its job into "payload" — the graph hands your payload to it as its brief.`,
  ].join("\n");
}

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
  // Per-run debug logging (opt-in via the run's `debug` flag) — safe metadata only, never the prompt.
  const rlog = runLog(log, meta);
  // Released in `finally` (Arch§4.3) — whether the call succeeds or throws — so a
  // failed/retried activity never leaves a dangling reservation.
  let reservationId: string | undefined;
  try {
    // Defaults for graphs whose agent node didn't persist provider/model (e.g. the
    // canvas inspector showed the default but the user never changed the dropdown).
    // anthropic is the only supported provider today; opus is a safe default model.
    const provider = cfg.provider?.trim() || "anthropic";

    // Items claim-check (#479): a per-item input can arrive as a `{__claimCheck}` REFERENCE — the
    // expandItems activity offloads large elements of a big items array so the workflow carries
    // small refs, not blobs. Rehydrate HERE, at the activity boundary (the only place I/O is
    // allowed), so the prompt + the budget estimate see the real value and not the reference. The
    // pure containsClaimCheck pre-check keeps the ref-free case free of any object-store touch.
    const modelInput = containsClaimCheck(input)
      ? await resolveClaimChecks(input, getObjectStore())
      : input;

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
    // Debug-run only: the node's resolved shape — never the prompt text or key (safe metadata only).
    rlog.debug(
      {
        provider,
        model,
        maxOutputTokens,
        temperature: cfg.temperature,
        systemPromptChars: cfg.systemPrompt?.length ?? 0,
        tools: cfg.tools?.length ?? 0,
        structuredOutput: cfg.outputSchema !== undefined,
      },
      "agent node starting",
    );
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
          modelInput,
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
      // Fail fast on a duplicate exposed name (#449 review): silently overwriting would make the
      // effective toolset non-obvious, let the model call an unintended tool, and mis-count flat
      // tool cost. Non-retryable — it's a static config error the author must fix.
      if (Object.prototype.hasOwnProperty.call(builtTools, exposedName)) {
        throw ApplicationFailure.nonRetryable(
          `Duplicate agent tool name '${exposedName}' — exposed tool names must be unique`,
          "DUPLICATE_TOOL_NAME",
        );
      }
      builtTools[exposedName] = tool({
        description: t.description ?? `MCP tool '${t.tool}'`,
        inputSchema: jsonSchema(
          (t.inputSchema ?? {
            type: "object",
            additionalProperties: true,
          }) as unknown as Parameters<typeof jsonSchema>[0],
        ),
        // GenAI-convention `execute_tool` span (#581) around each in-loop tool call, so a trace shows
        // the model's tool round-trips as CHILDREN of the `chat` span above with their own latency.
        // The exposed tool NAME only — never the arguments or the result (same privacy line as the
        // prompt: the conventions' content capture stays off).
        execute: (args: unknown) =>
          withGenAiToolSpan({ toolName: exposedName }, async () => {
            try {
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
            } catch (err) {
              // Map connection/transport errors to the SAME non-retryable failures the mcpTool node
              // uses (with THIS tool's connectionId) before they escape into the model loop — so
              // reauth/blocked/missing-token/misconfig don't get sanitized to a retryable transient
              // by the outer catch. Our own ApplicationFailures pass through untouched.
              if (err instanceof ApplicationFailure) throw err;
              const mapped = mapMcpToolError(err, t.connectionId);
              if (mapped) throw mapped;
              throw err;
            }
          }),
      });
    }

    // Structured output is applied ONLY when the node configures an `outputSchema` (#450) — for
    // both plain and tooled agents alike. No schema ⇒ free text `{ text }`, the well-trodden
    // AI-SDK path; there is no hardcoded fallback shape.
    //
    // A `handoff` (#580) DERIVES that schema from its declared targets rather than the author
    // hand-writing one: `target` is an enum of the target names, so the provider constrains
    // generation and the run can never route to an edge that doesn't exist. The save-gate
    // rejects handoff + outputSchema together, so there is exactly one schema either way.
    const effectiveOutputSchema = cfg.handoff
      ? handoffOutputSchema(cfg.handoff)
      : cfg.outputSchema;
    const wantStructured = effectiveOutputSchema !== undefined;
    const outputOpt = wantStructured
      ? {
          output: Output.object({
            schema: jsonSchema<Record<string, unknown>>(
              effectiveOutputSchema as unknown as Parameters<
                typeof jsonSchema
              >[0],
            ),
          }),
        }
      : {};

    // A handoff supervisor is told WHO it can route to. Without the roster the model sees an
    // enum of bare names and has to guess what each one handles; with it, the descriptions the
    // author already wrote do the work. Appended (never replacing the author's prompt), and
    // derived from the same `targets` the enum and the edges come from — one source of truth.
    // `systemPrompt` is OPTIONAL (the save gate allows a handoff agent without one), so it is
    // filtered rather than interpolated — a template literal turned the missing case into a
    // prompt that literally began "undefined", which the model reads and the token estimate bills.
    const systemPrompt = cfg.handoff
      ? [cfg.systemPrompt?.trim(), handoffRoster(cfg.handoff)]
          .filter((part): part is string => Boolean(part))
          .join("\n\n")
      : cfg.systemPrompt;

    // GenAI-convention span (#581). It wraps ONLY the model call + the PURE usage/cost derivation
    // whose numbers it reports — the credential fetch, budget reservation, and the recordUsage write
    // stay outside, so the span's duration keeps meaning "model latency". Attributes are model /
    // tokens / finish reason / cost only; prompt + completion text cannot reach a span attribute by
    // construction (see the privacy note in @naary/observability's genai module).
    const { result, usage, tokenCostUsd } = await withGenAiSpan(
      {
        operation: "chat",
        provider,
        model,
        maxOutputTokens,
        temperature: cfg.temperature,
      },
      async (recordGenAi) => {
        const result = await generateText({
          model: await buildModel(provider, model, apiKey),
          ...(cachePrompt
            ? {
                messages: [
                  {
                    role: "system" as const,
                    content: systemPrompt as string,
                    providerOptions: {
                      anthropic: { cacheControl: { type: "ephemeral" } },
                    },
                  },
                  {
                    role: "user" as const,
                    content: JSON.stringify(modelInput),
                  },
                ],
              }
            : {
                system: systemPrompt,
                prompt: JSON.stringify(modelInput),
              }),
          ...(tooled
            ? {
                // Cast keeps generateText's tool generics shallow — combining ToolSet + Output
                // inference otherwise risks a TS2589 deep-instantiation blow-up (see jsonSchema note).
                tools: builtTools as Parameters<
                  typeof generateText
                >[0]["tools"],
                stopWhen: stepCountIs(
                  cfg.maxToolSteps ?? DEFAULT_MAX_TOOL_STEPS,
                ),
              }
            : {}),
          ...outputOpt,
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
        // The provider reported nothing usable ⇒ the rule-6 fail-safe estimate. Flagged on the span
        // so a dashboard can't mistake an estimate for a metered count.
        const estimated = !(real.inputTokens || real.outputTokens);
        const usage = estimated
          ? estimateTokens(
              systemPrompt,
              modelInput,
              // output text may be empty under structured output — fall back to the object
              result.text || JSON.stringify(result.output ?? ""),
            )
          : real;
        // Same cost recordUsage computes (pure — @naary/usage pricing table), derived here so the
        // span can carry it; the node's TOTAL cost adds the flat MCP tool spend below.
        const tokenCostUsd = computeCost({
          provider,
          model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cachedInputTokens: (usage as { cachedInputTokens?: number })
            .cachedInputTokens,
        });
        recordGenAi({
          responseModel: result.response?.modelId,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cachedInputTokens: (usage as { cachedInputTokens?: number })
            .cachedInputTokens,
          // Convention shape is a list; ai exposes a single reason for the whole call.
          finishReasons: result.finishReason
            ? [result.finishReason]
            : undefined,
          costUsd: tokenCostUsd,
          estimated,
        });
        return { result, usage, tokenCostUsd };
      },
    );

    // The node's output: the structured object when a schema drove the call, else the model's
    // final free-text answer as { text } (a stable shape downstream expressions can read).
    const nodeOutput: Record<string, unknown> = wantStructured
      ? (result.output as Record<string, unknown>)
      : { text: result.text };

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

    // The same token cost recordUsage computed (derived inside the GenAI span above) — returned so
    // the workflow can accumulate it deterministically (no DB read in workflow code). For a tooled
    // call, add the flat MCP tool costs accrued during the loop (#449): the ledger records token
    // spend, while the returned costUsd is the node's total spend the run accumulates — exactly how
    // the standalone mcpTool node contributes its flat cost (no UsageEvent).
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
    // Defensive (#449 review): generateText may WRAP a tool's throw (e.g. a ToolExecutionError
    // carrying `.cause`), so an already-mapped ApplicationFailure or a raw connection error nested
    // as the cause would otherwise be re-sanitized to a retryable AGENT_TRANSIENT below. Unwrap one
    // level and preserve the correct non-retryable classification.
    const cause = (e as { cause?: unknown })?.cause;
    if (cause instanceof ApplicationFailure) throw cause;
    const mappedCause = mapMcpToolError(e) ?? mapMcpToolError(cause);
    if (mappedCause) throw mappedCause;
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
    // The model returned no output matching the agent's configured `outputSchema` (AI SDK
    // NoOutputGeneratedError). This is NOT transient — the same prompt+schema will fail again, so
    // retrying only burns tokens/cost and, as a retryable AGENT_TRANSIENT, alerts high-priority in
    // Sentry (#543). Fail fast + NON-retryably with an actionable message instead. Detected by name/
    // message (robust across ai versions) plus the SDK's own isInstance when it exposes the class.
    const noOutput =
      (
        aiMod as {
          NoOutputGeneratedError?: { isInstance?: (x: unknown) => boolean };
        }
      )?.NoOutputGeneratedError?.isInstance?.(e) === true ||
      (e as { name?: string })?.name === "AI_NoOutputGeneratedError" ||
      (e instanceof Error && e.message.includes("No output generated"));
    if (noOutput) {
      throw ApplicationFailure.nonRetryable(
        "The agent's model returned no output matching its configured schema — adjust the prompt or simplify/remove the output schema.",
        "AGENT_NO_OUTPUT",
      );
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
