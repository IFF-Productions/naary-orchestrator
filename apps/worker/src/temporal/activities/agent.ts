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
  type AgentGuardrailPolicy,
  applyContentRules,
  applyContentRulesToValue,
  type ContentViolation,
  evaluateToolPolicy,
  isEmptyGuardrailPolicy,
  mcpToolRef,
  redactPii,
  violationLabels,
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
import { GUARDRAIL_ACTOR, recordAuditEvent } from "./audit";
import { loadGuardrailPolicy } from "./guardrails";
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
  /** Guardrail summary (#576) — absent when no policy applied. Labels + counts, never content. */
  guardrails?: AgentGuardrailReport;
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
  /** Agent guardrails (#576): the workspace policy read + the worker-side audit writer.
   *  Swappable so the enforcement paths (denied tool, content rule, redaction) are unit-testable
   *  with no DB — which is exactly how the AC3 "no raw PII escapes" test asserts its claim. */
  loadGuardrailPolicy,
  recordAuditEvent,
};

/** Labels + counts only — never matched text, never the redaction map (#576, Tier-1 rule 4). */
export interface AgentGuardrailReport {
  /** Distinct PII values replaced in the prompt before the model saw it. */
  redacted?: number;
  /** `"input:<label>"` / `"output:<label>"` for each rule that matched. */
  violations?: string[];
}

/**
 * Fire-and-forget guardrail audit row. Never awaited on the enforcement path and never allowed to
 * throw: enforcement has ALREADY happened by the time this runs, so an audit-write problem must
 * not turn a correctly-blocked call into a differently-failed one (nor a permitted call into a
 * failure). Same posture as fireBudgetThresholdAlert.
 */
