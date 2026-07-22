// Per-node execution (Phase 2 of the run-graph split — the traversal ENGINE extracted
// out of runGraph, VERBATIM, zero behavior change). Holds the per-node timing wrapper
// (execNode) and the control-flow switch (execNodeInner): the 7 cases that touch engine
// state / return terminal statuses — merge, executeSubWorkflow, forEach, wait,
// stopAndError, respondToWebhook, humanApproval — plus the NODE_HANDLERS leaf dispatch.
// DETERMINISTIC TEMPORAL WORKFLOW CODE — CLAUDE.md Tier-1 rules apply: no I/O, no clock,
// no randomness; all side effects via the activity proxies; secrets never enter
// history; wf.patched() call sites are load-bearing for replay. The ONLY change vs the
// pre-split body is mechanical: former closure `let`s → `engine.state.*`, and shared
// closures → the `engine` bag (pure aliasing + code motion, replay-identical).
import * as wf from "@temporalio/workflow";
import { APPROVAL_CTX_KEY, NODE_TIMES_CTX_KEY } from "@naary/contracts";
import type { ExecutionStatus, NodeTimeEntry } from "@naary/contracts";
import {
  getByPath,
  resolveTemplates,
  collectUnresolved,
  resolveSubWorkflowInput,
  resolveWebhookResponse,
  collectCitations,
  asNodeConfig,
  type UnresolvedRef,
} from "@naary/dsl";
import type { ApprovalNodeConfig, NodeDef, NodeOutputMap } from "@naary/dsl";
// Type-only: keeps activity code OUT of the deterministic workflow bundle.
import type * as activities from "../../activities";
// Pure fan-out policy (no side effects) — safe to import into workflow code.
import { FOREACH_CONCURRENCY, perChildCap } from "../../foreach-cap";
import {
  resolveSubWorkflowGraph,
  prepareApproval,
  sendNotification,
} from "../proxies";
import { MAX_SUBWORKFLOW_DEPTH, MAX_FOREACH_ITEMS } from "../helpers";
// Leaf node handlers, extracted VERBATIM behind a registry (Phase 1 run-graph split).
import { NODE_HANDLERS } from "../node-handlers";
// The recursive interpreter entry (executeSubWorkflow/forEach launch child runGraphs).
// Circular import, but SAFE: `runGraph` is a hoisted function binding referenced only
// inside these function bodies (call time), never at module top-level — no TDZ.
import { runGraph } from "../run-graph";
import type { RunGraphCtx } from "../types";
import type { Engine } from "./state";

/**
 * Per-node timing (REDESIGN-FUNCTIONALITY-GAPS.md Slice 2): stamp every executed
 * node's start/finish into a small ctx map, then delegate to {@link execNodeInner}.
 *
 * DETERMINISM JUSTIFICATION (the required Tier-1 rule-2 analysis): the timestamps
 * come from the Temporal TS sandbox's `Date.now()`, which is NOT a wall-clock read —
 * the workflow sandbox overrides `Date` so `Date.now()` returns WORKFLOW TIME (the
 * current workflow task's recorded timestamp; see @temporalio/workflow
 * global-overrides + interfaces.d.ts "The safe version of time is `new Date()` and
 * `Date.now()`"). It is the TS SDK's equivalent of `workflow.now()`: on replay it is
 * re-read from history event timestamps and yields byte-identical values. We chose
 * this over echoing timestamps FROM each activity because (a) it covers PURE nodes
 * (set/filter/if/…) that run with no activity at all, (b) it needs no result-shape
 * change across ~30 activities, and (c) it issues NO Temporal command — a plain ctx
 * write — so in-flight runs started before this code replay the exact same command
 * sequence with no patched() gate (same argument as __regionTrace/__unresolved).
 * Granularity is the workflow task: an activity node's window spans scheduling →
 * completion (≈ real latency); a pure node executes within one task and may show 0ms
 * — honest, not fabricated.
 *
 * BOUNDED: keyed by nodeId (≤ graph size), 2–4 numbers per entry. A re-executed node
 * (loop back-edge / items region) keeps the LAST window in s/f and aggregates
 * n/totalMs across passes — the map never grows with iteration count.
 */
