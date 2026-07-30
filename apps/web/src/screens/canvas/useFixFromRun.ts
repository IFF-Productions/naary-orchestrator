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
import { useEffect, useState } from "react";
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
 * DRIFT IS DERIVED AT RENDER, not captured in the effect. The effect runs on `fixRunId` alone —
 * re-running it on `currentVersion` would overwrite a prompt the user has started editing, the
 * moment the workflow finishes loading — so anything it closed over would be the value from the
 * FIRST render, when the workflow is still loading and `version` is still null. Drift would then
 * never fire, which is the one case the banner exists for.
 */
export function useFixFromRun({
  fixRunId,
  currentVersion,
  setAiPrompt,
  setAiMode,
  setShowAi,
}: {
  fixRunId: string | null;
  currentVersion: number | null;
  setAiPrompt: (v: string) => void;
  setAiMode: (m: "edit" | "create") => void;
  setShowAi: (v: boolean) => void;
}): FixFromRun {
  const [fetched, setFetched] = useState<FetchedFix>({
    runVersion: null,
    includedNodeIds: [],
    error: null,
  });

  useEffect(() => {
    if (!fixRunId) return;
    let live = true;

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
          return;
        }

        // The error text and the redacted request/response live in the run's HISTORY, not its
        // state — the same source the run detail reads them from, so the description matches what
        // the user was just looking at rather than being a second rendering of it.
        const events = await api.getRunHistory(fixRunId).catch(() => null);
        if (!live) return;
        const { errorDetail, errorHttp } = historyTimes(events);

        const { instruction, includedNodeIds } = buildFixInstruction({
          // The graph to FIX is the workflow's current version — which the canvas has already
          // loaded and compiled — not the snapshot the run executed.
          graph: (runGraph?.graph ?? {
            nodes: [],
            edges: [],
            startNodeId: "",
          }) as GraphDef,
          failedNodeId,
          error: errorDetail,
          http: errorHttp,
          ctx: runState.ctx,
          // A closed run whose ctx we couldn't recover answers `{}`. Saying "reads no data" there
          // would be a confident falsehood about the workflow rather than about our read.
          ctxAvailable: Object.keys(runState.ctx ?? {}).length > 0,
        });

        setAiPrompt(instruction);
        setAiMode("edit");
        setShowAi(true);
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
      }
    })();

    return () => {
      live = false;
    };
    // Built ONCE per run. Re-running on `currentVersion` would overwrite a prompt the user has
    // started editing the moment the canvas finishes loading its version.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixRunId]);

  // Derived HERE, against the version the canvas has now — see the header. A run that executed
  // v3 of a workflow that is now v7 is the case the banner exists for, and it is only knowable
  // once the workflow has finished loading, which is after the effect above has run.
  return {
    drift: driftBetween(fetched.runVersion, currentVersion),
    includedNodeIds: fetched.includedNodeIds,
    error: fetched.error,
  };
}
