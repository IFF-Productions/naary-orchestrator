// Workflow evals (#575) — the BATCH workflow. One eval run is an ordinary Temporal execution that
// launches one CHILD `runGraph` per golden case, then has an activity score it.
//
// DETERMINISTIC TEMPORAL WORKFLOW CODE (CLAUDE.md Tier-1): no I/O, no wall clock, no randomness. The
// dataset read, every assertion (zod schema compilation + the LLM judge), and the result writes all
// live in activities. Cases are iterated by INDEX over the activity-returned array, and the child
// workflow ids are derived from the eval-run id + index, so a replay issues the identical command
// sequence. `Date.now()` is the Temporal sandbox's WORKFLOW time (see the justification in
// engine/node-exec.ts), which is why per-case latency can be measured here.
import * as wf from "@temporalio/workflow";
import type { GraphDef } from "@naary/dsl";
// Type-only: keeps activity code OUT of the deterministic bundle.
import type * as activities from "../activities";
// The interpreter entry each case runs. Same import shape node-exec.ts uses.
import { runGraph } from "./run-graph";
import type { RunGraphCtx } from "./types";

/**
 * How many cases run at once. Bounded for the same reason forEach's fan-out is: a 200-case dataset
 * launching 200 concurrent child runs would swamp the worker pool and the tenant's provider rate
 * limits, and would make the per-case cap arithmetic meaningless.
 */
export const EVAL_CONCURRENCY = 4;

/**
 * Wall-clock ceiling for ONE case's child run, enforced by Temporal as the child's
 * workflowExecutionTimeout. Without it a case that parks — most realistically on a forced-approval
 * tool gate (#576), which waits forever by design — would hang the whole batch. A timed-out child
 * surfaces as an "error" verdict, which is the honest reading: the graph never produced an answer to
 * judge.
 */
export const EVAL_CASE_TIMEOUT_MS = 15 * 60 * 1000;

export interface EvalRunInput {
  tenantId: string;
  environmentId: string;
  workflowKey: string;
  /** The `EvalRun` row this execution reports into (also the ledger identity for judge spend). */
  evalRunId: string;
  /** The VERSION-PINNED graph snapshot every case runs — resolved by the API at start, exactly like
   *  a normal run, so an edit to the GRAPH mid-batch cannot change what was measured.
   *
   *  NOTE, precisely: the DATASET is not pinned. `evaluateEvalCase` re-reads the dataset body per
   *  case, so editing assertions while a batch is in flight can score later cases against a
   *  different rubric, and renaming a case makes it unscoreable (its scoring is skipped and the
   *  batch continues). Pinning the body would mean threading it through every case's activity
   *  arguments; the graph — the thing under test — is what must be immutable. */
  graph: GraphDef;
  graphContentHash: string;
  graphVersion: number;
  /** Per-case budget cap, threaded to each child (each case gets its own allowance). */
  perExecutionCapUsd?: number;
  maxStepsPerRun?: number;
}

export type EvalRunResult = activities.EvalRunSummary;

// Read-only DB work; idempotent, so the shared retry shape is right.
const { loadEvalPlan, finalizeEvalRun } = wf.proxyActivities<typeof activities>(
  {
    startToCloseTimeout: "1 minute",
    retry: { maximumAttempts: 3 },
  },
);

/**
 * Case scoring is AT-MOST-ONCE (maximumAttempts: 1) for exactly the reason `runAgentTooled` is
 * (see proxies.ts): it can make up to MAX_ASSERTIONS_PER_CASE sequential LLM-JUDGE calls, and a
 * retry re-runs the WHOLE activity — replaying every judge call already made. Those are real
 * provider calls, and `recordUsage` is first-write-wins on (executionId, nodeId), so a second
 * attempt would SPEND money and record nothing: a silently-free call, which Tier-1 rule 6 forbids.
 * The long start-to-close covers a case with many judge assertions; the caller catches a failure
 * per case so one unscored case cannot take the batch down.
 */
const { evaluateEvalCase } = wf.proxyActivities<typeof activities>({
  startToCloseTimeout: "30 minutes",
  retry: { maximumAttempts: 1 },
});