export async function execNode(
  engine: Engine,
  node: NodeDef,
): Promise<ExecutionStatus | null> {
  const { ctx, state } = engine;
  const s = Date.now(); // deterministic workflow time (see justification above)
  try {
    return await execNodeInner(engine, node);
  } catch (e) {
    // Record the ACTUAL throwing node (#525 fan-out fix). First-writer-wins (`??=`) so that,
    // across concurrent fan-out branches, the node that threw FIRST is the one attributed —
    // not whichever sibling last wrote the shared `currentNodeId`. Deterministic: Temporal
    // replays activity completion order, so the same branch throws first on replay.
    //
    // SKIP an `onError: "continue"` node: exec-chain catches ITS throw (outside execNode) and
    // proceeds, writing `{error}` to ctx — a non-fatal error that must not be attributed as the
    // run's failure. A node that will actually propagate ("stop"/default) is the only real
    // failure site. (Framework signals also land here but are inert: run-graph gates the stamp
    // on `threw`. Rare non-continue propagations that bypass this — a budget pause — leave it
    // unset and fall back to currentNodeId, which is correct on the sequential path they take.)
    if (node.onError !== "continue") state.failedNodeId ??= node.id;
    throw e;
  } finally {
    const f = Date.now();
    const times = (ctx[NODE_TIMES_CTX_KEY] ??= {}) as Record<
      string,
      NodeTimeEntry
    >;
    const prev = times[node.id];
    times[node.id] =
      prev === undefined
        ? { s, f }
        : {
            s,
            f,
            n: (prev.n ?? 1) + 1,
            totalMs:
              (prev.totalMs ?? Math.max(0, prev.f - prev.s)) +
              Math.max(0, f - s),
          };
  }
}

/** Run one node's side effect. Returns a TERMINAL status to stop the whole run
 *  (rejected), or null to continue. Mutates engine.ctx / engine.state via the bag. */
