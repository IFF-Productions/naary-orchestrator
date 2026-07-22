// The generic graph interpreter. runGraph now does SETUP + ORCHESTRATION only; the
// traversal ENGINE (execNode/execChain + the items-model region walk) lives under
// ./engine/*, moved VERBATIM in Phase 2 of the run-graph split (zero behavior change —
// the former closure `let`s became one shared `EngineState` object threaded via the
// `Engine` bag; pure aliasing + code motion, replay-identical).
// DETERMINISTIC TEMPORAL WORKFLOW CODE — CLAUDE.md Tier-1 rules apply: no I/O, no clock,
// no randomness; all side effects via the activity proxies; secrets never enter
// workflow args/history; wf.patched() call sites are load-bearing for replay.
import * as wf from "@temporalio/workflow";
import {
  approvalSignal,
  budgetResumeSignal,
  resumeSignal,
  stateQuery,
  webhookResponseQuery,
} from "@naary/contracts";
import type { ExecutionState } from "@naary/contracts";
import { computeItemsRegions, type ItemsRegion } from "@naary/dsl";
import type { GraphDef, NodeDef } from "@naary/dsl";
// Type-only: keeps activity code OUT of the deterministic workflow bundle.
// Do NOT drop `type` — that would pull I/O code into the sandbox.
import type * as activities from "../activities";
import {
  recordExecution,
  loadVariables,
  setExecutionStatus,
  resolveSubWorkflowGraph,
  refreshBudget,
  sendNotification,
} from "./proxies";
import { classifyFailure } from "./helpers";
import type { RunGraphResult, RunGraphCtx, ResumeState } from "./types";
// The traversal engine (Phase 2 run-graph split), extracted VERBATIM behind the
// `Engine` bag. execNode/execChain reference each other, so they are wired as bag
// fields; everything they need comes from the bag — no closure captures from runGraph.
import type { Engine, EngineState } from "./engine/state";
import { execNode } from "./engine/node-exec";
import { execChain } from "./engine/exec-chain";

/**
 * The generic interpreter: one workflow walks graph DATA (CLAUDE.md Tier-1
 * rule 1 — interpreter, not codegen). Deterministic — all side effects go
 * through activities; the human-approval pause is a Signal + condition(), never
 * a poll or sleep-loop (rules 2–5).
 */