/**
 * Run a golden dataset against a pinned graph version and record a verdict per case.
 *
 * REGISTERED WORKFLOW: exported from ./../workflows.ts, which is the Temporal bundle entry — the
 * name "evalRun" is the registration name the API starts.
 */
export async function evalRun(input: EvalRunInput): Promise<EvalRunResult> {
  try {
    return await runBatch(input);
  } catch (e) {
    // The row must never be left saying `running` forever with `finishedAt: null` — that is
    // indistinguishable from a batch still in progress. Close it out as FAILED, then rethrow so the
    // execution itself is still recorded as failed. Best-effort: if the close-out also fails, the
    // original error is what matters.
    await finalizeEvalRun({
      tenantId: input.tenantId,
      evalRunId: input.evalRunId,
      status: "failed",
    }).catch(() => undefined);
    throw e;
  }
}

async function runBatch(input: EvalRunInput): Promise<EvalRunResult> {
  const plan = await loadEvalPlan({
    tenantId: input.tenantId,
    evalRunId: input.evalRunId,
  });

  // Each case is an independent run of the SAME pinned snapshot. `test: false` (i.e. absent) on
  // purpose: an eval must exercise the real interpreter, real activities and real spend — a mocked
  // eval would measure nothing. Cases DO record their own Execution rows, so they are visible and
  // drillable in the Runs list, which is what the per-case drill-down needs.
  const childCtx = (): RunGraphCtx => ({
    tenantId: input.tenantId,
    environmentId: input.environmentId,
    workflowKey: input.workflowKey,
    graphContentHash: input.graphContentHash,
    graphVersion: input.graphVersion,
    perExecutionCapUsd: input.perExecutionCapUsd,
    maxStepsPerRun: input.maxStepsPerRun,
  });

  for (let start = 0; start < plan.cases.length; start += EVAL_CONCURRENCY) {
    const chunk = plan.cases.slice(start, start + EVAL_CONCURRENCY);
    await Promise.all(
      chunk.map(async (c, j) => {
        const index = start + j;
        const childId = `${input.evalRunId}-case-${index}`;
        const startedAt = Date.now(); // workflow time — deterministic on replay
        // A child that FAILS (a stopAndError, a non-retryable activity error, the execution
        // timeout) becomes an error VERDICT rather than a rejected Promise.all that kills the whole
        // batch. Catching a deterministic rejection is replay-safe (same argument as forEach).
        const settled = await wf
          .executeChild(runGraph, {
            workflowId: childId,
            workflowExecutionTimeout: EVAL_CASE_TIMEOUT_MS,
            args: [input.graph, c.input, childCtx()],
          })
          .then((r) => ({ ok: true as const, r }))
          .catch(() => ({ ok: false as const }));
        const latencyMs = Math.max(0, Date.now() - startedAt);

        // Bounded projection of the child's node outputs — the same shape executeSubWorkflow
        // exposes: drop the `__*` bookkeeping (the cost is read separately below), keep node
        // outputs so assertions can address `agent.output.category`.
        const ctx: Record<string, unknown> = {};
        let costUsd: number | undefined;
        if (settled.ok) {
          for (const [k, v] of Object.entries(settled.r.ctx)) {
            if (!k.startsWith("__")) ctx[k] = v;
          }
          costUsd =
            typeof settled.r.ctx.__costUsd === "number"
              ? settled.r.ctx.__costUsd
              : 0;
        }

        // A SCORING failure is isolated per case too (at-most-once, so there is no retry to fall
        // back on): a case whose assertions could not be evaluated — its judge exhausted the
        // activity deadline, or the case was renamed out of the dataset mid-batch — must not take
        // the other 199 cases with it. It simply has no result row, so `finalizeEvalRun`'s
        // row-derived `total` comes out below `EvalRun.totalCases`, which is an honest signal that
        // the batch is incomplete rather than a fabricated verdict.
        await evaluateEvalCase({
          tenantId: input.tenantId,
          environmentId: input.environmentId,
          evalRunId: input.evalRunId,
          caseName: c.name,
          executionId: childId,
          status: settled.ok ? settled.r.status : "failed",
          ctx,
          costUsd,
          latencyMs,
        }).catch(() => undefined);
      }),
    );
  }

  return await finalizeEvalRun({
    tenantId: input.tenantId,
    evalRunId: input.evalRunId,
    status: "completed",
  });
}
