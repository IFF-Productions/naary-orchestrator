/**
 * Where a newly added node lands on the canvas — pure geometry, unit-tested in
 * apps/web/test/node-placement.spec.ts.
 *
 * ## The bug this replaces (#756)
 *
 * Placement used to be:
 *
 *     position: { x: 160 + (ns.length % 5) * 40, y: 300 + (ns.length % 3) * 30 }
 *
 * which is only **15 distinct positions** (5 × 3), spread across a 160×60px area — while a node card
 * is 176–244px wide and ~80px tall. So consecutive nodes overlapped almost completely, the 16th node
 * landed exactly on the 1st, and because the offset was derived from `nodes.length`, deleting a node
 * and adding another dropped the new one precisely on top of an existing card. The reporter hit it
 * adding a Form trigger to a graph that already had nodes; nothing about it is Form-specific.
 *
 * Replaced with a collision-checked grid scan, so a new node always lands somewhere visibly free.
 */

/** One node's top-left position on the canvas. */
export interface XY {
  x: number;
  y: number;
}

/**
 * Collision footprint. Deliberately the card's MAX width (244) rather than its min: a card grows with
 * its title, and reserving the widest case means a long-named node can't creep under its neighbour.
 * Height is the tallest ordinary card (title + subtitle + a badge row).
 */
const CARD_W = 244;
const CARD_H = 88;

/** Grid pitch — the footprint plus breathing room, so cards read as separate, not merely non-overlapping. */
export const COL_PITCH = CARD_W + 56;
export const ROW_PITCH = CARD_H + 40;

/** Where the FIRST node on an empty canvas goes. Unchanged from the previous behaviour's origin, so
 *  an empty canvas still drops its first node exactly where it always did. */
export const FIRST_NODE: XY = { x: 160, y: 300 };

/** How far the scan will look before giving up and appending to the right (a bound, not a limit on
 *  graph size — 40×40 slots is far past any hand-built graph, and the fallback still can't collide). */
const SCAN = 40;

/** Do two same-sized cards at these top-left positions visually overlap? */
function overlaps(a: XY, b: XY): boolean {
  return Math.abs(a.x - b.x) < CARD_W && Math.abs(a.y - b.y) < CARD_H;
}

/**
 * Where a TRIGGER (entry) node goes: to the LEFT of the graph, level with the node it will feed.
 *
 * Reported as "added new start workflow node, and canvas throwing it in the middle with odd
 * connection location". The general free-slot scan below put it at the first gap — for a
 * left-to-right row of four, that is directly UNDER the first card, mid-flow. An entry node there is
 * wrong twice over: it reads as a step rather than a start, and any edge drawn from it has to sweep
 * BACKWARDS into the node it triggers, which is the odd connection.
 *
 * A trigger has no inbound edge by definition, so the only sensible place is upstream of everything:
 * one column left, at the leftmost card's own y, so the edge it will carry runs straight and
 * left-to-right like the rest of the flow. Once a trigger IS there it owns that column and further
 * triggers stack beneath it — parallel entry points, rather than a staircase marching left.
 */
function entryPosition(existing: XY[], entries: XY[]): XY {
  // A trigger already on the canvas OWNS the entry column — stack under the lowest one rather than
  // stepping further left, so two entry points read as a parallel column instead of a staircase
  // that drags the whole graph leftward with every trigger added.
  if (entries.length > 0) {
    const columnX = Math.min(...entries.map((n) => n.x));
    const lowest = Math.max(...entries.map((n) => n.y));
    for (let row = 1; row < SCAN; row++) {
      const candidate = { x: columnX, y: lowest + row * ROW_PITCH };
      if (!existing.some((n) => overlaps(n, candidate))) return candidate;
    }
    // 40 slots below the lowest trigger all taken. Step one column left and scan THERE too rather
    // than returning a fixed slot — an unchecked fallback can hand back an occupied position, which
    // is the overlap bug this module exists to prevent.
    for (let row = 0; row < SCAN; row++) {
      const candidate = {
        x: columnX - COL_PITCH,
        y: lowest + row * ROW_PITCH,
      };
      if (!existing.some((n) => overlaps(n, candidate))) return candidate;
    }
    // Unreachable for any real graph: it takes ~79 occupied slots (SCAN-1 below the lowest trigger,
    // then SCAN in the column left of it) to get here. Far left of everything, which cannot collide
    // by construction.
    return {
      x: Math.min(...existing.map((n) => n.x)) - 2 * COL_PITCH,
      y: lowest,
    };
  }

  const minX = Math.min(...existing.map((n) => n.x));
  // Level with the TOPMOST card in the leftmost column — the one a new trigger would feed.
  const anchorY = Math.min(
    ...existing.filter((n) => n.x === minX).map((n) => n.y),
  );
  for (let row = 0; row < SCAN; row++) {
    const candidate = { x: minX - COL_PITCH, y: anchorY + row * ROW_PITCH };
    if (!existing.some((n) => overlaps(n, candidate))) return candidate;
  }
  // Two columns left is empty by construction — nothing can be left of the leftmost card minus one
  // pitch unless it was placed there, and this branch only runs when that whole column is full.
  return { x: minX - 2 * COL_PITCH, y: anchorY };
}

/**
 * The next free slot for a node, given everything already placed.
 *
 * Scans COLUMN-FIRST (down, then across) because this canvas reads top-to-bottom — a trigger at the
 * top, steps beneath it — so stacking downward is what an author expects "add a node" to do. The grid
 * is anchored to the existing graph's top-left corner rather than a fixed origin, so nodes join the
 * layout the author has actually built instead of appearing off in a corner of it.
 *
 * Anchoring on the MINIMUM x/y matters for a second reason: it makes placement independent of node
 * COUNT. The old bug came from deriving position from `nodes.length`, which changes when anything is
 * deleted; a free-slot search depends only on where cards actually are.
 */
export function nextNodePosition(
  existing: XY[],
  opts?: {
    /** Placing a TRIGGER: goes upstream of the flow, not into its first gap. */
    entry?: boolean;
    /** Positions of the TRIGGERS already on the canvas. The caller knows each node's kind; this
     *  module deliberately doesn't, so it is told rather than guessing from geometry. */
    entries?: XY[];
  },
): XY {
  if (existing.length === 0) return { ...FIRST_NODE };
  if (opts?.entry) return entryPosition(existing, opts.entries ?? []);

  const baseX = Math.min(...existing.map((n) => n.x));
  const baseY = Math.min(...existing.map((n) => n.y));

  for (let col = 0; col < SCAN; col++) {
    for (let row = 0; row < SCAN; row++) {
      const candidate = {
        x: baseX + col * COL_PITCH,
        y: baseY + row * ROW_PITCH,
      };
      if (!existing.some((n) => overlaps(n, candidate))) return candidate;
    }
  }

  // Unreachable for any real graph. Falls back to the right of everything, which cannot collide by
  // construction — better than returning a slot we know is occupied.
  return {
    x: Math.max(...existing.map((n) => n.x)) + COL_PITCH,
    y: baseY,
  };
}
