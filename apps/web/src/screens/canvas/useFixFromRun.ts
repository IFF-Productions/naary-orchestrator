/**
 * `?fix=<runId>` — arrive at the canvas from a FAILED run with the failure already written up as
 * a change request for the AI panel.
 *
 * The alternative is what people do today: read the error on the run detail, navigate to the
 * canvas, and re-describe in prose a failure they were just looking at. Everything needed is
 * already on the run — the error, the node that died, the redacted call it made, the outputs it
 * read — so the description writes itself.
 *
 * TWO THINGS IT DELIBERATELY DOES NOT DO.
 *
 * It does not auto-generate. The instruction is PREFILLED and the panel opened; the user reads
 * what the model is about to be told about their run, and presses Generate themselves. Sending a
 * tenant's run data to a model is not something to do on a navigation.
 *
 * It does not edit the run's pinned snapshot. The fix targets the workflow's CURRENT version,
 * because that is what a save writes and what later runs will use. When the run executed an older
 * version, `drift` says so — the diagnosis may name a node that has since changed, and quietly
 * diffing against a version nobody is running would be worse than saying it plainly.
 */
import { useEffect, useRef, useState } from "react";
import { buildFixInstruction, type GraphDef } from "@naary/dsl";
import { api } from "../../lib/api";
import { historyTimes } from "../app/run-detail/run-view-model";

export interface FixFromRun {
  /** Versions differ — the run ran an older graph than the one now on the canvas. */
  drift: { runVersion: number; currentVersion: number } | null;
  /** Whose outputs were included, so the UI can state exactly what is being sent. */
  includedNodeIds: string[];
  /** Why no instruction could be built (run gone, no failed node, …). */
  error: string | null;
}

/** What the fetch produced. Kept apart from `drift`, which also depends on live canvas state. */
interface FetchedFix {
  runVersion: number | null;
  includedNodeIds: string[];
  error: string | null;
}

/**
 * Could the run's step outputs be READ — as distinct from the run having produced none?
 *
 * This conflation has now had to be fixed twice: once inside `buildFixInstruction`, which grew a
 * `ctxAvailable` flag precisely so the caller answers it honestly, and once here, where the first
 * version answered it with `Object.keys(ctx).length > 0` and so called every genuinely-empty run
 * unreadable.
 *
 * An empty ctx means the read FAILED only when the read model says steps actually ran.
 * `executedNodeIds` is non-empty exactly when `queryState` fell back to that stamp because it
 * could not recover the ctx (#525) — so empty ctx + steps stamped = we lost it, while empty ctx +
 * nothing stamped = a run that failed on its first step and legitimately produced nothing.
 */
export function ctxWasReadable(
  ctx: Record<string, unknown> | undefined,
  executedNodeIds: string[] | undefined,
): boolean {
  if (Object.keys(ctx ?? {}).length > 0) return true;
  return (executedNodeIds?.length ?? 0) === 0;
}

/**
 * Did the run execute a different version from the one now on the canvas?
 *
 * Exported and pure because getting it from the wrong place is a silent failure: computed inside
 * the fetch effect it would close over `currentVersion` from the FIRST render — null, because the
 * workflow is still loading — and the warning would simply never appear. Nothing would look
 * broken; the user would just be told nothing on the one path where the fix may not fit.
 *
 * Null on either side means "no comparison to make": an unsaved draft has no version, and a run
 * from before version tracking has none either. Neither is drift.
 */
export function driftBetween(
  runVersion: number | null,
  currentVersion: number | null,
): { runVersion: number; currentVersion: number } | null {
  if (runVersion == null || currentVersion == null) return null;
  if (runVersion === currentVersion) return null;
  return { runVersion, currentVersion };
}

/**
 * Builds the instruction once per `?fix=` run and hands it to the AI panel.
 *
 * `currentVersion` is the version the canvas has LOADED (null on an unsaved draft) — used only to
 * report drift, never to choose what to edit.
 *
 * DRIFT IS DERIVED AT RENDER, not captured in the effect. The effect must be free to re-run as
 * the canvas loads (it waits for `currentGraph`), while a `builtFor` ref stops it rebuilding over
 * a prompt the user has begun editing. Anything the effect closed over would therefore be a value
 * from an early render — `currentVersion` still null, the workflow still loading — and drift would
 * never fire, which is the one case the banner exists for.
 */