export async function runGraph(
  graph: GraphDef,
  input: unknown,
  runCtx: RunGraphCtx,
  resume?: ResumeState,
): Promise<RunGraphResult> {
  // On a continueAsNew restart, seed state from the carried snapshot. In single-node test mode,
  // seed ctx with the target's upstream outputs (from pins) so only the target executes.
  const ctx: Record<string, unknown> = resume
    ? { ...resume.ctx }
    : { __input: input, ...(runCtx.seededCtx ?? {}) };

  // Fan-in join state (Slice N5). `mergeParents` maps a merge node id → its inbound
  // parents' ids in DECLARED edge order (its length is the expected in-degree);
  // precomputed once from the graph (deterministic, pure). Only nodes of type "merge"
  // participate, so other multi-inbound nodes (e.g. loop back-edges) keep their
  // existing behavior.
  const nodeById = new Map<string, NodeDef>(graph.nodes.map((n) => [n.id, n]));
  // Graph node-id set — lets the unresolved-input diagnostic tell "source ran but was empty"
  // (a real node) from "source doesn't exist" (a typo/deleted node). Pure + precomputed once.
  const nodeIdSet = new Set(nodeById.keys());

  // Single source of truth for every activity's `meta` — ALL activity calls use this so a run's
  // environmentId (Slice 5b) reaches EVERY env-scoped secret/cred read uniformly (a missed call site
  // would silently read the default env's creds). environmentId is undefined for a pre-5b run (its
  // ctx predates the field) → the activity falls back to the tenant default (byte-identical). Data-only
  // threading — no new/removed/reordered command, so replay-safe WITHOUT patched(); and it rides
  // continueAsNew because runCtx is re-passed whole.
  const metaFor = (nodeId: string): activities.AgentMeta => ({
    tenantId: runCtx.tenantId,
    environmentId: runCtx.environmentId,
    executionId: wf.workflowInfo().workflowId,
    nodeId,
  });

  // Items model (design ITEMS-MODEL-CURRENT-ITEM.md): precompute the splitOut→region map. Pure +
  // deterministic (same source of truth the save-gate validates), so computing it never affects
  // history; the per-item EXECUTION is what's gated by patched() below.
  const itemsRegionBySplit = new Map<string, ItemsRegion>();
  const a4RegionMergeIds = new Set<string>();
  for (const r of computeItemsRegions(graph).regions) {
    itemsRegionBySplit.set(r.splitOutId, r);
    // A merge INSIDE an A4 region is owned by that region's per-item pass, NOT the top-level fan-in
    // walker — so it must not participate in mergeParents/stranded-join. (Pre-A4 graphs have no region
    // merge, so this set is empty for them and the top-level behavior is byte-identical.)
    if (r.kind === "a4") {
      for (const id of r.regionNodeIds) {
        if (nodeById.get(id)?.type === "merge") a4RegionMergeIds.add(id);
      }
    }
  }

  const mergeParents = new Map<string, string[]>();
  for (const n of graph.nodes) {
    if (n.type === "merge" && !a4RegionMergeIds.has(n.id)) {
      mergeParents.set(
        n.id,
        graph.edges.filter((e) => e.to === n.id).map((e) => e.from),
      );
    }
  }

  // The run's shared mutable state — one object replaces the former closure `let`s
  // (costUsd/status/approval/…). Seeded from the continueAsNew/resume snapshot where
  // applicable. `mergeArrivals` counts how many inbound branches have reached each
  // merge so far — the last to arrive runs it (carried across CAN so a mid-join resume
  // keeps its counts; spread, not aliased, so the snapshot is never mutated in place).
  // Enforcement state (costUsd/stepCount) is driven ONLY by activity-returned costs and
  // a node counter — never a DB read in workflow code (CLAUDE.md rule 2; §3). budgetResumeCount
  // is a MONOTONIC counter, not a flag — several parallel branches can park on budget
  // simultaneously, and one budgetResume Signal must wake ALL of them.
  const state: EngineState = {
    costUsd: resume?.costUsd ?? 0,
    stepCount: resume?.stepCount ?? 0,
    // Running total of per-item trace bytes across ALL regions this segment (§0.4.2 aggregate cap). Not
    // carried across CAN — each segment re-budgets against its own fresh regions.
    traceBytes: 0,
    budgetResumeCount: 0,
    status: "running",
    currentNodeId: resume?.startNodeId ?? graph.startNodeId,
    mergeArrivals: resume?.mergeArrivals ? { ...resume.mergeArrivals } : {},
  };

  wf.setHandler(approvalSignal, (s) => {
    state.approval = s;
  });
  wf.setHandler(resumeSignal, (s) => {
    state.webhookResume = s;
  });
  // Registering a handler issues no command (replay-safe without patched()); only runs
  // that actually PARK receive this signal — the API targets awaiting_budget rows only.
  wf.setHandler(budgetResumeSignal, () => {
    state.budgetResumeCount++;
  });
  wf.setHandler(stateQuery, (): ExecutionState => ({
    status: state.status,
    currentNodeId: state.currentNodeId,
    ctx,
    // Live run spend (Slice 3): the deterministic cost accumulator + the per-run cap
    // this run enforces. Query-handler-only data — queries never write history.
    spentUsd: state.costUsd,
    ...(runCtx.perExecutionCapUsd !== undefined
      ? { perExecutionCapUsd: runCtx.perExecutionCapUsd }
      : {}),
  }));
  wf.setHandler(webhookResponseQuery, () => state.webhookResponse);

  // Register run ownership so this run shows in the Runs list + is tenant-authorized
  // — covers SCHEDULED runs (started by Temporal, with no API-side record). Only on
  // first start (not continueAsNew). Behind a patched() gate so in-flight runs that
  // predate this change don't hit a nondeterminism error on replay (CLAUDE.md:
  // version interpreter changes with workflow.patched()).
  if (!resume && !runCtx.test && wf.patched("record-execution-v1")) {
    await recordExecution({
      workflowId: wf.workflowInfo().workflowId,
      tenantId: runCtx.tenantId,
      environmentId: runCtx.environmentId, // tag the run with its env (Slice 6)
      workflowKey: runCtx.workflowKey,
      graphVersion: runCtx.graphVersion,
    });
  }

  // Global Variables ($vars): seed the run's env-scoped non-secret config into ctx as DATA, so string
  // expressions can read `{{ $vars.KEY }}` (resolved by the same getByPath the rest of the template
  // engine uses — no resolver change). ONE PG read via an activity (I/O → activity, Tier-1 #3); the
  // workflow only threads the returned map. Behind a patched() gate so in-flight runs predating this
  // stay replay-safe (CLAUDE.md: version interpreter changes with patched()). Only on first start —
  // a continueAsNew/resume already carries $vars inside its ctx snapshot, so re-loading would be both
  // redundant and a nondeterminism risk (the DB may have changed mid-run). NOT secrets (Tier-1 #4).
  if (!resume && wf.patched("load-variables-v1")) {
    ctx.$vars = await loadVariables({
      tenantId: runCtx.tenantId,
      environmentId: runCtx.environmentId,
    });
  }

  // Push the current status + cost to the Execution read-model so the Runs list is
  // a single PG read (no per-run Temporal calls). Gated by patched() so in-flight
  // runs that predate this change stay replay-safe.
  async function syncStatus(): Promise<void> {
    if (runCtx.test) return; // test mode: never touch the Runs read-model
    if (wf.patched("exec-status-v1")) {
      await setExecutionStatus({
        workflowId: wf.workflowInfo().workflowId,
        status: state.status,
        costUsd: state.costUsd,
      });
    }
  }

  /**
   * Budget pause-not-fail (redesign Slice 3): park the run as `awaiting_budget` on a
   * durable condition() until a `budgetResume` Signal (cap raise via PUT /tenants/:id/
   * budget, or the month-rollover boot reconcile) — Signal + condition per Tier-1 rule 5,
   * never a poll. On resume, RE-READ the tenant's caps/policy in-activity (the PUT that
   * woke us likely raised the per-run cap; without the re-read a per-run-cap pause would
   * re-park forever against its stale snapshot) and mutate them into runCtx so they also
   * ride any later continueAsNew (runCtx is re-passed whole).
   *
   * REPLAY SAFETY: every call site is doubly gated — the live/snapshot policy value must
   * be "pause" (a value no pre-Slice-3 run ever produced or snapshotted) AND
   * wf.patched("budget-pause-v1") (the slice-1-style staged-deploy guard: histories
   * recorded by this path fail FAST on a pre-Slice-3 worker instead of silently
   * diverging; old histories replay the legacy terminal/thrown path byte-identically).
   */
  async function pauseOnBudget(): Promise<void> {
    const seen = state.budgetResumeCount;
    state.status = "awaiting_budget";
    await syncStatus(); // surface the pause in the Runs list (+ stamps budgetPausedAt)
    await wf.condition(() => state.budgetResumeCount > seen);
    const fresh = await refreshBudget({ tenantId: runCtx.tenantId });
    if (fresh) {
      runCtx.perExecutionCapUsd = fresh.perExecutionCapUsd;
      if (
        fresh.onBudgetExceeded === "reject" ||
        fresh.onBudgetExceeded === "downgrade" ||
        fresh.onBudgetExceeded === "pause"
      ) {
        runCtx.onBudgetExceeded = fresh.onBudgetExceeded;
      }
    }
    state.status = "running";
    await syncStatus();
  }

  // The engine "bag": everything the extracted execNode/execChain need comes from here
  // (no closure captures). execNode/execChain reference each other, so they are wired as
  // fields — each call site inside the engine does `engine.execNode(…)`/`engine.execChain(…)`.
  // syncStatus/pauseOnBudget stay DEFINED here (they touch the setExecutionStatus/refreshBudget
  // proxies + runCtx) and are passed in as callbacks.
  const engine: Engine = {
    state,
    ctx,
    input,
    runCtx,
    graph,
    nodeById,
    nodeIdSet,
    mergeParents,
    itemsRegionBySplit,
    a4RegionMergeIds,
    metaFor,
    syncStatus,
    pauseOnBudget,
    execNode: (node) => execNode(engine, node),
    execChain: (startId, topLevel) => execChain(engine, startId, topLevel),
  };

  // Wrap the walk so BOTH failure surfaces are observable in one place: a RETURNED
  // terminal status (rejected/budget_exceeded/circuit_open/invalid_graph) and a
  // THROWN ApplicationFailure (stopAndError, non-retryable activity errors) that
  // would otherwise escape runGraph entirely.
  let threw: unknown;
  try {
    const terminal = await engine.execChain(state.currentNodeId, true);
    state.status = terminal ?? "completed";

    // Fail LOUD on a stranded fan-in join (Slice N5): if a merge received SOME but
    // not all of its inbound branches, the join never fired and everything after it
    // was silently skipped — reporting "completed" would look like success while
    // having done nothing. This happens when a conditional path UPSTREAM of a merge
    // branch prevents that branch from arriving (validateGraph only blocks conditional
    // edges DIRECTLY into a merge). Surface it as a terminal invalid_graph instead of
    // a clean completion. (Only overrides a would-be success — a real terminal status
    // from the run itself wins.)
    if (terminal === null) {
      for (const [mergeId, parents] of mergeParents) {
        const arrived = state.mergeArrivals[mergeId] ?? 0;
        if (arrived > 0 && arrived < parents.length) {
          state.status = "invalid_graph";
          break;
        }
      }
    }
  } catch (e) {
    // Framework control-flow signals are NOT app failures and must propagate
    // untouched: continueAsNew (a long run unwinding to resume — the CAN call lives
    // inside execChain) and cancellation. Catching either would fire the handler +
    // issue commands mid-unwind (determinism hazard).
    if (e instanceof wf.ContinueAsNew || wf.isCancellation(e)) throw e;
    threw = e;
  }

  // On failure, start the tenant's error-handler graph (if bound) as a DETACHED child
  // — ParentClosePolicy.ABANDON so it survives THIS run failing. Loop-guarded
  // (a handler run never fires its own handler) and patched so in-flight runs that
  // predate this don't diverge on replay. A missing handler / start failure must
  // never mask the original error.
  const isFailure =
    threw !== undefined ||
    state.status === "rejected" ||
    state.status === "budget_exceeded" ||
    state.status === "circuit_open" ||
    state.status === "invalid_graph";
  // Notify the tenant (best-effort) that a run failed — same swallow + patch gate as
  // the approval notification. Skipped for error-handler runs (they ARE the response).
  if (isFailure && !runCtx.isErrorHandler && wf.patched("notify-v1")) {
    try {
      await sendNotification({
        tenantId: runCtx.tenantId,
        environmentId: runCtx.environmentId,
        kind: "run_failed",
        workflowId: wf.workflowInfo().workflowId,
        workflowKey: runCtx.workflowKey,
        detail: threw !== undefined ? "failed" : state.status,
      });
    } catch {
      /* best-effort — a notification problem must not mask the failure */
    }
  }
  if (
    isFailure &&
    runCtx.errorWorkflowKey &&
    !runCtx.isErrorHandler &&
    wf.patched("onerror-handler-v1")
  ) {
    try {
      const handler = await resolveSubWorkflowGraph({
        tenantId: runCtx.tenantId,
        environmentId: runCtx.environmentId,
        workflowKey: runCtx.errorWorkflowKey,
      });
      const parentId = wf.workflowInfo().workflowId;
      const errorPayload = {
        failedWorkflowId: parentId,
        workflowKey: runCtx.workflowKey,
        status: threw !== undefined ? "failed" : state.status,
        error:
          threw !== undefined
            ? {
                message: threw instanceof Error ? threw.message : String(threw),
                type:
                  threw instanceof wf.ApplicationFailure
                    ? threw.type
                    : undefined,
              }
            : undefined,
      };
      await wf.startChild(runGraph, {
        workflowId: `${parentId}-onerror`,
        parentClosePolicy: wf.ParentClosePolicy.ABANDON,
        args: [
          handler.graph,
          errorPayload,
          {
            tenantId: runCtx.tenantId,
            // The error handler runs in the FAILED run's env (5b) — a sandbox failure's handler
            // uses sandbox creds/connections.
            environmentId: runCtx.environmentId,
            workflowKey: runCtx.errorWorkflowKey,
            isErrorHandler: true,
            graphContentHash: handler.contentHash,
            graphVersion: handler.version,
          } satisfies RunGraphCtx,
        ],
      });
    } catch {
      // swallow — never mask the original failure with a handler problem
    }
  }

  if (threw !== undefined) {
    // Slice 2: the run is about to FAIL at the Temporal level (rethrow below), a path
    // that never reached syncStatus — so its Execution row stayed non-terminal and the
    // list had to reconcile via describe(). Push the terminal read-model row (status
    // "failed" + finishedAt in-activity + the failureKind classified from the failure
    // Temporal already recorded — classifyFailure is pure/deterministic over replayed
    // data). NEW COMMAND → gated by patched() so in-flight runs replay unchanged;
    // best-effort so a read-model hiccup can never mask the original failure.
    if (!runCtx.test && wf.patched("exec-fail-v1")) {
      try {
        await setExecutionStatus({
          workflowId: wf.workflowInfo().workflowId,
          status: "failed",
          costUsd: state.costUsd,
          failureKind: classifyFailure(threw),
          // Run-detail recovery (#525): a thrown run's ctx isn't queryable after close, so
          // record the node it died on + the node ids that had already produced output. Node
          // ids only, never their ctx output content (privacy checklist). Prefer the EXACT
          // throwing node (state.failedNodeId — captured at the node that threw, race-safe
          // across concurrent branches); fall back to currentNodeId for throws that originate
          // outside a node (e.g. a stranded merge / invalid-graph terminal).
          failedNodeId: state.failedNodeId ?? state.currentNodeId,
          executedNodeIds: graph.nodes
            .filter((n) => n.id in ctx)
            .map((n) => n.id),
        });
      } catch {
        /* best-effort — never mask the original failure */
      }
    }
    throw threw; // preserve FAILED semantics
  }
  await syncStatus(); // final status + cost for the Runs list
  // Distinguish "no respondToWebhook ran" (undefined) from "ran with an empty body" (null), so the
  // durable chat session can tell a no-reply turn from a real empty reply — mirrors the ingress's
  // `response.body ?? null`. Undefined ⇒ no synchronous reply at all.
  return {
    status: state.status,
    ctx,
    reply: state.webhookResponse
      ? (state.webhookResponse.body ?? null)
      : undefined,
    // RAG citations (issue #482) ride the reply — set at the respondToWebhook moment (node-exec),
    // so a durable chat-session child reads "Sources" straight off RunGraphResult.
    ...(state.webhookResponse?.citations
      ? { citations: state.webhookResponse.citations }
      : {}),
  };
}