function fireGuardrailAudit(
  meta: AgentMeta,
  action: string,
  statusCode: number,
): void {
  try {
    void Promise.resolve(
      __agentDeps.recordAuditEvent({
        tenantId: meta.tenantId,
        actor: GUARDRAIL_ACTOR,
        action,
        path: `/executions/${meta.executionId}/nodes/${meta.nodeId}`,
        statusCode,
        environmentId: meta.environmentId,
      }),
    ).catch(() => undefined);
  } catch {
    /* best-effort — an audit write must never affect the run */
  }
}

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

    // ---- AGENT GUARDRAILS (#576), enforced IN-ACTIVITY -----------------------------------------
    // Read the workspace policy FIRST — before the credential fetch, before the budget
    // reservation, before any token is spent — so a denied tool or a blocked prompt costs nothing.
    // This is the second of three enforcement points (save gate, here, interpreter pause); it is
    // what makes a runtime bypass (a graph saved before the policy tightened, a direct workflow
    // start, a hand-written graph) fail rather than execute (#576 AC1, runtime half).
    const policy: AgentGuardrailPolicy = await __agentDeps.loadGuardrailPolicy(
      meta.tenantId,
    );
    const guardrailsActive = !isEmptyGuardrailPolicy(policy);
    // Report returned to the interpreter: labels + counts only.
    const guardrailReport: AgentGuardrailReport = {};
    const inputViolations: ContentViolation[] = [];

    if (guardrailsActive) {
      // (1) TOOL POLICY. A denied tool is refused before the toolset is even built, so the model
      // is never offered it. A forced-approval tool is ALSO refused here rather than silently run:
      // the pause it requires cannot happen mid-activity (Temporal can't suspend an activity to
      // await a Signal), and running it unapproved would be the exact governance hole the policy
      // exists to close. The save gate rejects this configuration up front with the same reason.
      for (const t of cfg.tools ?? []) {
        const ref = mcpToolRef(t.connectionId, t.tool);
        const verdict = evaluateToolPolicy(ref, policy);
        if (verdict === "deny") {
          fireGuardrailAudit(meta, `Blocked denied agent tool ${ref}`, 403);
          throw ApplicationFailure.nonRetryable(
            `Agent tool '${ref}' is blocked by this workspace's guardrail policy`,
            "GUARDRAIL_TOOL_DENIED",
            { tenantId: meta.tenantId },
          );
        }
        if (verdict === "approval") {
          fireGuardrailAudit(
            meta,
            `Blocked forced-approval agent tool ${ref} (in-loop)`,
            403,
          );
          throw ApplicationFailure.nonRetryable(
            `Agent tool '${ref}' requires human approval, which cannot be awaited inside an agent's tool loop — move it to a standalone Tool/Integration node`,
            "GUARDRAIL_TOOL_NEEDS_APPROVAL",
            { tenantId: meta.tenantId },
          );
        }
      }
    }

    // (2)+(3) INPUT CONTENT RULES, then PII REDACTION, over the assembled prompt. The system
    // prompt and the serialized input are handled separately so a `strip` rewrite lands in the
    // right slot. When no policy is configured both values are the ORIGINAL ones, so the
    // no-guardrails path is byte-identical to pre-#576 (the generateText args below prove it).
    let effSystemPrompt = cfg.systemPrompt;
    let effPromptText = JSON.stringify(modelInput);
    if (guardrailsActive && policy.input?.length) {
      const sys = applyContentRules(effSystemPrompt ?? "", policy.input);
      const usr = applyContentRules(effPromptText, policy.input);
      inputViolations.push(...sys.violations, ...usr.violations);
      if (sys.blocked || usr.blocked) {
        const labels = violationLabels("input", inputViolations);
        fireGuardrailAudit(
          meta,
          `Blocked agent input by content rule(s) ${labels.join(", ")}`,
          403,
        );
        // NON-retryable: the same input violates the same rule every time, so a retry only burns
        // Temporal attempts. The message names the LABELS, never the matched text.
        throw ApplicationFailure.nonRetryable(
          `Agent input blocked by guardrail content rule(s): ${labels.join(", ")}`,
          "GUARDRAIL_CONTENT_BLOCKED",
          { tenantId: meta.tenantId },
        );
      }
      if (effSystemPrompt !== undefined) effSystemPrompt = sys.text;
      effPromptText = usr.text;
    }
    if (guardrailsActive && policy.redact?.enabled) {
      // The redaction MAPS are the sensitive artifact (placeholder → raw PII). They stay in this
      // block scope, are never returned, never logged, never put on a span, never persisted
      // (Tier-1 rule 4 posture). Only `count` — a number — escapes.
      const sysRed = redactPii(effSystemPrompt ?? "", policy.redact.kinds);
      const usrRed = redactPii(effPromptText, policy.redact.kinds);
      if (effSystemPrompt !== undefined) effSystemPrompt = sysRed.text;
      effPromptText = usrRed.text;
      const redacted = sysRed.count + usrRed.count;
      if (redacted > 0) guardrailReport.redacted = redacted;
    }

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
      !!effSystemPrompt;

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
    const wantStructured = cfg.outputSchema !== undefined;
    const outputOpt = wantStructured
      ? {
          output: Output.object({
            schema: jsonSchema<Record<string, unknown>>(
              cfg.outputSchema as unknown as Parameters<typeof jsonSchema>[0],
            ),
          }),
        }
      : {};

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
                    // GUARDRAILS (#576): the content-rule-filtered, PII-redacted prompt — equal to
                    // `cfg.systemPrompt` when no policy is configured.
                    content: effSystemPrompt as string,
                    providerOptions: {
                      anthropic: { cacheControl: { type: "ephemeral" } },
                    },
                  },
                  {
                    role: "user" as const,
                    content: effPromptText,
                  },
                ],
              }
            : {
                system: effSystemPrompt,
                prompt: effPromptText,
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
              cfg.systemPrompt,
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
    let nodeOutput: Record<string, unknown> = wantStructured
      ? (result.output as Record<string, unknown>)
      : { text: result.text };

    // (4) OUTPUT CONTENT RULES. Applied to every string LEAF of the output (never by
    // stringify→rewrite→reparse, which a `strip` straddling a JSON delimiter would corrupt).
    // NOTE ON COST: the model call already happened and is already billed — that spend is real and
    // is recorded below whether the output is blocked or not (rule 6: never record zero for a call
    // that happened). Blocking here prevents the content from reaching downstream nodes / Temporal
    // history; it cannot un-spend the tokens.
    const outputRules = guardrailsActive ? policy.output : undefined;
    if (outputRules?.length) {
      const checked = applyContentRulesToValue(nodeOutput, outputRules);
      const labels = [
        ...violationLabels("input", inputViolations),
        ...violationLabels("output", checked.violations),
      ];
      if (labels.length > 0) guardrailReport.violations = labels;
      if (checked.blocked) {
        const outLabels = violationLabels("output", checked.violations);
        fireGuardrailAudit(
          meta,
          `Blocked agent output by content rule(s) ${outLabels.join(", ")}`,
          403,
        );
        // Record the spend BEFORE failing: the provider call happened, so a silently-free call
        // would violate Tier-1 rule 6. Then fail non-retryably (a retry re-pays for an output the
        // same rule blocks again).
        await __agentDeps.recordUsage({
          tenantId: meta.tenantId,
          environmentId: meta.environmentId,
          executionId: meta.executionId,
          nodeId: meta.nodeId,
          nodeType: meta.ledgerNodeType ?? "agent",
          durationMs: Math.round(secondsSince(startedAt) * 1000),
          provider,
          model,
          usage,
        });
        throw ApplicationFailure.nonRetryable(
          `Agent output blocked by guardrail content rule(s): ${outLabels.join(", ")}`,
          "GUARDRAIL_CONTENT_BLOCKED",
          { tenantId: meta.tenantId },
        );
      }
      nodeOutput = checked.value;
    } else if (inputViolations.length > 0) {
      // `strip`-only input violations still deserve a report (nothing was blocked, but the prompt
      // was rewritten and the run detail should say so).
      guardrailReport.violations = violationLabels("input", inputViolations);
    }

    await __agentDeps.recordUsage({
      tenantId: meta.tenantId,
      environmentId: meta.environmentId, // per-env cost tag (Slice 6)
      executionId: meta.executionId,
      nodeId: meta.nodeId,
      // Slice 2: by-node-type rollups without a graph join. `ledgerNodeType` lets the eval
      // activity tag its LLM-JUDGE spend distinctly (#575) while reusing this whole path.
      nodeType: meta.ledgerNodeType ?? "agent",
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
      // Guardrail summary (#576) — omitted entirely when nothing happened, so a run with no policy
      // produces the exact pre-#576 result shape. LABELS + COUNTS ONLY: the redaction map and every
      // matched string stay in this activity by construction (Tier-1 rule 4).
      ...(Object.keys(guardrailReport).length > 0
        ? { guardrails: guardrailReport }
        : {}),
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
