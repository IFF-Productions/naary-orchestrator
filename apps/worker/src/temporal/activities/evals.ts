// Workflow evals (#575) — the batch's side effects: read the golden dataset, EVALUATE ASSERTIONS,
// persist per-case verdicts, aggregate the run.
//
// Assertions are evaluated HERE, not in the workflow, for two reasons the issue names: the
// `schemaValid` assertion compiles a JSON Schema with zod (runtime validation, forbidden in the
// deterministic bundle by Tier-1 rule 2) and the `llmJudge` assertion is a model call (rule 3).
//
// PRIVACY: the results table stores verdicts + scores + cost + latency. Every row's `assertions`
// column is built by @naary/dsl's `buildPersistableOutcome`, an explicit field allowlist — so the
// case's trigger payload, the run's output, and the judge's prose reasoning are dropped structurally,
// not by a comment or a later `delete`.
import { getDefaultEnvironmentId, getPrisma, Prisma } from "@naary/db";
import { createLogger } from "@naary/logging";
import { ApplicationFailure } from "@temporalio/activity";
import {
  containsClaimCheck,
  getObjectStore,
  resolveClaimChecks,
} from "@naary/storage";
// Deep dist import: ./assertions carries zod and is deliberately NOT re-exported from the
// @naary/dsl index (see the header there) so it can never enter the workflow bundle.
import {
  aggregateVerdict,
  assertionLabel,
  assertionsForCase,
  buildPersistableOutcome,
  type AssertionOutcome,
  type CaseVerdict,
  type EvalCase,
  type EvalDatasetBody,
  evaluateDeterministicAssertion,
  isLlmJudge,
  judgeOutcome,
  type LlmJudgeAssertion,
  parseEvalDatasetBody,
} from "@naary/dsl/dist/assertions";
import { runAgent } from "./agent";
import type { AgentMeta } from "./shared";

const log = createLogger({ component: "worker" });

/** `UsageEvent.nodeType` for LLM-judge spend — distinct from a real `agent` node so judge cost is
 *  attributable and does not distort by-node-type rollups. */
export const EVAL_JUDGE_NODE_TYPE = "evalJudge";

/** Test seam (mirrors __agentDeps): the DB + the judge model call. */
export const __evalDeps = {
  runAgent,
  getDefaultEnvId: getDefaultEnvironmentId,
};

/** One case the batch workflow must run. */
export interface EvalPlanCase {
  name: string;
  /** The trigger payload the child run is started with. */
  input: unknown;
}

export interface EvalPlan {
  workflowKey: string;
  environmentId: string;
  cases: EvalPlanCase[];
}

/**
 * ACTIVITY. Resolve the eval run's dataset into the case list the batch iterates.
 *
 * Deliberately returns the case INPUTS: each one has to become a child workflow argument anyway, so
 * withholding them here would save nothing. Size is bounded at the save gate (`MAX_EVAL_CASES` +
 * the API's body cap), which keeps this payload comfortably inside Temporal's ~2MB limit.
 */
export async function loadEvalPlan(input: {
  tenantId: string;
  evalRunId: string;
}): Promise<EvalPlan> {
  const run = await getPrisma().evalRun.findFirst({
    where: { id: input.evalRunId, tenantId: input.tenantId },
    include: { dataset: true },
  });
  if (!run) {
    throw ApplicationFailure.nonRetryable(
      "Eval run not found",
      "EVAL_RUN_NOT_FOUND",
    );
  }
  const body = parseBody(run.dataset.body);
  return {
    workflowKey: run.workflowKey,
    environmentId: run.environmentId,
    cases: body.cases.map((c) => ({ name: c.name, input: c.input })),
  };
}

/** Parse a stored dataset body, mapping a malformed row to a non-retryable failure (only an author
 *  can fix it — retrying would just burn attempts). */
function parseBody(value: unknown): EvalDatasetBody {
  try {
    return parseEvalDatasetBody(value);
  } catch (e) {
    throw ApplicationFailure.nonRetryable(
      e instanceof Error ? e.message : "Invalid eval dataset",
      "EVAL_DATASET_INVALID",
    );
  }
}

export interface EvaluateEvalCaseInput {
  tenantId: string;
  environmentId?: string;
  evalRunId: string;
  caseName: string;
  /** The case's child-run workflowId, when it started. */
  executionId?: string;
  /** The child run's terminal status ("completed", "rejected", "failed", …). */
  status: string;
  /** The child run's node-output ctx projection (`__*` bookkeeping already stripped). */
  ctx: Record<string, unknown>;
  costUsd?: number;
  latencyMs?: number;
}

export interface EvaluateEvalCaseResult {
  verdict: CaseVerdict;
  score: number;
  /** Case cost INCLUDING any judge spend this activity added. */
  costUsd: number;
}

