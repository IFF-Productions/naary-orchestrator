import { describe, expect, it } from "vitest";
import {
  COL_PITCH,
  FIRST_NODE,
  ROW_PITCH,
  type XY,
  nextNodePosition,
} from "../src/screens/canvas/node-placement";

/**
 * Where an added node lands (#756 — "Add Form in Canvas put the node UI in an Odd Layout").
 *
 * The old rule was `x: 160 + (n % 5) * 40, y: 300 + (n % 3) * 30` — 15 distinct positions across a
 * 160×60px area, for cards 176–244px wide and ~88px tall. Consequences, all reproduced below against
 * the new implementation:
 *
 *  - consecutive nodes overlapped almost entirely;
 *  - the 16th node landed EXACTLY on the 1st (the modulo wrapped);
 *  - position came from `nodes.length`, so deleting a node and adding another dropped the new one on
 *    top of an existing card.
 */

/** The card footprint the module treats as overlapping (max width × tallest ordinary card). */
const CARD_W = 244;
const CARD_H = 88;

const overlaps = (a: XY, b: XY) =>
  Math.abs(a.x - b.x) < CARD_W && Math.abs(a.y - b.y) < CARD_H;

/** Add `count` nodes one at a time, exactly as the canvas does. */
function place(count: number, seed: XY[] = []): XY[] {
  const nodes = [...seed];
  for (let i = 0; i < count; i++) nodes.push(nextNodePosition(nodes));
  return nodes;
}

describe("the first node", () => {
  it("lands on the unchanged origin, so an empty canvas behaves exactly as before", () => {
    expect(nextNodePosition([])).toEqual(FIRST_NODE);
  });

  it("returns a COPY, so a caller mutating it can't corrupt the origin", () => {
    const a = nextNodePosition([]);
    a.x = 9999;
    expect(nextNodePosition([]).x).toBe(FIRST_NODE.x);
  });
});

describe("no added node ever overlaps another", () => {
  /** The headline property, checked exhaustively rather than on a couple of examples. */
  it.each([2, 5, 15, 16, 30, 60])("holds for %i nodes", (count) => {
    const nodes = place(count);
    expect(nodes).toHaveLength(count);
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        expect(
          overlaps(nodes[i], nodes[j]),
          `node ${i} at ${JSON.stringify(nodes[i])} overlaps node ${j} at ${JSON.stringify(nodes[j])}`,
        ).toBe(false);
      }
    }
  });

  /**
   * 16 is the number the old modulo broke on: `16 % 5 === 1 % 5` and `16 % 3 === 1 % 3`, so the 16th
   * node landed on the same pixel as the 1st. Pinned explicitly because it's the exact reported shape.
   */
  it("does not repeat a position at the 16th node (the old modulo wrap)", () => {
    const nodes = place(16);
    const unique = new Set(nodes.map((n) => `${n.x},${n.y}`));
    expect(unique.size).toBe(16);
  });
});

describe("placement depends on where cards ARE, not how many", () => {
  /**
   * The delete-then-add case. Under the old rule, removing a node lowered `nodes.length`, so the next
   * add reused a position that was still occupied. A free-slot search can't do that.
   */
  it("does not reuse an occupied slot after a node is deleted", () => {
    const nodes = place(6);
    // Delete a middle node, then add one.
    const remaining = nodes.filter((_, i) => i !== 2);
    const added = nextNodePosition(remaining);
    for (const n of remaining) {
      expect(overlaps(n, added), "reused an occupied slot").toBe(false);
    }
  });

  /** …and it should REUSE the freed gap rather than skipping to the end — that's the point of scanning. */
  it("fills the gap a deleted node left", () => {
    const nodes = place(4);
    const removed = nodes[2];
    const added = nextNodePosition(nodes.filter((_, i) => i !== 2));
    expect(added).toEqual(removed);
  });
});

describe("it joins the graph the author actually built", () => {
  /**
   * Anchored on the existing graph's top-left, not a fixed origin: a node added to a graph the author
   * dragged far from the origin should appear WITH it, not back at (160, 300) off-screen.
   */
  it("anchors to the existing nodes, not to a fixed origin", () => {
    const far = [{ x: 4000, y: 2500 }];
    const added = nextNodePosition(far);
    expect(added.x).toBe(4000);
    expect(added.y).toBe(2500 + ROW_PITCH);
  });

  /** Stacks DOWNWARD first — this canvas reads trigger-at-top, steps beneath. */
  it("stacks vertically before moving to a new column", () => {
    const nodes = place(3);
    expect(nodes.map((n) => n.x)).toEqual([
      FIRST_NODE.x,
      FIRST_NODE.x,
      FIRST_NODE.x,
    ]);
    expect(nodes[1].y).toBe(nodes[0].y + ROW_PITCH);
    expect(nodes[2].y).toBe(nodes[0].y + 2 * ROW_PITCH);
  });

  it("moves to the next column once one is full", () => {
    // 40 rows per column (the scan bound), so column 2 starts at node 41.
    const nodes = place(41);
    expect(nodes[40].x).toBe(FIRST_NODE.x + COL_PITCH);
  });

  /** A hand-dragged node in the way must be avoided, not written over. */
  it("skips a slot occupied by a manually positioned node", () => {
    const seed: XY[] = [
      { x: 160, y: 300 },
      // Sitting exactly where the next vertical slot would be.
      { x: 160, y: 300 + ROW_PITCH },
    ];
    const added = nextNodePosition(seed);
    expect(overlaps(added, seed[0])).toBe(false);
    expect(overlaps(added, seed[1])).toBe(false);
  });

  /** Near-misses count as overlapping: 1px off is visually a stack, not a layout. */
  it("treats a card offset by less than its footprint as occupied", () => {
    const added = nextNodePosition([
      { x: 160, y: 300 },
      { x: 170, y: 310 },
    ]);
    expect(overlaps(added, { x: 160, y: 300 })).toBe(false);
    expect(overlaps(added, { x: 170, y: 310 })).toBe(false);
  });
});
