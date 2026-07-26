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
export function nextNodePosition(existing: XY[]): XY {
  if (existing.length === 0) return { ...FIRST_NODE };

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