/**
 * ACTIVITY. Evaluate one case's assertions and persist its verdict.
 *
 * A case whose child run did not COMPLETE is an "error", never a "fail": the workflow never got the
 * chance to produce a wrong answer, and a promote screen that conflated the two would read a broken
 * environment as a quality regression. (This is also what a case that hit the per-case execution
 * timeout looks like — including one that parked on a forced-approval tool gate.)
 */
export async function evaluateEvalCase(
  input: EvaluateEvalCaseInput,
): Promise<EvaluateEvalCaseResult> {
  const run = await getPrisma().evalRun.findFirst({
    where: { id: input.evalRunId, tenantId: input.tenantId },
    include: { dataset: true },
  });
  if (!run) {
    throw ApplicationFailure.nonRetryable(
      "Eval run not found",
      "EVAL_RUN_NOT_FOUND",
    );
  }
  const body = parseBody(run.dataset.body);
  const theCase: EvalCase | undefined = body.cases.find(
    (c) => c.name === input.caseName,
  );
  if (!theCase) {
    throw ApplicationFailure.nonRetryable(
      "Eval case is no longer in the dataset",
      "EVAL_CASE_NOT_FOUND",
    );
  }
  const assertions = assertionsForCase(body, theCase);

  let outcomes: AssertionOutcome[] = [];
  let judgeCostUsd = 0;

  if (input.status !== "completed") {
    // One synthetic outcome so the row still explains itself without carrying run content.
    outcomes = [
      buildPersistableOutcome({
        label: `run:${input.status}`,
        kind: "jsonPathEquals",
        passed: false,
        score: 0,
        error: "missing-path",
      }),
    ];
  } else {
    // A node output can be an OFFLOADED claim-check reference (#479); rehydrate at the activity
    // boundary so an assertion sees the real value rather than `{__claimCheck}`.
    const ctx = containsClaimCheck(input.ctx)
      ? ((await resolveClaimChecks(input.ctx, getObjectStore())) as Record<
          string,
          unknown
        >)
      : input.ctx;

    for (let i = 0; i < assertions.length; i++) {
      const a = assertions[i];
      if (!isLlmJudge(a)) {
        outcomes.push(evaluateDeterministicAssertion(a, ctx, i));
        continue;
      }
      const judged = await runJudge(a, i, ctx, input);
      outcomes.push(judged.outcome);
      judgeCostUsd += judged.costUsd;
    }
  }

  const { verdict, score } = aggregateVerdict(outcomes);
  const costUsd = (input.costUsd ?? 0) + judgeCostUsd;

  // Upsert on (evalRunId, caseName) so a retried activity rewrites the same row instead of
  // duplicating a verdict (the same idempotency shape recordUsage uses).
  await getPrisma().evalCaseResult.upsert({
    where: {
      evalRunId_caseName: {
        evalRunId: input.evalRunId,
        caseName: input.caseName,
      },
    },
    create: {
      evalRunId: input.evalRunId,
      caseName: input.caseName,
      executionId: input.executionId ?? null,
      verdict,
      score: new Prisma.Decimal(score.toFixed(4)),
      costUsd: new Prisma.Decimal(costUsd.toFixed(6)),
      latencyMs: input.latencyMs ?? null,
      // Already allowlisted by buildPersistableOutcome — nothing here carries run/model content.
      assertions: outcomes as unknown as Prisma.InputJsonValue,
    },
    update: {
      executionId: input.executionId ?? null,
      verdict,
      score: new Prisma.Decimal(score.toFixed(4)),
      costUsd: new Prisma.Decimal(costUsd.toFixed(6)),
      latencyMs: input.latencyMs ?? null,
      assertions: outcomes as unknown as Prisma.InputJsonValue,
    },
  });

  log.info(
    {
      activity: "evaluateEvalCase",
      tenantId: input.tenantId,
      evalRunId: input.evalRunId,
      caseName: input.caseName,
      verdict,
      // Numbers + labels only — never the assertion's actual/expected values.
      assertions: outcomes.map((o) => `${o.label}=${o.passed}`),
      costUsd,
    },
    "eval case evaluated",
  );

  return { verdict, score, costUsd };
}

/**
 * The LLM-judge assertion. Runs through `runAgent` — the SAME activity path a real agent node uses —
 * so the judge call gets the in-activity BYOK key fetch, the atomic budget RESERVATION, the pricing
 * table, and the rule-6 fail-safe (a provider that reports no usage is billed an estimate, never
 * zero) for free, with no second copy of that logic to drift (#575 AC3).
 *
 * The judge is asked for a `reason` because a rubric score without reasoning is a worse score — but
 * the reason is READ AND DISCARDED here. It is model prose about run content, so it must not reach
 * Postgres; `judgeOutcome`/`buildPersistableOutcome` cannot carry it even if a caller tried.
 */
