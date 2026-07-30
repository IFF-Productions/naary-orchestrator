/**
 * The canvas's unsaved-changes guard: owns the baseline, answers "is there work to lose?", and
 * stands in front of anything that would lose it.
 *
 * The canvas never auto-saves — saving is the user's decision, and a tool that quietly writes a
 * version on their behalf (to make some other button work) has taken that decision away. The cost
 * of that rule is that unsaved work is genuinely losable, so the ways OUT of the canvas have to be
 * guarded: in-app navigation (react-router `useBlocker` + our confirm dialog) and closing the tab
 * (`beforeunload` — see the comment there; that one case cannot use our dialog).
 *
 * The dirty RULE itself is pure and lives in ./canvas-dirty, next to its unit tests. This hook is
 * only the wiring: when the baseline is captured, when it moves, and who gets asked.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { type BlockerFunction, useBlocker } from "react-router-dom";
import type { GraphDef } from "@naary/dsl";
import { useConfirm } from "../../components";
import { type CanvasBaseline, isCanvasDirty } from "./canvas-dirty";

export function useUnsavedChanges({
  graph,
  name,
}: {
  /** The live-compiled canvas (`useCompiledCanvas`); undefined while it doesn't compile. */
  graph: GraphDef | undefined;
  name: string;
}) {
  const confirm = useConfirm();
  const [baseline, setBaseline] = useState<CanvasBaseline | null>(null);

  // Capture the baseline from the FIRST compile after the graph was presented (mount, open,
  // import, generate — each of which clears it). Waiting for the compile rather than baselining
  // the graph the server sent is the whole point: see canvas-dirty's header on the round trip.
  useEffect(() => {
    if (baseline || !graph) return;
    setBaseline({ graph, name });
  }, [baseline, graph, name]);

  const dirty = isCanvasDirty({ baseline, graph, name });

  /**
   * The blocker predicate runs SYNCHRONOUSLY inside a navigation, so it can only see what the
   * last render committed. "Save & run" saves and then navigates to the run in the same tick —
   * a value read off the render would still say "dirty" and prompt about changes that were just
   * persisted. The ref is written during render AND forced false by markSaved/resetBaseline, so
   * a navigation that follows a save immediately sees the truth.
   */
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  /** The canvas was persisted: this exact graph + name is the new baseline. */
  const markSaved = useCallback((saved: CanvasBaseline) => {
    dirtyRef.current = false;
    setBaseline(saved);
  }, []);

  /**
   * A different graph was PRESENTED (opened, imported, generated, or reset to the seed) — it is
   * not an edit of the previous one, so drop the baseline and let the effect above re-capture
   * from the new graph's first compile.
   */
  const resetBaseline = useCallback(() => {
    dirtyRef.current = false;
    setBaseline(null);
  }, []);

  const shouldBlock = useCallback<BlockerFunction>(
    ({ currentLocation, nextLocation }) => {
      if (!dirtyRef.current) return false;
      // A session-expiry bounce (save/run navigate here on a 401) isn't a choice the user can
      // act on — their changes are unsavable until they sign in again, so asking whether to
      // discard them just stands between them and the sign-in screen.
      if (nextLocation.pathname === "/auth") return false;
      if (nextLocation.pathname !== currentLocation.pathname) return true;
      // Same-path param rewrites are mostly the canvas's own bookkeeping (stripping ?add= after
      // a deep link, entering/leaving run watch) and leave the canvas exactly as it is. Only
      // ?key= / ?template= re-load it with a DIFFERENT workflow, which is what loses work.
      const cur = new URLSearchParams(currentLocation.search);
      const next = new URLSearchParams(nextLocation.search);
      return (
        cur.get("key") !== next.get("key") ||
        cur.get("template") !== next.get("template")
      );
    },
    [],
  );
  const blocker = useBlocker(shouldBlock);

  // Ask on the TRANSITION into "blocked" only. The blocked state persists across re-renders, and
  // ConfirmProvider declines an outstanding question when a second one arrives — so an unlatched
  // effect would re-ask on the next render and answer the open dialog for the user.
  const asking = useRef(false);
  useEffect(() => {
    if (blocker.state !== "blocked" || asking.current) return;
    asking.current = true;
    void confirm({
      title: "Leave with unsaved changes?",
      body: "This canvas has changes that haven't been saved. Leaving now discards them.",
      confirmLabel: "Discard changes",
      cancelLabel: "Stay here",
      danger: true,
    }).then((discard) => {
      asking.current = false;
      if (discard) blocker.proceed?.();
      else blocker.reset?.();
    });
  }, [blocker, confirm]);

  /**
   * CLOSING THE TAB CANNOT USE OUR DIALOG, and no amount of care changes that.
   *
   * `beforeunload` is the only hook the browser gives a page that is being torn down, and it is
   * deliberately not scriptable: the browser shows its OWN generic wording ("Leave site? Changes
   * you made may not be saved"), ignores any string we return, and will not paint anything we
   * render — a page is not allowed to hold a tab open to ask its question its own way. So this
   * one exit gets the browser's prompt, and every in-app navigation gets ours (the blocker above).
   * The alternative — no warning at all on tab close — loses the work outright, which is worse
   * than a prompt that doesn't match our design.
   *
   * Registered only while dirty, so a clean canvas never interrupts a close (and, in Chrome, so
   * the tab stays eligible for the back/forward cache the rest of the time).
   */
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Legacy path: some browsers still gate the prompt on a non-empty returnValue.
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  // `baseline` is exposed for the review-changes panel, which diffs it against the live graph.
  // It is the RIGHT left-hand side for that and not a convenience: it is the graph as last saved
  // or presented, captured through the same compiler as the live one (see canvas-dirty's header
  // on why comparing against the server's copy would report edits nobody made). Notably an AI
  // EDIT does not move it — only a save or a freshly presented graph does — so "what changed"
  // spans the whole editing session rather than resetting under the user mid-edit.
  return { dirty, baseline, markSaved, resetBaseline };
}
