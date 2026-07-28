/**
 * Position bookkeeping for a graph that arrives node-by-node over SSE.
 *
 * `GraphDef` carries no positions, so every render of a streamed graph runs through a layout.
 * That leaves two DIFFERENT questions, and answering them from one map is a bug:
 *
 *  - mid-stream, a node must stop moving once it has landed, or the canvas churns as its
 *    siblings arrive;
 *  - at the end, a node that existed BEFORE the run must return to where the user left it
 *    (otherwise an edit re-lays-out the whole canvas and reads as a rewrite), while a node the
 *    edit ADDED must take the authoritative layout — the one computed over the finished graph.
 *
 * The trap is that the mid-stream map necessarily accumulates positions from PARTIAL layouts: a
 * node arriving 4th of 9 is placed as though the graph had four nodes. Reading that map at the
 * end pins every added node to a coordinate computed for a graph that no longer exists — it can
 * overlap a neighbour or sit nowhere near its own edges.
 *
 * So `settle()` closes over `before` and cannot see `scratch` at all. Keeping them apart is the
 * whole point of this module; a single shared map is what made it wrong the first time.
 */
export interface XY {
  x: number;
  y: number;
}

interface Positioned {
  id: string;
  position: XY;
}

export interface StreamPositions {
  /** Mid-stream: freeze each node where it first landed. */
  place<T extends Positioned>(laidOut: T[]): T[];
  /** Final: pre-existing nodes go home, new nodes keep the authoritative layout. */
  settle<T extends Positioned>(laidOut: T[]): T[];
}

/**
 * @param preRun where the nodes sat before this run started — empty for a create (nothing to
 *        preserve), the current canvas for an edit.
 */
export function makeStreamPositions(
  preRun: Iterable<readonly [string, XY]> = [],
): StreamPositions {
  const before = new Map<string, XY>(
    [...preRun].map(([id, p]) => [id, { ...p }]),
  );
  const scratch = new Map(before);
  return {
    place(laidOut) {
      return laidOut.map((n) => {
        const pos = scratch.get(n.id) ?? n.position;
        scratch.set(n.id, pos);
        return { ...n, position: pos };
      });
    },
    settle(laidOut) {
      return laidOut.map((n) => ({
        ...n,
        position: before.get(n.id) ?? n.position,
      }));
    },
  };
}
