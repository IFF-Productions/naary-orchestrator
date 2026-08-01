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
  /** How far along the description is — what the panel reports while nothing is in the box yet. */
  stage: FixStage;
}

/**
 * What the panel should be SAYING right now.
 *
 * Reported as "Fix with AI initially loads the canvas but nothing is happening, then it will show
 * the prefilled prompt". Both waits are real — the canvas has to load and compile before the
 * description can be built against it (decision 1), and then three reads of the run have to come
 * back — so the honest fix is to name the wait rather than to shorten it.
 *
 * `blocked` is the one that matters most, and it is why this is a four-state enum rather than a
 * boolean. The effect below refuses to build without a compiled graph; if the canvas never
 * compiles, a `loading` boolean would spin forever — a spinner that promises something is coming
 * and never delivers is a worse version of the very complaint being fixed. Once the canvas has
 * finished LOADING and still has no graph, that is an answer, not a wait.
 *
 * `blocked` DOES NOT MEAN "no graph", though, and reading it that way is how #1006 shipped: a
 * workflow that failed to OPEN also blocks, with a graph — the seed left on the canvas, compiling.
 * Two routes in, and the panel needs both apart to say anything true (see {@link blockedReason}).
 */
export type FixStage =
  "idle" | "loading-canvas" | "reading-run" | "blocked" | "done";

/**
 * How the canvas's workflow fetch went — THREE states, not a settled/not-settled boolean (#1006).
 *
 * A boolean could only say whether the fetch had finished, and that was deliberate: reporting
 * "settled" for a failed open is what stops `fixStage` spinning forever on the one path that most
 * needs to say what went wrong. But it made a failed open indistinguishable from a successful one,
 * and the two leave the canvas in completely different states. On failure `CanvasPage` only sets a
 * status line — the nodes are never replaced — so the canvas still holds SEED_NODES
 * (start → approval → end), which COMPILE. Read as "loaded", that seed becomes the graph the
 * failure is described against, and the prompt comes out saying
 * `Failed at node: "notify" (no longer in the workflow)` beneath a banner claiming the fix applies
 * to the workflow the user came from. The same confident falsehood #998 fixed for the race.
 *
 * `failed` keeps the failure TERMINAL — no spinner, an answer — while stopping it from being read
 * as "this is what the canvas has".
 */
export type CanvasLoad = "loading" | "loaded" | "failed";

export function fixStage({
  fixRunId,
  hasGraph,
  canvasLoad,
  doneFor,
}: {
  fixRunId: string | null;
  /** The canvas has compiled — the thing the description gets built against. */
  hasGraph: boolean;
  /** How the workflow fetch went. Distinguishes "not yet" from "never" from "it failed". */
  canvasLoad: CanvasLoad;
  /** The run whose description has been handed to the panel, successfully or with a reason. */
  doneFor: string | null;
}): FixStage {
  if (!fixRunId) return "idle";
  // A stated outcome — the instruction, or the reason there isn't one — ends the wait. Compared
  // by run id so arriving from a SECOND failed run starts reporting again instead of showing the
  // previous run's result as though it were this one's.
  if (doneFor === fixRunId) return "done";
  /**
   * THE LOAD IS THE FIRST WAIT, AND `hasGraph` CANNOT ANSWER IT (#998).
   *
   * This used to read `if (hasGraph) return "reading-run"` first, which made `loading-canvas`
   * dead code: the canvas mounts with SEED_NODES (start → approval → end) and those COMPILE, so
   * `hasGraph` is true on the very first render — before the workflow has even been requested.
   * The panel therefore said it was "reading the run" while what it was really waiting for was
   * the workflow, and the effect below, reading the same condition, would build the description
   * against the seed canvas.
   *
   * A graph is not THE workflow. `canvasLoad` is the only signal that separates "the canvas
   * hasn't loaded yet" from "this is what the canvas has", so it is asked first.
   */
  if (canvasLoad === "loading") return "loading-canvas";
  /**
   * THE WORKFLOW COULD NOT BE OPENED (#1006) — and `hasGraph` cannot answer this one either, for
   * exactly the same reason it cannot answer the wait: the seed still on screen compiles, so
   * asking it here returns `reading-run` and the description gets built against the seed.
   *
   * Terminal, like the other `blocked` cases, and the panel has its own sentence for it — the two
   * that already existed are both false here. "There's no workflow on the canvas" would be false
   * about three visibly-rendered nodes (bug 3, again), and "the canvas doesn't compile" would be
   * false about a seed that compiles fine.
   */
  if (canvasLoad === "failed") return "blocked";
  return hasGraph ? "reading-run" : "blocked";
}

