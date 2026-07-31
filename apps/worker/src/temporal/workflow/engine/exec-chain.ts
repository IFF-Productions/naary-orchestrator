// Chain traversal (Phase 2 of the run-graph split — the traversal ENGINE extracted out
// of runGraph, VERBATIM, zero behavior change). Holds execChain: the top-level walk
// (sequential/branch/loop/parallel fan-out), the fan-in merge-join gate, the per-run
// budget gate + pause, the continueAsNew boundary, and — kept INLINE because it is
// tightly interwoven with the walk's return/continue semantics — the items-model
// splitOut region walk (A2 item-major / A3 node-major / A4 per-item sub-DAG).
// DETERMINISTIC TEMPORAL WORKFLOW CODE — CLAUDE.md Tier-1 rules apply: no I/O, no clock,
// no randomness; all side effects via the activity proxies; wf.patched() call sites are
// load-bearing for replay. The ONLY change vs the pre-split body is mechanical: former
// closure `let`s → `engine.state.*`, and shared closures → the `engine` bag (pure
// aliasing + code motion, replay-identical).
import * as wf from "@temporalio/workflow";
import type { ExecutionStatus } from "@naary/contracts";
import {
  getByPath,
  evaluateCondition,
  resolveTemplates,
  nextNodes,
  retryBackoffMs,
  resolveHttpRequest,
  resolveMcpArguments,
  asNodeConfig,
  BATCHABLE_REGION_ACTIVITIES,
  type TraceCell,
  type RegionTrace,
} from "@naary/dsl/dist/workflow"; // deterministic-safe entry (#910)
// Type-only: keeps activity code OUT of the deterministic workflow bundle.
import type * as activities from "../../activities";
import { expandItems, mapNode, offloadCtxEntry } from "../proxies";
import {
  MAX_MAP_BATCH_ITEMS,
  MAX_A4_REGION_ACTIVITY_EXECUTIONS,
  MAX_TRACE_ITEMS,
  containsClaimCheckRef,
  planCtxOffload,
  MAX_TRACE_TOTAL_BYTES,
  isBudgetPauseFailure,
  traceCell,
  nodeErrorMessage,
} from "../helpers";
// The recursive interpreter entry — needed for continueAsNew's `typeof runGraph` and
// the CAN call itself. Circular import, but SAFE: `runGraph` is a hoisted function
// binding referenced only inside this function body (call time), never at module
// top-level — no TDZ.
import { runGraph } from "../run-graph";
import type { Engine } from "./state";

/**
 * Execute a chain from `startId`: run a node, then follow the outgoing edges
 * whose condition passes (Slice #6). 0 next = chain ends; 1 = sequential/branch
 * (incl. a back-edge = loop); >1 = parallel fan-out via Promise.all (declared-
 * edge order; the first terminal in array order stops the whole run). Returns a
 * terminal status, or null when the chain completes normally.
 */