export function useFixFromRun({
  fixRunId,
  currentGraph,
  currentVersion,
  setAiPrompt,
  setAiMode,
  setShowAi,
}: {
  fixRunId: string | null;
  /**
   * The LIVE compiled canvas — the graph the fix will actually change. Undefined until the
   * workflow has loaded and compiled, which is why the build below waits for it.
   */
  currentGraph: GraphDef | undefined;
  currentVersion: number | null;
  setAiPrompt: (v: string) => void;
  setAiMode: (m: "edit" | "create") => void;
  setShowAi: (v: boolean) => void;
}): FixFromRun {
  // The instruction is built ONCE per run, but not until `currentGraph` exists — so the effect
  // must be allowed to re-run as the canvas loads while never rebuilding over a prompt the user
  // has begun editing. A ref, not a dep-list omission, is what expresses that.
  const builtFor = useRef<string | null>(null);
  const [fetched, setFetched] = useState<FetchedFix>({
    runVersion: null,
    includedNodeIds: [],
    error: null,
  });

  useEffect(() => {
    if (!fixRunId) return;
    // Wait for the canvas to have compiled. The fix targets the CURRENT graph (decision 1), so
    // building the description before it exists would describe the failing step as the RUN saw
    // it — which is the stale snapshot this whole path exists to avoid editing.
    if (!currentGraph) return;
    // Already described this run: never rebuild over a prompt the user may have edited.
    if (builtFor.current === fixRunId) return;
    builtFor.current = fixRunId;
    let live = true;
    // Did this invocation get far enough to hand the prompt over? See the cleanup for why the
    // claim above cannot be trusted on its own.
    let handedOver = false;

    void (async () => {
      try {
        // The run's state carries the failure and the ctx; its executed graph carries the version
        // it ran. Both are already-authorized reads of a run the user just had open.
        const [runState, runGraph] = await Promise.all([
          api.getState(fixRunId),
          api.getRunGraph(fixRunId).catch(() => null),
        ]);
        if (!live) return;

        const failedNodeId = runState.currentNodeId;
        if (!failedNodeId) {
          setFetched((f) => ({
            ...f,
            error:
              "That run doesn't record which step failed, so there's nothing specific to describe. Say what you'd like changed instead.",
          }));
          setShowAi(true);
          handedOver = true; // a stated reason IS the outcome; don't re-fetch over it
          return;
        }

        // The error text and the redacted request/response live in the run's HISTORY, not its
        // state — the same source the run detail reads them from, so the description matches what
        // the user was just looking at rather than being a second rendering of it.
        const events = await api.getRunHistory(fixRunId).catch(() => null);
        if (!live) return;
        const { errorDetail, errorHttp } = historyTimes(events);

        const { instruction, includedNodeIds } = buildFixInstruction({
          // The CURRENT canvas graph, not `runGraph.graph`. `getRunGraph` returns the SNAPSHOT the
          // run executed, and describing the failing step from that would tell the model about a
          // configuration that may no longer exist — while the banner claims the fix applies to
          // the current version. The two must agree, and the current version is the one a save
          // writes (decision 1). `runGraph` is still fetched, for its VERSION, which is what the
          // drift warning compares.
          graph: currentGraph,
          failedNodeId,
          error: errorDetail,
          http: errorHttp,
          ctx: runState.ctx,
          // "Could not read the ctx" is not "the run produced no output" — see ctxWasReadable.
          ctxAvailable: ctxWasReadable(runState.ctx, runState.executedNodeIds),
        });

        setAiPrompt(instruction);
        setAiMode("edit");
        setShowAi(true);
        handedOver = true;
        // Only what the FETCH knows. Drift is computed at render against the live version.
        setFetched({
          runVersion: runGraph?.version ?? null,
          includedNodeIds,
          error: null,
        });
      } catch {
        if (!live) return;
        setFetched((f) => ({
          ...f,
          error:
            "Couldn't read that run, so the failure isn't described below — say what you'd like changed.",
        }));
        setShowAi(true);
        handedOver = true;
      }
    })();

    return () => {
      live = false;
      /**
       * RELEASE THE CLAIM IF THIS INVOCATION NEVER FINISHED.
       *
       * Reported as "Fix with AI just takes me to the canvas without anything happening", and the
       * claim + cancel above are exactly why:
       *
       *   1. the effect runs, claims `builtFor`, and starts the fetch;
       *   2. the canvas RECOMPILES — `currentGraph` is a new object every time, so the effect is
       *      torn down and this cleanup sets `live = false`;
       *   3. the effect re-runs, sees its own claim, and returns early;
       *   4. the fetch from (1) resolves into `if (!live) return` and the prompt is never set.
       *
       * The claim outlived the work it was standing for. StrictMode makes it happen every time in
       * dev, but one recompile during load is enough in production — which is where it was seen.
       *
       * Releasing on an unfinished cancel means the re-run does the work instead of trusting a
       * claim nobody is honouring. `handedOver` keeps the original guarantee intact: once the
       * prompt has been handed over, the claim stays and nothing rebuilds over an edited prompt.
       */
      if (!handedOver) builtFor.current = null;
    };
  }, [fixRunId, currentGraph]);

  // Derived HERE, against the version the canvas has now — see the header. A run that executed
  // v3 of a workflow that is now v7 is the case the banner exists for, and it is only knowable
  // once the workflow has finished loading, which is after the effect above has run.
  return {
    drift: driftBetween(fetched.runVersion, currentVersion),
    includedNodeIds: fetched.includedNodeIds,
    error: fetched.error,
  };
}
