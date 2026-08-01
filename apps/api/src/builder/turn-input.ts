/**
 * WHICH GRAPH A TURN EDITS.
 *
 * Pure, and separate from the controller, because it is the one decision on the turn path worth
 * stating on its own: get it wrong and the model faithfully edits a graph the user is not looking
 * at, then hands back a "change" that has silently dropped their work. That is #874, and it is
 * invisible — the response is a valid workflow, just not one derived from what was on screen.
 *
 * Two callers, two situations:
 *
 *   - **Build with AI (the screen)** owns no draft. The session's `currentGraph` IS the draft: it is
 *     seeded from the saved workflow at open and rewritten by every turn's result. It sends no
 *     graph, and `currentGraph` is what gets edited. A null one makes the first turn a create.
 *   - **The canvas panel** owns its draft. The canvas stays interactive under the panel, so the user
 *     can hand-edit between turns and the server's copy is stale the moment they do. It sends the
 *     live compiled canvas every turn, and that wins.
 *
 * Note the deliberate asymmetry: a caller that sends NO graph means "use yours", a caller that
 * sends one means "use mine". There is no way to say "edit nothing" while holding a graph, and none
 * is wanted — a create is expressed by opening a fresh session, not by suppressing the draft on a
 * session that already has one.
 */
import type { GraphDef } from "@naary/dsl";
import { type GraphDraft, toGraphDef } from "../graphs/graph-generator.parse";

export function turnPrevious(
  /** The caller's own working draft, when it holds one (SendTurnDto.graph). */
  supplied: Record<string, unknown> | undefined,
  /** The session's stored draft — null before the first turn. */
  stored: GraphDef | null,
): GraphDef | undefined {
  // Narrowed, not trusted: `validateGraph` inside the generator does the deep checks and a
  // malformed body comes back as a 400 rather than reaching the model.
  if (supplied) return toGraphDef(supplied as unknown as GraphDraft);
  return stored ?? undefined;
}