async function execNodeInner(
  engine: Engine,
  node: NodeDef,
): Promise<ExecutionStatus | null> {
  const { state, ctx, runCtx, metaFor, mergeParents, nodeIdSet, syncStatus } =
    engine;
  // Template-lite expressions: resolve any `{{ nodeId.path }}` in string config against ctx
  // BEFORE the node runs (pure + deterministic — design docs/design/EXPRESSIONS.md).
  const cfg = resolveTemplates(
    (node.config ?? {}) as Record<string, unknown>,
    ctx,
  );
  // Diagnose inputs (tokens + bindings) whose SOURCE produced no output — so an empty/failed
  // node names WHICH source was missing on the run detail. Pure + deterministic (getByPath over
  // ctx), issues NO Temporal command → replay-safe by construction, like __regionTrace (needs no
  // patched()). Keyed by node id so a re-run in a loop overwrites rather than piling up.
  const missing = collectUnresolved(node, ctx, nodeIdSet);
  if (missing.length > 0) {
    const diag = (ctx.__unresolved ??= {}) as Record<string, UnresolvedRef[]>;
    diag[node.id] = missing;
  } else if (ctx.__unresolved && typeof ctx.__unresolved === "object") {
    // A prior pass (loop re-run) may have flagged this node — clear it, and drop the
    // whole key when nothing remains so a fully-resolved run's ctx is byte-identical.
    const diag = ctx.__unresolved as Record<string, UnresolvedRef[]>;
    delete diag[node.id];
    if (Object.keys(diag).length === 0) delete ctx.__unresolved;
  }
  // Leaf dispatch (Phase 1 run-graph split): pure transforms + simple activity
  // calls live in the registry, extracted VERBATIM. Cost-bearing handlers return a
  // `costUsd` delta; a `!== undefined` guard reproduces the original's unconditional
  // `ctx.__costUsd = costUsd` write (a void handler leaves it untouched, exactly as
  // the non-cost cases did). Control-flow cases fall through to the switch below.
  const handler = NODE_HANDLERS[node.type];
  if (handler) {
    const r = await handler({ node, cfg, ctx, runCtx, metaFor });
    if (r && r.costUsd !== undefined) {
      state.costUsd += r.costUsd;
      ctx.__costUsd = state.costUsd;
    }
    return null;
  }
  switch (node.type) {
    case "merge": {
      // Fan-in join. Only REACHED here on the LAST inbound arrival (execChain
      // absorbs earlier ones), so all inbound parents have run — combine their
      // outputs from ctx. Pure: no I/O, no cost. `<mergeId>` holds the combined
      // value; downstream reads `<mergeId>.0`/`.1` (array) or fields (object).
      const mergeCfg = asNodeConfig(cfg, "merge");
      const parents = mergeParents.get(node.id) ?? [];
      const inputs = parents.map((p) => ctx[p]);
      ctx[node.id] =
        mergeCfg.mode === "object"
          ? Object.assign(
              {},
              ...inputs.filter((i) => i !== null && typeof i === "object"),
            )
          : inputs;
      return null;
    }
    case "executeSubWorkflow": {
      const subCfg = asNodeConfig(cfg, "executeSubWorkflow");
      // Recursion guard FIRST — never launch below the nesting cap (a graph that
      // calls itself would otherwise recurse forever). Reuses the circuit-breaker
      // terminal status (same "runaway protection tripped" intent).
      const depth = runCtx.subWorkflowDepth ?? 0;
      if (depth >= MAX_SUBWORKFLOW_DEPTH) return "circuit_open";

      // Resolve the child input deterministically (pure ctx path-reads). When the
      // node configures no input, forward the parent's own trigger input.
      const childInput = resolveSubWorkflowInput(subCfg, ctx) ?? ctx.__input;

      // Fetch + version-snapshot the child graph IN the activity (I/O). Pinning
      // the hash/version means a later edit to the child can't alter this run.
      const snapshot = await resolveSubWorkflowGraph({
        tenantId: runCtx.tenantId,
        environmentId: runCtx.environmentId,
        workflowKey: subCfg.workflowKey,
      });

      // Launch the child as a durable child workflow (deterministic). The id is
      // deterministic (+stepCount so a looped node spawns distinct children).
      // Default ParentClosePolicy is TERMINATE — the child dies with the parent.
      // The child records its own Execution row (recordExecution), so it appears
      // as its own run in the Runs list. Budget: the child gets the parent's
      // REMAINING per-execution cap; its cost is metered back below.
      const result = await wf.executeChild(runGraph, {
        workflowId: `${wf.workflowInfo().workflowId}-sub-${node.id}-${state.stepCount}`,
        args: [
          snapshot.graph,
          childInput,
          {
            tenantId: runCtx.tenantId,
            // Child runs in the PARENT's env (Slice 5b) — a sandbox parent's sub-workflow uses
            // sandbox creds/connections, not the default env.
            environmentId: runCtx.environmentId,
            workflowKey: subCfg.workflowKey,
            perExecutionCapUsd:
              runCtx.perExecutionCapUsd !== undefined
                ? Math.max(0, runCtx.perExecutionCapUsd - state.costUsd)
                : undefined,
            maxStepsPerRun: runCtx.maxStepsPerRun,
            graphContentHash: snapshot.contentHash,
            graphVersion: snapshot.version,
            subWorkflowDepth: depth + 1,
          } satisfies RunGraphCtx,
        ],
      });

      // Meter child spend into the parent budget (commutative sum, like agent/
      // mcp/http).
      const childCost =
        typeof result.ctx.__costUsd === "number" ? result.ctx.__costUsd : 0;
      state.costUsd += childCost;
      ctx.__costUsd = state.costUsd;

      // Expose a BOUNDED projection so the parent graph can branch on
      // `<nodeId>.status` and read child node outputs via `<nodeId>.output.*`.
      // We deliberately do NOT copy the child's whole ctx verbatim: drop the
      // internal `__*` bookkeeping (`__input` duplicates the input we passed;
      // `__costUsd` is already metered above). Each child node output is
      // individually claim-checked (≤1MB) upstream, and the depth cap bounds
      // nesting, so this payload — which rides in parent history / the
      // continueAsNew snapshot — stays bounded (CLAUDE.md: pass refs, not blobs).
      const output: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(result.ctx)) {
        if (!k.startsWith("__")) output[k] = v;
      }
      ctx[node.id] = {
        status: result.status,
        output,
      } satisfies NodeOutputMap["executeSubWorkflow"];
      return null;
    }
    case "forEach": {
      // Map an array by running a saved graph once per item as a durable child
      // run. Same machinery as executeSubWorkflow, looped: depth guard + item cap
      // bound the fan-out; children run concurrently; results stay in item order.
      const feCfg = asNodeConfig(cfg, "forEach");
      const depth = runCtx.subWorkflowDepth ?? 0;
      if (depth >= MAX_SUBWORKFLOW_DEPTH) return "circuit_open";

      const raw = getByPath(ctx[feCfg.from], feCfg.path);
      const items = Array.isArray(raw) ? raw : [];
      if (items.length === 0) {
        ctx[node.id] = [];
        return null;
      }
      // Explicit runaway guard — never fan out past the cap (no silent truncation).
      if (items.length > MAX_FOREACH_ITEMS) return "circuit_open";

      // Resolve the child graph ONCE (same workflowKey for every item), then launch
      // one child per item with the item as its input.
      const snapshot = await resolveSubWorkflowGraph({
        tenantId: runCtx.tenantId,
        environmentId: runCtx.environmentId,
        workflowKey: feCfg.workflowKey,
      });
      const parentId = wf.workflowInfo().workflowId;

      // A child that throws (a stopAndError node or a non-retryable activity error)
      // becomes a failed ENTRY rather than a rejected Promise.all that kills the
      // whole batch (child failure ≠ parent crash; a RETURNED terminal status
      // already resolves normally). Catching a deterministic rejection is replay-safe.
      // A completed child's cost folds into the parent (commutative sum) and its
      // bounded {status, output} projection is collected in ARRAY ORDER, so the graph
      // can branch on `<nodeId>.N.status` without the batch dying.
      if (wf.patched("foreach-chunked-cap-v1")) {
        // Bounded concurrency window + per-window cap divisor (audit A-3/Q-3): run
        // items in chunks of FOREACH_CONCURRENCY so at most that many child runs are
        // in flight at once, and split the remaining cap across each chunk's children
        // so their concurrent spends can't sum past it. The running `costUsd` carried
        // between chunks means an expensive early chunk can legitimately starve later
        // ones (their childCap → 0 ⇒ those children fail on budget) — the aggregate
        // never exceeds the cap, which is the rule-6 fail-safe, NOT a bug.
        const collected: {
          status: string;
          output: Record<string, unknown>;
        }[] = [];
        for (
          let start = 0;
          start < items.length;
          start += FOREACH_CONCURRENCY
        ) {
          const chunk = items.slice(start, start + FOREACH_CONCURRENCY);
          const childCap =
            runCtx.perExecutionCapUsd !== undefined
              ? perChildCap(
                  runCtx.perExecutionCapUsd - state.costUsd,
                  chunk.length,
                )
              : undefined;
          const settled = await Promise.all(
            chunk.map((item, j) =>
              wf
                .executeChild(runGraph, {
                  // Global index (start + j) — a chunk-local index would collide
                  // workflowIds across chunks.
                  workflowId: `${parentId}-foreach-${node.id}-${state.stepCount}-${start + j}`,
                  args: [
                    snapshot.graph,
                    item,
                    {
                      tenantId: runCtx.tenantId,
                      environmentId: runCtx.environmentId, // child inherits the parent's env (5b)
                      workflowKey: feCfg.workflowKey,
                      perExecutionCapUsd: childCap,
                      maxStepsPerRun: runCtx.maxStepsPerRun,
                      graphContentHash: snapshot.contentHash,
                      graphVersion: snapshot.version,
                      subWorkflowDepth: depth + 1,
                    } satisfies RunGraphCtx,
                  ],
                })
                .then((r) => ({ ok: true as const, r }))
                .catch(() => ({ ok: false as const })),
            ),
          );
          for (const s of settled) {
            if (!s.ok) {
              collected.push({ status: "failed", output: {} });
              continue;
            }
            const r = s.r;
            state.costUsd +=
              typeof r.ctx.__costUsd === "number" ? r.ctx.__costUsd : 0;
            const output: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(r.ctx)) {
              if (!k.startsWith("__")) output[k] = v;
            }
            collected.push({ status: r.status as string, output });
          }
        }
        ctx.__costUsd = state.costUsd;
        ctx[node.id] = collected;
        return null;
      }

      // LEGACY path (runs started before the patch): single fan-out, one shared cap
      // snapshot. Kept byte-identical so in-flight runs replay without nondeterminism.
      const childCap =
        runCtx.perExecutionCapUsd !== undefined
          ? Math.max(0, runCtx.perExecutionCapUsd - state.costUsd)
          : undefined;

      const settled = await Promise.all(
        items.map((item, i) =>
          wf
            .executeChild(runGraph, {
              workflowId: `${parentId}-foreach-${node.id}-${state.stepCount}-${i}`,
              args: [
                snapshot.graph,
                item,
                {
                  tenantId: runCtx.tenantId,
                  environmentId: runCtx.environmentId, // child inherits the parent's env (5b)
                  workflowKey: feCfg.workflowKey,
                  perExecutionCapUsd: childCap,
                  maxStepsPerRun: runCtx.maxStepsPerRun,
                  graphContentHash: snapshot.contentHash,
                  graphVersion: snapshot.version,
                  subWorkflowDepth: depth + 1,
                } satisfies RunGraphCtx,
              ],
            })
            .then((r) => ({ ok: true as const, r }))
            .catch(() => ({ ok: false as const })),
        ),
      );

      const collected = settled.map((s) => {
        if (!s.ok) return { status: "failed", output: {} };
        const r = s.r;
        state.costUsd +=
          typeof r.ctx.__costUsd === "number" ? r.ctx.__costUsd : 0;
        const output: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(r.ctx)) {
          if (!k.startsWith("__")) output[k] = v;
        }
        return { status: r.status as string, output };
      });
      ctx.__costUsd = state.costUsd;
      ctx[node.id] = collected;
      return null;
    }
    case "wait": {
      const waitCfg = asNodeConfig(cfg, "wait");
      if (waitCfg.mode === "webhook") {
        // Durable pause until an external system resumes the run (Signal + condition(),
        // exactly like humanApproval — no polling, survives crashes/days). An optional
        // durable timer auto-continues after timeoutSeconds so a stuck run isn't wedged.
        state.status = "awaiting_webhook";
        await syncStatus(); // surface the pause in the Runs list
        const timeoutMs =
          typeof waitCfg.timeoutSeconds === "number" &&
          waitCfg.timeoutSeconds > 0
            ? waitCfg.timeoutSeconds * 1000
            : undefined;
        let resumed = true;
        if (timeoutMs !== undefined) {
          resumed = await wf.condition(
            () => state.webhookResume !== undefined,
            timeoutMs,
          );
        } else {
          await wf.condition(() => state.webhookResume !== undefined);
        }
        state.status = "running";
        // Durable, branchable output: <nodeId>.resumed / .timedOut / .payload.
        ctx[node.id] = {
          resumed,
          timedOut: !resumed,
          payload: resumed ? (state.webhookResume?.payload ?? null) : null,
        };
        state.webhookResume = undefined; // consume so a later loop iteration can pause again
        return null;
      }
      // Durable delay via a Temporal timer — survives crashes, costs nothing
      // while waiting, and replays deterministically (no wall-clock, no
      // sleep-loop). Skip a non-positive duration so the node just passes through.
      const secs = waitCfg.durationSeconds ?? 0;
      if (secs > 0) await wf.sleep(secs * 1000);
      return null;
    }
    case "stopAndError": {
      // Terminal failure: throw a non-retryable ApplicationFailure so the run
      // ends as FAILED (surfaced in the Runs list + timeline) rather than
      // burning Temporal task retries. The message is static, non-secret text.
      const errCfg = asNodeConfig(cfg, "stopAndError");
      throw wf.ApplicationFailure.nonRetryable(
        errCfg.message && errCfg.message.trim()
          ? errCfg.message
          : "Workflow stopped by a Stop and Error node",
        "STOP_AND_ERROR",
      );
    }
    case "respondToWebhook": {
      // Pure node: set the response the webhook ingress returns synchronously,
      // then CONTINUE (respond fast, keep working). The response is exposed via
      // webhookResponseQuery, which the ingress polls.
      const rwCfg = asNodeConfig(cfg, "respondToWebhook");
      state.webhookResponse = resolveWebhookResponse(rwCfg, ctx);
      // Attach RAG citations (issue #482) so the hosted chat can show "Sources". Pure graph+ctx
      // read (no command, no I/O) → replay-safe without patched(), like the __regionTrace/timing
      // ctx writes. Only set when a vectorQuery matched — a plain webhook/chat stays citation-free,
      // and the webhook ingress ignores this field regardless (it returns only body/status/headers).
      const citations = collectCitations(engine.graph, ctx);
      if (citations.length > 0) state.webhookResponse.citations = citations;
      ctx[node.id] = {
        statusCode: state.webhookResponse.statusCode,
      } satisfies NodeOutputMap["respondToWebhook"];
      return null;
    }
    case "humanApproval": {
      state.status = "awaiting_approval";
      await syncStatus(); // surface the pause in the Runs list / approval queue
      const gateCfg = (cfg ?? {}) as ApprovalNodeConfig;
      // ---- Approval routing + SLA/escalation (REDESIGN-FUNCTIONALITY-GAPS.md Slice 1) ----
      // REPLAY INVARIANT (two layers): every NEW command below (prepareApproval, the
      // segmented timer loop, reminder/escalation notifications) is gated on
      // (a) the PRESENCE of the Slice-1 config fields — so plain gates take the exact
      //     pre-existing command sequence — AND
      // (b) a patched() marker (PR #424 review): in a staged deploy the API/web can save
      //     graphs WITH these fields while runs still start on an OLD worker; those
      //     histories lack the new commands, so the updated worker must replay them on
      //     the legacy path. patched() returns false for such histories and records the
      //     marker for new runs (CLAUDE.md: version interpreter changes with patched()).
      const hasSlice1Meta =
        gateCfg.approvers !== undefined ||
        gateCfg.slaHours !== undefined ||
        gateCfg.contextFields !== undefined ||
        (gateCfg.remindAfterHours?.length ?? 0) > 0 ||
        gateCfg.escalateAfterHours !== undefined;
      const slice1Active =
        hasSlice1Meta && wf.patched("approval-routing-sla-v1");
      if (slice1Active) {
        // Pause-side awaiting snapshot via an ACTIVITY: contextFields expression eval,
        // approver group-name read, and the pausedAt clock stamp are side effects
        // (Tier-1 rules 2/3); `$secrets` refs stay literal inside prepareApproval, so
        // secrets can never enter this record / history (rule 4). The returned DATA is
        // stored under the reserved __approval ctx key, where the API's stateQuery
        // reads it (inbox rows, decide-time enforcement, public prompt).
        const snapshot: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(ctx)) {
          if (!k.startsWith("__")) snapshot[k] = v;
        }
        ctx[APPROVAL_CTX_KEY] = await prepareApproval({
          tenantId: runCtx.tenantId,
          nodeId: node.id,
          config: {
            approvers: gateCfg.approvers,
            slaHours: gateCfg.slaHours,
            remindAfterHours: gateCfg.remindAfterHours,
            escalateAfterHours: gateCfg.escalateAfterHours,
            escalateTo: gateCfg.escalateTo,
            contextFields: gateCfg.contextFields,
          },
          ctx: snapshot,
        });
      }
      // Notify the tenant (best-effort) that a decision is needed — a HITL pause can
      // last days, so don't rely on someone watching the inbox. Gated + swallowed so
      // it can never affect the run. Patched so in-flight runs don't diverge on replay.
      if (wf.patched("notify-v1") && !runCtx.isErrorHandler) {
        try {
          await sendNotification({
            tenantId: runCtx.tenantId,
            environmentId: runCtx.environmentId,
            kind: "approval_pending",
            workflowId: wf.workflowInfo().workflowId,
            workflowKey: runCtx.workflowKey,
            title: gateCfg.title,
          });
        } catch {
          /* best-effort — never block the pause on a notification */
        }
      }
      // Optional auto-reject timeout (durable Temporal timer; deterministic).
      const timeoutMs =
        typeof gateCfg.timeoutHours === "number" && gateCfg.timeoutHours > 0
          ? gateCfg.timeoutHours * 3_600_000
          : undefined;
      // Reminder/escalation schedule — a PURE derivation of the immutable config
      // snapshot (offsets in ms, sorted ascending; a same-offset reminder fires before
      // the escalation via the stable sort), so the timer sequence replays identically.
      // Offsets at/after the auto-reject timeout can never fire and are dropped.
      const gateTimers: {
        atMs: number;
        flavor: "reminder" | "escalation";
        index?: number;
      }[] = [];
      (gateCfg.remindAfterHours ?? []).forEach((h, i) => {
        if (typeof h === "number" && h > 0) {
          gateTimers.push({
            atMs: h * 3_600_000,
            flavor: "reminder",
            index: i + 1,
          });
        }
      });
      if (
        typeof gateCfg.escalateAfterHours === "number" &&
        gateCfg.escalateAfterHours > 0
      ) {
        gateTimers.push({
          atMs: gateCfg.escalateAfterHours * 3_600_000,
          flavor: "escalation",
        });
      }
      gateTimers.sort((a, b) => a.atMs - b.atMs);
      const schedule = gateTimers.filter(
        (t) => timeoutMs === undefined || t.atMs < timeoutMs,
      );

      let decided = true;
      if (schedule.length === 0) {
        // Pre-existing durable wait — byte-identical commands for old graphs (see the
        // replay invariant above).
        if (timeoutMs !== undefined) {
          // condition(fn, timeout) → true if signalled, false if it timed out.
          decided = await wf.condition(
            () => state.approval !== undefined,
            timeoutMs,
          );
        } else {
          await wf.condition(() => state.approval !== undefined); // wait forever
        }
      } else {
        // Segmented durable wait: condition() up to each reminder/escalation offset
        // (durable Temporal timers — no clock reads in workflow code), firing the
        // notification ACTIVITY on each elapse, then the remaining auto-reject window
        // (or wait forever). A decision signal at any point exits the loop.
        let elapsedMs = 0;
        for (const t of schedule) {
          const deltaMs = t.atMs - elapsedMs;
          const signalled =
            deltaMs > 0
              ? await wf.condition(() => state.approval !== undefined, deltaMs)
              : state.approval !== undefined;
          if (signalled) break;
          elapsedMs = t.atMs;
          // Same error-handler gate as the initial pause notification (an error-handler
          // run never pages) — deterministic (runCtx is workflow-args data).
          if (!runCtx.isErrorHandler) {
            try {
              await sendNotification({
                tenantId: runCtx.tenantId,
                environmentId: runCtx.environmentId,
                kind: "approval_pending",
                workflowId: wf.workflowInfo().workflowId,
                workflowKey: runCtx.workflowKey,
                title: gateCfg.title,
                flavor: t.flavor,
                ...(t.flavor === "reminder" ? { reminderIndex: t.index } : {}),
                ...(t.flavor === "escalation" && gateCfg.escalateTo
                  ? { escalateTo: gateCfg.escalateTo }
                  : {}),
              });
            } catch {
              /* best-effort — a notification must never affect the pause */
            }
          }
        }
        if (state.approval === undefined) {
          if (timeoutMs !== undefined) {
            decided = await wf.condition(
              () => state.approval !== undefined,
              timeoutMs - elapsedMs,
            );
          } else {
            await wf.condition(() => state.approval !== undefined); // wait forever
          }
        }
      }
      state.status = "running";
      // The gate is no longer pending — drop the awaiting record so a later loop
      // iteration pauses fresh (plain ctx write: no command, replay-safe).
      if (slice1Active) delete ctx[APPROVAL_CTX_KEY];
      // Record the decision + reason on the node's output so it's durable, visible
      // in the run, and branchable downstream (<nodeId>.approved / .comment). A ctx
      // write is in-workflow state — no new command, so it stays replay-safe.
      if (!decided) {
        ctx[node.id] = {
          approved: false,
          comment: "Auto-rejected: no decision before the timeout.",
        };
        return "rejected"; // timed out → auto-reject
      }
      ctx[node.id] = {
        approved: state.approval!.approved,
        comment: state.approval!.comment ?? null,
      };
      if (!state.approval!.approved) return "rejected";
      state.approval = undefined; // consume so a later loop iteration can pause again
      return null;
    }
  }
  return null;
}
