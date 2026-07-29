/**
 * Does the canvas hold work that a save would keep and leaving would lose?
 *
 * The canvas does NOT auto-save, so this is the one question behind every prompt on the screen:
 * the navigation guard, the tab-close warning, and the "save before I test/check this?" dialogs.
 * It is a pure function of (baseline, live graph, name) so it can be unit-tested as the real
 * decision instead of being re-derived by eye at four call sites.
 *
 * ## Why compare against a captured BASELINE and not the server's copy
 *
 * Opening a workflow decompiles the stored GraphDef onto the canvas, and the canvas immediately
 * recompiles it. That round trip is not required to be byte-identical — compileGraph fills in
 * config defaults, lifts `onError`/`retry` out of config-space, normalizes an edge condition, and
 * drops `__name` into `NodeDef.name`. Comparing the live compile against what the server returned
 * would therefore announce "unsaved changes" on a workflow nobody has touched. The baseline is
 * instead the FIRST compile after the graph is presented (loaded / imported / generated), so both
 * sides of the comparison come out of the same compiler and only real edits can differ.
 *
 * After a successful save the baseline moves to the graph that was saved — which IS the live
 * compiled one, no round trip involved.
 *
 * ## What is deliberately NOT compared
 *
 * Node POSITIONS. `compileGraph` drops them and `decompileGraph` re-lays the graph out by depth,
 * so layout is not part of what a save persists. Warning that a drag is "unsaved work" would
 * promise to keep something we never stored.
 */
import { type GraphDef, graphsEqual } from "@naary/dsl";

/**
 * What a blank title is saved as. Exported so `useWorkflowActions.save` and this comparison can't
 * hold two copies of the literal and disagree about whether an untitled canvas was renamed.
 */
export const UNTITLED_WORKFLOW = "Untitled workflow";

/** The name a save would actually persist for this title. */
export function savedWorkflowName(name: string): string {
  return name.trim() || UNTITLED_WORKFLOW;
}

/** The graph + name the canvas was last saved as, or first presented with. */
export interface CanvasBaseline {
  graph: GraphDef;
  name: string;
}

export function isCanvasDirty({
  baseline,
  graph,
  name,
}: {
  baseline: CanvasBaseline | null;
  /** The live-compiled canvas (`useCompiledCanvas`); undefined while it doesn't compile. */
  graph: GraphDef | undefined;
  /** The display name in the top bar, unnormalized. */
  name: string;
}): boolean {
  // No baseline yet: the canvas hasn't presented a compilable graph since it was (re)loaded, so
  // there is nothing to compare against. Claiming "unsaved changes" here would fire on every
  // fresh mount, before the user has done anything at all.
  if (!baseline) return false;
  // Compared through the same normalization a save applies, or clearing the title of an untitled
  // draft would read as a rename of "Untitled workflow" into itself.
  if (savedWorkflowName(name) !== savedWorkflowName(baseline.name)) return true;
  // The canvas no longer compiles. It only got that way by being EDITED (the baseline compiled),
  // and a graph that can't be saved is precisely the work most worth warning about.
  if (!graph) return true;
  return !graphsEqual(baseline.graph, graph);
}