async function runJudge(
  assertion: LlmJudgeAssertion,
  index: number,
  ctx: Record<string, unknown>,
  input: EvaluateEvalCaseInput,
): Promise<{ outcome: AssertionOutcome; costUsd: number }> {
  const label = assertionLabel(assertion, index);
  const subject =
    assertion.path === undefined || assertion.path === ""
      ? ctx
      : readPath(ctx, assertion.path);
  const meta: AgentMeta = {
    tenantId: input.tenantId,
    environmentId: input.environmentId,
    // Ledger identity: the EVAL RUN owns the spend, and the (executionId, nodeId) pair must be
    // unique per judge call or recordUsage's `update: {}` upsert would silently collapse two billed
    // calls into one. The assertion INDEX (not the label, which is optional and may repeat across
    // dataset/case levels) guarantees uniqueness within a case.
    executionId: input.evalRunId,
    nodeId: `eval-judge:${input.caseName}:${index}`,
    ledgerNodeType: EVAL_JUDGE_NODE_TYPE,
  };
  try {
    const result = await __evalDeps.runAgent(
      {
        provider: assertion.provider ?? "anthropic",
        model: assertion.model ?? "claude-opus-4-8",
        systemPrompt:
          "You are a strict evaluator. Judge whether the OUTPUT satisfies the CRITERIA. " +
          "Reply with a score from 0 to 1 (1 = fully satisfies), a boolean pass, and a one-sentence reason.",
        outputSchema: {
          type: "object",
          properties: {
            score: { type: "number" },
            pass: { type: "boolean" },
            reason: { type: "string" },
          },
          required: ["score", "pass", "reason"],
          additionalProperties: false,
        },
        temperature: 0,
      },
      { criteria: assertion.criteria, output: subject },
      meta,
    );
    const raw = result.output as { score?: unknown; pass?: unknown };
    const score =
      typeof raw.score === "number" ? raw.score : raw.pass === true ? 1 : 0;
    // NOTE: `raw.reason` is deliberately NOT read past this point.
    return {
      outcome: judgeOutcome(assertion, index, score),
      costUsd: result.costUsd,
    };
  } catch (e) {
    // A judge that cannot run is an assertion ERROR, not a case failure: the workflow's own output
    // was never assessed, and marking it "fail" would report a provider/credential problem as a
    // quality regression. The error CODE is all that is persisted.
    log.warn(
      {
        activity: "evaluateEvalCase",
        tenantId: input.tenantId,
        evalRunId: input.evalRunId,
        caseName: input.caseName,
        assertion: label,
        error: e instanceof Error ? e.message : String(e),
      },
      "llm-judge assertion could not be evaluated",
    );
    return {
      outcome: buildPersistableOutcome({
        label,
        kind: "llmJudge",
        passed: false,
        score: 0,
        error: "judge-unavailable",
      }),
      costUsd: 0,
    };
  }
}

/** Prototype-pollution-safe dotted read (own properties only). */
function readPath(value: unknown, path: string): unknown {
  let cur: unknown = value;
  for (const seg of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

export interface EvalRunSummary {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  costUsd: number;
}

/**
 * ACTIVITY. Aggregate the persisted case rows into the run's summary and close it out.
 *
 * Aggregates FROM THE ROWS rather than from counters the workflow carried: the rows are the record
 * of truth, and a re-run/retried case has already been upserted, so this is idempotent and cannot
 * double-count.
 */
export async function finalizeEvalRun(input: {
  tenantId: string;
  evalRunId: string;
  status?: "completed" | "failed";
}): Promise<EvalRunSummary> {
  const prisma = getPrisma();
  const rows = await prisma.evalCaseResult.findMany({
    where: {
      evalRunId: input.evalRunId,
      evalRun: { tenantId: input.tenantId },
    },
    select: { verdict: true, costUsd: true },
  });
  const summary: EvalRunSummary = {
    total: rows.length,
    passed: rows.filter((r) => r.verdict === "pass").length,
    failed: rows.filter((r) => r.verdict === "fail").length,
    errored: rows.filter((r) => r.verdict === "error").length,
    costUsd: rows.reduce((s, r) => s + Number(r.costUsd ?? 0), 0),
  };
  await prisma.evalRun.updateMany({
    where: { id: input.evalRunId, tenantId: input.tenantId },
    data: {
      status: input.status ?? "completed",
      passed: summary.passed,
      failed: summary.failed,
      errored: summary.errored,
      costUsd: new Prisma.Decimal(summary.costUsd.toFixed(6)),
      finishedAt: new Date(), // clock read → belongs in an activity (Tier-1 rule 2)
    },
  });
  log.info(
    { activity: "finalizeEvalRun", evalRunId: input.evalRunId, ...summary },
    "eval run finalized",
  );
  return summary;
}