export async function execChain(
  engine: Engine,
  startId: string,
  topLevel: boolean,
): Promise<ExecutionStatus | null> {
  const {
    state,
    ctx,
    runCtx,
    graph,
    nodeById,
    mergeParents,
    itemsRegionBySplit,
    retryRegionByStart,
    metaFor,
  } = engine;
  let current: string | undefined = startId;
  while (current !== undefined) {
    // Circuit breaker + per-execution cap, before the node's work. The circuit
    // breaker now meaningfully bounds intentional LOOPS (closes QA#7).
    state.stepCount++;
    if (
      runCtx.maxStepsPerRun !== undefined &&
      state.stepCount > runCtx.maxStepsPerRun
    ) {
      return "circuit_open";
    }
    // A while (not if): under policy "pause" the run parks and, once resumed with a
    // refreshed cap, re-checks — still over (cap unchanged) parks again, each cycle
    // consuming its own Signal. Non-pause policies short-circuit to the pre-existing
    // terminal BEFORE wf.patched() is ever evaluated (see pauseOnBudget's replay note).
    while (
      runCtx.perExecutionCapUsd !== undefined &&
      state.costUsd >= runCtx.perExecutionCapUsd
    ) {
      if (
        runCtx.onBudgetExceeded !== "pause" ||
        !wf.patched("budget-pause-v1")
      ) {
        return "budget_exceeded";
      }
      await engine.pauseOnBudget();
    }

    const node = nodeById.get(current);
    if (node === undefined) {
      // Dangling edge / unknown node → terminal, not an infinite workflow-task
      // retry (QA#8). The control plane also validates before start.
      return "invalid_graph";
    }
    state.currentNodeId = current;

    /**
     * RETRY REGION (retry…retryEnd): run the bracketed nodes as a UNIT, repeating the whole span
     * until an attempt completes without throwing or the attempts run out.
     *
     * The bracket is DRAWN and was validated at save (computeRetryRegions), so there is no
     * participation inference here — the region is a list, and this is a bounded loop over it.
     * That validation is also what guarantees nothing inside performs an effect a second attempt
     * would repeat; the interpreter does not re-check, exactly as the items region doesn't.
     *
     * Gated by patched() so runs that predate this stay replay-safe. Old graphs have no `retry`
     * node, so they never reach the branch at all.
     */
    if (node.type === "retry" && wf.patched("retry-region-v1")) {
      const region = retryRegionByStart.get(current);
      if (region) {
        const { policy } = region;
        let attempt = 1;
        for (;;) {
          state.stepCount++;
          if (
            runCtx.maxStepsPerRun !== undefined &&
            state.stepCount > runCtx.maxStepsPerRun
          ) {
            return "circuit_open";
          }
          try {
            for (const rid of region.regionNodeIds) {
              state.stepCount++;
              if (
                runCtx.maxStepsPerRun !== undefined &&
                state.stepCount > runCtx.maxStepsPerRun
              ) {
                return "circuit_open";
              }
              const rnode = nodeById.get(rid);
              if (rnode === undefined) return "invalid_graph";
              state.currentNodeId = rid;
              let terminal: ExecutionStatus | null;
              try {
                terminal = await engine.execNode(rnode);
              } catch (err) {
                // A BUDGET PAUSE is not a node error and must not consume an attempt: the run
                // parks until the cap is raised, then re-runs this node. Checked FIRST, exactly as
                // the top-level walk does.
                if (isBudgetPauseFailure(err) && wf.patched("budget-pause-v1")) {
                  await engine.pauseOnBudget();
                  continue; // re-run the SAME node, same attempt
                }
                /**
                 * `onError: "continue"` is handled by exec-chain, NOT by execNode — so calling
                 * execNode directly (as the first version did) silently OVERRODE the author's
                 * per-node instruction: a node explicitly told to continue past its error instead
                 * threw and triggered a retry of the whole region. Review caught it.
                 *
                 * Honoured here the way the top-level walk does: record the error as that node's
                 * output and carry on, so the attempt is not treated as failed. A node the author
                 * marked "continue" is one whose failure is expected and handled downstream —
                 * retrying the region around it would be repeating work to reach the same place.
                 */
                if (rnode.onError !== "continue") throw err;
                ctx[rid] = { error: nodeErrorMessage(err) };
                continue;
              }
              // A RETURNED terminal (rejected / budget_exceeded / circuit_open) is a decision, not
              // a failure — retrying it would ignore what the run just decided. Only a THROW is a
              // failed attempt.
              if (terminal !== null) return terminal;
            }
          } catch (err) {
            if (attempt >= policy.maxAttempts) {
              /**
               * OUT OF ATTEMPTS — rethrow the NODE'S OWN ERROR, never a wrapper.
               *
               * Everything downstream of a failure keys off the real error: `failedNodeId` and the
               * redacted HTTP capture on the run detail, `classifyFailure`, the fix diagnosis, and
               * self-healing's dedupe signature. A "retry exhausted after 3 attempts" wrapper would
               * blind all of it at once, replacing the one thing that says WHAT broke with a
               * statement about how many times we asked.
               */
              throw err;
            }
            attempt++;
            // Record the attempt where the run detail can see it: a step that silently took 40s is
            // indistinguishable from a slow one.
            const attempts = (ctx.__retryAttempts ?? {}) as Record<
              string,
              number
            >;
            attempts[current] = attempt;
            ctx.__retryAttempts = attempts;
            // A DURABLE timer, not a busy wait: a worker restart mid-backoff resumes correctly and
            // a long wait costs nothing while idle.
            const backoff = retryBackoffMs(policy, attempt);
            if (backoff > 0) await wf.sleep(backoff);
            continue;
          }
          break; // the attempt completed without throwing
        }
        // Continue AFTER the closing bracket. `retryEnd` itself is a passthrough with no output.
        state.currentNodeId = region.retryEndId;
        const exits = nextNodes(graph, region.retryEndId, ctx);
        current = exits[0];
        continue;
      }
    }

    // Items model (design ITEMS-MODEL-CURRENT-ITEM.md §0.2): a splitOut runs its LINEAR PURE
    // region once per array element, then hands the collected array to loopEnd. The region is
    // the DRAWN bracket (validated at save), so there is no participation inference here — just a
    // bounded loop over execNode. Gated by patched() so runs that predate this stay replay-safe
    // (old graphs have no splitOut, so they never reach this branch anyway).
    if (node.type === "splitOut" && wf.patched("items-model-v1")) {
      const region = itemsRegionBySplit.get(current);
      if (region) {
        const splitOutId = current; // narrowed to string here (the while-loop guard); stable id
        const splitCfg = asNodeConfig(
          resolveTemplates((node.config ?? {}) as Record<string, unknown>, ctx),
          "splitOut",
        );
        // Items claim-check offload (#479). The upstream array may not be READABLE here: a large
        // http/sql/mcp/code output was offloaded to object storage, so ctx holds a `{__claimCheck}`
        // reference. Before this, that either hard-failed as ITEMS_NOT_ARRAY (reference AT the path)
        // or SILENTLY mapped zero items (reference ABOVE the path → getByPath undefined). Rehydrating
        // is I/O, forbidden in workflow code (Tier-1 rules 2/3), so route it through the expandItems
        // ACTIVITY, which resolves + re-offloads PER ELEMENT and returns references, not blobs.
        //
        // ORDER OF THE THREE CONDITIONS IS LOAD-BEARING:
        //  1. `!Array.isArray(direct)` FIRST. If the path already yields a real array we take the old
        //     path byte-for-byte, even when some OTHER field of the same node output is a reference
        //     (e.g. codeAgent's `{diff: ref, trace: ref, …}`). Without this, a working splitOut over an
        //     inline array would get re-represented as per-element references — silently breaking a
        //     pure region node's `{{ sp.field }}` — or trip ITEMS_SOURCE_TOO_LARGE on a large-but-fine
        //     A2 array. Both target cases still route: a reference AT the path is not an array, and a
        //     reference above it leaves `direct` undefined.
        //  2. The pure ref scan, so the common case never touches the activity.
        //  3. wf.patched() LAST, so it is evaluated only for a source we would actually expand.
        //
        // REPLAY NOTE — deliberately NOT the same argument as the items-model-a4 / loop-fanout gates
        // below (those rely on a pre-patch run never REACHING their marker). A pre-patch run whose
        // source was a reference above the path collected [] and kept going, so a long-parked run CAN
        // replay through here and DOES call this marker. That is safe by the standard mechanism:
        // `patched()` returns false while replaying a history that lacks the marker, so such a run
        // keeps its original zero-item behavior. Condition 1 means a run whose source resolved to a
        // real array never evaluates the marker at all.
        const rawSource = ctx[splitCfg.from];
        const direct = getByPath(rawSource, splitCfg.path); // pure + free; also the old behavior
        const arr =
          !Array.isArray(direct) &&
          containsClaimCheckRef(rawSource) &&
          wf.patched("items-claim-check-v1")
            ? await expandItems(
                { source: rawSource, path: splitCfg.path },
                metaFor(splitOutId),
              )
            : direct;
        // Fail closed on a DEFINED non-array source (a mis-binding) rather than silently mapping
        // 0 times; a missing/null source is a legitimate "no items" → empty region.
        if (arr !== undefined && arr !== null && !Array.isArray(arr)) {
          throw wf.ApplicationFailure.nonRetryable(
            `splitOut '${current}' source is not an array`,
            "ITEMS_NOT_ARRAY",
          );
        }
        const items = Array.isArray(arr) ? arr : [];
        const N = items.length;
        let collected: unknown[] = [];
        let firstIter: Record<string, unknown> | undefined;
        // Per-item trace grid (§0.4.2). Captured ONLY in the per-item in-workflow loops (A4, A2);
        // the A3 node-major branch leaves `traced` false so the run view renders the legible
        // "unavailable for batched-activity regions" message rather than a blank/partial grid.
        // splitOut is column 0 (the input item that drives the branch); then region nodes in topo
        // order. Capture is stepCount-neutral and issues no command — see traceCell / MAX_TRACE_*.
        const traceRows: Record<string, TraceCell>[] = [];
        const traceNodes = [splitOutId, ...region.regionNodeIds];
        let traced = false;
        let a3Unavailable = false; // A3 node-major region → emit the "unavailable" marker instead

        const overBudget = (): boolean =>
          runCtx.maxStepsPerRun !== undefined &&
          state.stepCount > runCtx.maxStepsPerRun;

        // A3 (design §0.3): a region containing a batchable ACTIVITY node runs NODE-major (one
        // mapNode activity per node, N items batched). A PURE-only region keeps A2's exact
        // item-major loop — safe because the graph is content-hash-snapshotted at run start, so an
        // in-flight A2 run's region can never gain an activity and always takes the item-major path.
        const hasActivity = region.regionNodeIds.some((rid) =>
          BATCHABLE_REGION_ACTIVITIES.has(nodeById.get(rid)?.type ?? ""),
        );

        // ORDER IS LOAD-BEARING (replay safety): `kind === "a4"` MUST short-circuit before
        // `patched()`. A pre-A4 run has only linear regions, so it never CALLS this new patched()
        // marker on replay and stays deterministic. Flipping the operands would make every in-flight
        // linear run evaluate a new patched() on replay → nondeterminism. Do not reorder.
        if (region.kind === "a4" && wf.patched("items-model-a4-v1")) {
          // ── A4: PER-ITEM SUB-DAG (design §0.4.1) ──
          // Item-major (branching breaks the A3 batch). For each item, one topological pass with
          // dead-branch propagation: a region node is LIVE iff some in-edge's source is live AND its
          // condition passes; if/switch mark exactly the matched edge live. A `merge` combines only
          // its LIVE inputs. Topo order (from the validator) ⇒ every predecessor's liveness is known
          // before a node is reached, so ONE pass suffices.
          const regionSet = new Set(region.regionNodeIds);
          // Group in-region edges by their target in ONE pass over graph.edges (not a filter per
          // region node) — this runs on the workflow task thread, so keep it O(edges), not O(nodes×edges).
          const inEdgesOf = new Map<string, typeof graph.edges>();
          for (const e of graph.edges) {
            if (
              regionSet.has(e.to) &&
              (e.from === splitOutId || regionSet.has(e.from))
            ) {
              const list = inEdgesOf.get(e.to);
              if (list) list.push(e);
              else inEdgesOf.set(e.to, [e]);
            }
          }
          let activityExecs = 0;
          traced = true;

          for (let i = 0; i < N; i++) {
            state.stepCount++;
            if (overBudget()) return "circuit_open";
            ctx[splitOutId] = items[i];
            const live = new Map<string, boolean>();

            for (const rid of region.regionNodeIds) {
              state.stepCount++;
              if (overBudget()) return "circuit_open";
              const rnode = nodeById.get(rid);
              if (!rnode) return "invalid_graph";
              // LIVE in-edges: source live (splitOut is always live) AND condition passes now.
              const liveIns = (inEdgesOf.get(rid) ?? []).filter((e) => {
                const srcLive =
                  e.from === splitOutId ? true : (live.get(e.from) ?? false);
                return (
                  srcLive &&
                  (!e.condition || evaluateCondition(e.condition, ctx))
                );
              });
              if (liveIns.length === 0) {
                live.set(rid, false);
                ctx[rid] = undefined; // dead this item — no run, no side effect
                continue;
              }
              live.set(rid, true);
              state.currentNodeId = rid;

              if (rnode.type === "merge") {
                // Combine only the LIVE inputs (a dead branch contributes nothing).
                const mode = (rnode.config as { mode?: string } | undefined)
                  ?.mode;
                const inputs = liveIns.map((e) => ctx[e.from]);
                ctx[rid] =
                  mode === "object"
                    ? Object.assign(
                        {},
                        ...inputs.filter(
                          (x) => x !== null && typeof x === "object",
                        ),
                      )
                    : inputs;
                continue;
              }
              if (BATCHABLE_REGION_ACTIVITIES.has(rnode.type)) {
                activityExecs++;
                if (activityExecs > MAX_A4_REGION_ACTIVITY_EXECUTIONS) {
                  throw wf.ApplicationFailure.nonRetryable(
                    `splitOut region '${splitOutId}' ran ${activityExecs} per-item activities over the ${MAX_A4_REGION_ACTIVITY_EXECUTIONS} cap — use forEach for large branching fan-out`,
                    "ITEMS_A4_ACTIVITY_CAP",
                  );
                }
              }
              try {
                const t = await engine.execNode(rnode);
                if (t !== null) return t;
              } catch (err) {
                if (rnode.onError !== "continue") throw err;
                ctx[rid] = { error: nodeErrorMessage(err) };
              }
              // Per-execution budget cap inside the region (like the top-level loop).
              if (
                runCtx.perExecutionCapUsd !== undefined &&
                state.costUsd >= runCtx.perExecutionCapUsd
              ) {
                return "budget_exceeded";
              }
            }
            collected.push(ctx[region.collectFrom]);
            if (i < MAX_TRACE_ITEMS) {
              // Tri-state row from the LIVE map (pure; no command, no stepCount).
              const row: Record<string, TraceCell> = {
                [splitOutId]: traceCell(items[i], true),
              };
              for (const rid of region.regionNodeIds)
                row[rid] = traceCell(ctx[rid], live.get(rid) ?? false);
              traceRows.push(row);
            }
            if (i === 0) {
              firstIter = { [splitOutId]: items[0] };
              for (const rid of region.regionNodeIds) firstIter[rid] = ctx[rid];
            }
          }
        } else if (!hasActivity) {
          // ── ITEM-MAJOR (A2, unchanged) ──
          traced = true;
          for (let i = 0; i < N; i++) {
            state.stepCount++; // the item itself is a step (bounds an empty region over a huge array)
            if (overBudget()) return "circuit_open";
            ctx[current] = items[i]; // the current item — region nodes bind to splitOut to read it
            for (const rid of region.regionNodeIds) {
              state.stepCount++; // count every region-node execution toward the breaker
              if (overBudget()) return "circuit_open";
              const rnode = nodeById.get(rid);
              if (!rnode) return "invalid_graph";
              state.currentNodeId = rid; // attribute a mid-region failure to the actual node
              try {
                const t = await engine.execNode(rnode);
                if (t !== null) return t; // defensive: pure region nodes never return terminal
              } catch (err) {
                if (rnode.onError !== "continue") throw err;
                ctx[rid] = { error: nodeErrorMessage(err) };
              }
            }
            collected.push(ctx[region.collectFrom]);
            if (i < MAX_TRACE_ITEMS) {
              // Linear region: every node ran (live). An onError:"continue" cell shows as err.
              const row: Record<string, TraceCell> = {
                [splitOutId]: traceCell(items[i], true),
              };
              for (const rid of region.regionNodeIds)
                row[rid] = traceCell(ctx[rid], true);
              traceRows.push(row);
            }
            if (i === 0) {
              firstIter = { [current]: items[0] };
              for (const rid of region.regionNodeIds) firstIter[rid] = ctx[rid];
            }
          }
        } else {
          // ── NODE-MAJOR (A3): process each region node fully (all N items) before the next ──
          a3Unavailable = true; // per-item grid isn't built here (would need transposing mapNode)
          const regionOut = new Map<string, unknown[]>();
          regionOut.set(splitOutId, items); // splitOut's per-item output IS the items
          // Set ctx to frame `i` (splitOut + prior region nodes at index i) so pure execNode and
          // the config resolvers read the current item.
          const frameAt = (i: number): void => {
            ctx[splitOutId] = items[i];
            for (const [nid, outs] of regionOut) ctx[nid] = outs[i];
          };
          // The N "item" steps (matches item-major's per-item increment); region-node steps are
          // added per node below.
          state.stepCount += N;
          if (overBudget()) return "circuit_open";
          for (const rid of region.regionNodeIds) {
            state.stepCount += N; // N executions of this node
            if (overBudget()) return "circuit_open";
            const rnode = nodeById.get(rid);
            if (!rnode) return "invalid_graph";
            state.currentNodeId = rid;

            if (BATCHABLE_REGION_ACTIVITIES.has(rnode.type)) {
              // Payload-cap guard: N configs + N outputs ride in history verbatim (see
              // MAX_MAP_BATCH_ITEMS). Fail closed rather than a cryptic history-write failure.
              if (N > MAX_MAP_BATCH_ITEMS) {
                throw wf.ApplicationFailure.nonRetryable(
                  `splitOut region node '${rid}' would batch ${N} items over the ${MAX_MAP_BATCH_ITEMS} cap — chunk upstream or use forEach`,
                  "ITEMS_BATCH_TOO_LARGE",
                );
              }
              if (N === 0) {
                regionOut.set(rid, []); // empty region: no work, no wasted mapNode command
                continue;
              }
              // Resolve each item's activity payload (deterministic, in workflow), then ONE mapNode.
              const mapItems: activities.MapNodeItem[] = [];
              for (let i = 0; i < N; i++) {
                frameAt(i);
                const cfgR = resolveTemplates(
                  (rnode.config ?? {}) as Record<string, unknown>,
                  ctx,
                );
                let cfg: unknown;
                if (rnode.type === "httpRequest") {
                  cfg = resolveHttpRequest(
                    asNodeConfig(cfgR, "httpRequest"),
                    ctx,
                  );
                } else if (rnode.type === "mcpTool") {
                  const m = asNodeConfig(cfgR, "mcpTool");
                  cfg = {
                    connectionId: m.connectionId,
                    tool: m.tool,
                    arguments: resolveMcpArguments(m, ctx),
                    costUsd: m.costUsd,
                  };
                } else {
                  cfg = cfgR; // agent uses its resolved config directly
                }
                mapItems.push({ cfg, input: items[i] }); // input = the current item (frozen §0.3)
              }
              let res: activities.MapNodeResult;
              try {
                res = await mapNode(rnode.type, mapItems, metaFor(rid));
              } catch (err) {
                // An INFRA-level mapNode crash (maxAttempts:1). Respect onError:"continue" like
                // execNode does; else fail the run. (Per-ITEM errors don't throw — see below.)
                if (rnode.onError !== "continue") throw err;
                const msg = nodeErrorMessage(err);
                regionOut.set(
                  rid,
                  Array.from({ length: N }, () => ({ error: msg })),
                );
                continue;
              }
              state.costUsd += res.costUsd; // completed items already billed in-activity (fail-safe)
              ctx.__costUsd = state.costUsd;
              // Enforce the per-execution cap IN the region (like the top-level loop) so a batch
              // that pushes over budget stops the remaining region nodes promptly.
              if (
                runCtx.perExecutionCapUsd !== undefined &&
                state.costUsd >= runCtx.perExecutionCapUsd
              ) {
                return "budget_exceeded";
              }
              regionOut.set(rid, res.outputs);
              const anyError = res.outputs.some(
                (o) =>
                  o !== null &&
                  typeof o === "object" &&
                  "error" in (o as object),
              );
              if (anyError && rnode.onError !== "continue") {
                throw wf.ApplicationFailure.nonRetryable(
                  `mapNode: an item failed in region node '${rid}'`,
                  "ITEMS_MAPNODE_ITEM",
                );
              }
            } else {
              // Pure region node, node-major: run once per item against frame i.
              const outs: unknown[] = [];
              for (let i = 0; i < N; i++) {
                frameAt(i);
                try {
                  const t = await engine.execNode(rnode);
                  if (t !== null) return t;
                } catch (err) {
                  if (rnode.onError !== "continue") throw err;
                  ctx[rid] = { error: nodeErrorMessage(err) };
                }
                outs.push(ctx[rid]);
              }
              regionOut.set(rid, outs);
            }
          }
          collected = regionOut.get(region.collectFrom) ?? [];
          if (N > 0) {
            firstIter = {};
            for (const [nid, outs] of regionOut) firstIter[nid] = outs[0];
          }
        }

        // items-authoritative: leave ctx[regionNode] as the FIRST item's projection (matches the
        // single-item world; an empty array leaves the splitOut/region outputs undefined).
        if (firstIter) {
          for (const k of Object.keys(firstIter)) ctx[k] = firstIter[k];
        } else {
          ctx[current] = undefined;
          for (const rid of region.regionNodeIds) ctx[rid] = undefined;
        }
        ctx[region.loopEndId] = collected; // loopEnd's output IS the collected array
        if (traced || a3Unavailable) {
          // Publish under the `__` bookkeeping namespace (auto-hidden from the node-output list by
          // isNodeOutputKey; surfaced only by the run view's trace grid). Keyed by splitOut so a
          // graph with several regions carries one entry each. PURE — no command. A4/A2 emit the
          // grid; A3 emits the `unavailable` marker so the UI can explain the gap.
          const trace = (ctx.__regionTrace ??= {}) as Record<
            string,
            RegionTrace
          >;
          if (!traced) {
            trace[splitOutId] = { unavailable: "batched" };
          } else {
            const grid: RegionTrace = {
              nodes: traceNodes,
              items: traceRows,
              ...(N > MAX_TRACE_ITEMS
                ? { truncatedItems: N - MAX_TRACE_ITEMS }
                : {}),
            };
            // Aggregate byte cap: a diagnostic must never push the run payload over Temporal's ~2MB
            // and fail an otherwise-healthy run. Measure this grid; if it would exceed the running
            // budget, drop to the `budget` marker (fail closed, visible) rather than growing ctx.
            const gridBytes = JSON.stringify(grid).length;
            if (state.traceBytes + gridBytes > MAX_TRACE_TOTAL_BYTES) {
              trace[splitOutId] = { unavailable: "budget" };
            } else {
              state.traceBytes += gridBytes;
              trace[splitOutId] = grid;
            }
          }
        }
        state.currentNodeId = region.loopEndId;
        const loopExits = nextNodes(graph, region.loopEndId, ctx);
        // Fan-out AFTER a loop (#477): loopEnd → N successors, each fed loopEnd's collected array.
        // ORDER IS LOAD-BEARING (replay safety): `loopExits.length > 1` MUST short-circuit before
        // `patched()`. A pre-patch run's graph was forced to ≤1 loopEnd exit by the old validator, so
        // `length > 1` is always false for it ⇒ it never CALLS this new patched() marker on replay and
        // stays deterministic (mirrors the A4 ordering rule above). Do not reorder the operands. The
        // fan-out mirrors the top-level branch fan-out (below): each successor runs to its own terminal
        // concurrently; branches are NOT top-level (no mid-flight continueAsNew).
        if (loopExits.length > 1 && wf.patched("loop-fanout-v1")) {
          const results = await Promise.all(
            loopExits.map((nx) => engine.execChain(nx, false)),
          );
          for (const r of results) if (r !== null) return r; // array (edge) order
          return null;
        }
        current = loopExits[0]; // linear exit → single next (undefined = end)
        continue;
      }
    }

    // Fan-in join gate (Slice N5): when a branch reaches a merge, record its
    // arrival; if not all inbound branches are in yet, ABSORB this branch (stop
    // here — a sibling will complete the join). Only the LAST arrival falls
    // through to run the merge + continue downstream, so the merge and everything
    // after it execute exactly once. (Determinism: arrival order under the
    // Promise.all fan-out is fixed by microtask/activity-completion order, which
    // Temporal replays identically.)
    if (node.type === "merge") {
      const expected = mergeParents.get(current)?.length ?? 0;
      const arrived = (state.mergeArrivals[current] ?? 0) + 1;
      state.mergeArrivals[current] = arrived;
      if (arrived < expected) return null;
    }

    // Per-node error policy (n8n's "On Error"). "continue" catches a node failure,
    // records `{ error }` as its output, and proceeds so the graph can branch on
    // `<nodeId>.error`; "stop" (default) rethrows to fail the run (the workflow-level
    // error handler, if bound, then fires). The catch is deterministic — Temporal
    // records the activity failure in history and replays it identically. costUsd
    // accumulated before the failure is kept (already metered).
    let terminal: ExecutionStatus | null;
    for (;;) {
      try {
        terminal = await engine.execNode(node);
      } catch (err) {
        // Budget pause-not-fail (Slice 3): the agent activity threw BUDGET_PAUSE —
        // the tenant's LIVE-read monthly-cap policy is "pause" — so park the run and
        // RETRY the same node after the resume Signal (the fresh reservation then
        // re-checks against the raised cap / new month). Checked BEFORE onError:
        // "continue" — a policy pause is not a node error. isBudgetPauseFailure is
        // pure; old histories never contain the marker, and the new commands sit
        // behind the same budget-pause-v1 gate as the per-run-cap path.
        if (isBudgetPauseFailure(err) && wf.patched("budget-pause-v1")) {
          await engine.pauseOnBudget();
          continue; // retry the SAME node
        }
        if (node.onError !== "continue") throw err;
        ctx[node.id] = { error: nodeErrorMessage(err) };
        terminal = null;
      }
      break;
    }
    if (terminal !== null) return terminal;

    const nexts = nextNodes(graph, current, ctx);
    if (nexts.length <= 1) {
      current = nexts[0]; // sequential / branch / loop back-edge (undefined = end)

      // Bound history growth on long loops (Slice #6): at a safe single-next
      // boundary in the top-level chain (no pending approval, no in-flight
      // handler), continueAsNew carrying the state so the run resumes intact.
      const cap = runCtx.continueAsNewAfterSteps;
      const shouldContinue =
        wf.workflowInfo().continueAsNewSuggested ||
        (cap !== undefined && state.stepCount >= cap);
      if (
        topLevel &&
        current !== undefined &&
        shouldContinue &&
        wf.allHandlersFinished() &&
        // SIGNAL DURABILITY (#681). Originally an un-consumed approval Signal BLOCKED the boundary
        // (the signal lived only in EngineState, so continuing would drop it) — at the cost of a run
        // that received a stray/duplicate decision never continuing again, i.e. the unbounded history
        // this whole mechanism exists to prevent. It is now CARRIED instead (see ResumeState).
        // ORDER IS LOAD-BEARING (replay safety): `state.approval === undefined` — true on every
        // ordinary boundary — MUST short-circuit before patched(), so a normal run never records the
        // marker and its history is byte-identical to before. The marker is only ever reached in the
        // one case that would diverge (a boundary WITH a pending signal), where a replaying pre-#681
        // history correctly gets `false` and keeps its original "don't continue" decision.
        (state.approval === undefined || wf.patched("can-carry-signals-v1"))
      ) {
        // Claim-check the snapshot if `ctx` would push the continueAsNew payload past Temporal's ~2MB
        // cap (#681). PURE plan first, activity second — and `plan.length > 0` MUST short-circuit
        // before patched() for the same replay reason as above: an ordinary (small-ctx) run never
        // reaches the marker, so its history keeps exactly the commands it had. Only a run whose ctx
        // is genuinely over budget takes the new path — and before #681 such a run did not continue
        // successfully at all, it failed on the payload cap.
        let carried = ctx;
        const plan = planCtxOffload(ctx);
        if (plan.length > 0 && wf.patched("can-claim-check-v1")) {
          carried = { ...ctx };
          for (const key of plan) {
            // Sequential (not Promise.all): one object-store PUT each, and the plan is deliberately
            // the SMALLEST set that fits the budget, so this is a handful of calls at most.
            carried[key] = await offloadCtxEntry(
              { value: carried[key] },
              metaFor(key),
            );
          }
          // Visible marker (node ids only — never their content) so the run detail / support can tell
          // "this output is a reference because the run continued as new", not "it vanished".
          const already = Array.isArray(carried.__offloaded)
            ? (carried.__offloaded as string[])
            : [];
          carried.__offloaded = [
            ...already,
            ...plan.filter((k) => !already.includes(k)),
          ];
        }
        await wf.continueAsNew<typeof runGraph>(graph, engine.input, runCtx, {
          ctx: carried,
          costUsd: state.costUsd,
          stepCount: state.stepCount,
          startNodeId: current,
          mergeArrivals: state.mergeArrivals,
          // Pending/produced signal state — data-only additions to the continueAsNew PAYLOAD (no new,
          // removed or reordered command), and the recomputed payload is discarded on replay anyway:
          // the continued run reads its args from its OWN WorkflowExecutionStarted event. So these
          // need no patched() gate of their own; each is conditional purely to keep an ordinary
          // snapshot's shape unchanged.
          ...(state.approval !== undefined ? { approval: state.approval } : {}),
          ...(state.webhookResume !== undefined
            ? { webhookResume: state.webhookResume }
            : {}),
          ...(state.webhookResponse !== undefined
            ? { webhookResponse: state.webhookResponse }
            : {}),
        });
      }
    } else {
      // Parallel fan-out: each branch runs to its own terminal concurrently.
      // Cost/steps are commutative accumulations + Temporal replays activity
      // completion order deterministically, so the shared state stays
      // replay-safe. The per-exec cap can be overshot by a bounded amount across
      // concurrent branches (same class as the documented monthly-cap overshoot).
      // Branches are NOT top-level → they don't continueAsNew mid-flight.
      const results = await Promise.all(
        nexts.map((n) => engine.execChain(n, false)),
      );
      for (const r of results) if (r !== null) return r; // array (edge) order
      return null;
    }
  }
  return null;
}