/**
 * WHY `blocked` WAS REACHED, in the user's terms — three situations, three sentences, none reused.
 *
 * `blocked` is terminal, so it has to ANSWER, and the answer has to be true of what the user is
 * looking at. Not a stylistic point: this branch has already shipped a sentence that was plainly
 * false about a visible canvas, which is the exact class of bug `?fix=` exists to prevent, so the
 * cases stay separate rather than being generalised into one apology.
 *
 *   1. The workflow FAILED TO OPEN (#1006). The canvas is neither empty nor broken — the fetch
 *      rejected, the nodes were never replaced, and the SEED graph (start → approval → end) is
 *      still mounted and still compiles. Both other sentences are false here; what is wrong is
 *      that what's on screen is not the user's workflow, so that is what this one says.
 *   2. A workflow IS here and does not compile. Naming the compile error makes it fixable.
 *   3. Nothing on the canvas at all — the only case where "there's no workflow" is true.
 *
 * ORDER IS THE WHOLE FUNCTION. (1) compiles, so unless it is asked first it falls through to (3)
 * and tells someone there is no workflow on a canvas with three nodes rendered on it.
 *
 * Lives here rather than in `AiPromptPanel` because the panel's `error` sentences already do — the
 * panel renders what this flow decided to say, it doesn't decide it — and because a hook module is
 * importable by the unit suite, while the panel drags in the component barrel.
 */
export function blockedReason({
  canvasLoadFailed,
  canvasError,
}: {
  /** The workflow fetch REJECTED — see {@link CanvasLoad}. */
  canvasLoadFailed?: boolean;
  /** The canvas has nodes on it that don't compile, and why. */
  canvasError?: string | null;
}): string {
  if (canvasLoadFailed) {
    return "That workflow couldn't be opened — the steps on the canvas are a new flow's starting point, not it — so that run couldn't be described here. Reload to try again, or say what you'd like changed instead.";
  }
  if (canvasError) {
    return `The canvas doesn't compile — ${canvasError} — so that run couldn't be described here. Fix that, or say what you'd like changed.`;
  }
  return "There's no workflow on the canvas to change, so that run couldn't be described here — say what you'd like changed instead.";
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
  canvasLoad,
  setAiPrompt,
  setAiMode,
  setShowAi,
}: {
  fixRunId: string | null;
  /**
   * The LIVE compiled canvas — the graph the fix will actually change.
   *
   * NOT a signal that the workflow has arrived: the canvas mounts with SEED_NODES, which compile,
   * so this is defined from the first render (#998). Undefined only means nothing on the canvas
   * compiles right now. `canvasLoad` is what says whether it is the workflow.
   */
  currentGraph: GraphDef | undefined;
  currentVersion: number | null;
  /**
   * How the workflow fetch went — the gate on the build below, and what lets `fixStage` stop
   * waiting. Only `loaded` means the canvas is showing the workflow; see {@link CanvasLoad} for
   * why `failed` needs to be told apart from it rather than folded into "settled".
   *
   * ONE PLACE `loaded` DOES NOT MEAN "the workflow is on the canvas": a canvas opened with no
   * `?key=` and no `?template=` has nothing to fetch, so `CanvasPage` reports it loaded
   * immediately — with SEED_NODES mounted. `/app/canvas?fix=<runId>` with no key would therefore
   * build the description against the seed. It is not reachable from the product — RunDetail
   * renders "Fix with AI" behind `runWorkflowKey &&` (truthy, so `""` is excluded) and builds the
   * URL from that same value — and it is a much weaker version of the bug — with no workflow loaded there is no version banner to
   * contradict, and "no longer in the workflow" is TRUE of a blank draft. Noted rather than
   * guarded, so the reliance on that gating is at least visible; see the same note at the
   * `setCanvasLoad` call in CanvasPage.
   */
  canvasLoad: CanvasLoad;
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
  /** The run this hook has finished reporting on — the `done` side of {@link fixStage}. */
  const [doneFor, setDoneFor] = useState<string | null>(null);

  /**
   * OPEN THE PANEL ON ARRIVAL, not on completion.
   *
   * Separate from the build effect below on purpose: that one waits for `currentGraph`, so opening
   * there means the panel appears only once the canvas has loaded AND three reads of the run have
   * come back. Until then the user sees a canvas that looks like they navigated to it for no
   * reason — which is exactly what was reported. This effect depends on `fixRunId` alone, so the
   * panel is up (reporting progress) from the first render after the click.
   */
  useEffect(() => {
    if (!fixRunId) return;
    setShowAi(true);
    // A fix is a CHANGE to this workflow. Set here rather than on completion so the panel doesn't
    // silently switch mode under the user midway through reading it.
    setAiMode("edit");
    /**
     * EVERYTHING SHOWN ABOUT A RUN BELONGS TO THAT RUN.
     *
     * `?fix=` can change without the canvas unmounting — browser back/forward between two fix
     * URLs. Without this reset the panel would report the NEW run in its header while still
     * showing the OLD run's description, drift warning and "sends output from …" list. Every one
     * of those is an assertion about which run's data is about to be sent to a model, and the
     * step list in particular is the panel's whole disclosure of what leaves the tenant — showing
     * one run's under another's header is not a cosmetic staleness.
     *
     * Clearing the box does discard hand-edits carried across a deliberate switch to a different
     * run's fix URL. That is the right trade: the user navigated to run B asking for run B's
     * description, and the alternative — keeping their text under a header describing a different
     * run — is the misattribution this is here to prevent.
     */
    setFetched({ runVersion: null, includedNodeIds: [], error: null });
    setAiPrompt("");
  }, [fixRunId]);

  useEffect(() => {
    if (!fixRunId) return;
    /**
     * WAIT FOR THE WORKFLOW, NOT MERELY FOR A GRAPH (#998).
     *
     * The fix targets the CURRENT graph (decision 1) and the banner says so, so the description
     * has to be built against the workflow the user is looking at. `currentGraph` alone does not
     * establish that: the canvas mounts with SEED_NODES, which COMPILE, so it is defined on the
     * first render and this effect would start against `start → approval → end`.
     *
     * It used to recover by accident. The workflow lands, the nodes are replaced, `currentGraph`
     * is a new object, the effect is torn down, and the cleanup releases the `builtFor` claim —
     * so the re-run rebuilt against the real graph. But that only holds while the workflow wins
     * the race: land the run reads first and `handedOver` is true, the claim survives, and the
     * seed-built description stands. It reads `Failed at node: "x" (no longer in the workflow)`
     * under a banner naming the workflow on screen — a confident falsehood, in the feature that
     * exists to stop the user re-describing a failure from memory.
     *
     * Gating on `canvasLoad` makes the ordering irrelevant rather than merely unlikely: it turns
     * `loaded` only in the branch that has just put the workflow on the canvas, so no render can
     * pair `loaded` with the seed. Nothing about how fast the run reads come back can change
     * that. It also removes the teardown + re-run this effect used to depend on.
     *
     * `failed` is held out here too (#1006): a workflow that could not be opened leaves the seed
     * on the canvas, and a settled/not-settled boolean let that seed through this gate. The
     * ordering was never what made the seed wrong — being the seed was.
     */
    if (canvasLoad !== "loaded") return;
    // Nothing on the canvas compiles — `fixStage` reports `blocked`, and there is nothing to
    // describe the failing step against. (Never a wait once the canvas has loaded.)
    if (!currentGraph) return;
    // Already described this run: never rebuild over a prompt the user may have edited.
    if (builtFor.current === fixRunId) return;
    builtFor.current = fixRunId;
    let live = true;
    // Did this invocation get far enough to hand the prompt over? See the cleanup for why the
    // claim above cannot be trusted on its own.
    let handedOver = false;
    /**
     * The single hand-over point. There are three of them below — an instruction, a run with no
     * failed step, and a read that failed — and each has to move BOTH the local claim and the
     * reported stage. Setting one at three sites and the other at two is how #973 happened; one
     * function is one thing to get right.
     */
    const finish = () => {
      handedOver = true;
      setDoneFor(fixRunId);
    };

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
          finish(); // a stated reason IS the outcome; don't re-fetch over it
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
        finish();
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
        finish();
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
       * (The load-time teardown is gone with #998 — this effect no longer starts before the
       * workflow lands — but any later recompile, an edit or a run overlay, still produces one.)
       *
       * Releasing on an unfinished cancel means the re-run does the work instead of trusting a
       * claim nobody is honouring. `handedOver` keeps the original guarantee intact: once the
       * prompt has been handed over, the claim stays and nothing rebuilds over an edited prompt.
       */
      if (!handedOver) builtFor.current = null;
    };
  }, [fixRunId, currentGraph, canvasLoad]);

  // Derived HERE, against the version the canvas has now — see the header. A run that executed
  // v3 of a workflow that is now v7 is the case the banner exists for, and it is only knowable
  // once the workflow has finished loading, which is after the effect above has run.
  return {
    drift: driftBetween(fetched.runVersion, currentVersion),
    includedNodeIds: fetched.includedNodeIds,
    error: fetched.error,
    stage: fixStage({
      fixRunId,
      hasGraph: currentGraph !== undefined,
      canvasLoad,
      doneFor,
    }),
  };
}
