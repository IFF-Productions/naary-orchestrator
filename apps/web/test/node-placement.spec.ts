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

/**
 * TRIGGERS go upstream of the flow, not into its first gap.
 *
 * Reported as: "added new start workflow node, and canvas throwing it in the middle with odd
 * connection location". On the reported graph — Agent → GitHub → PagerDuty → Sub-workflow in one
 * left-to-right row — the general free-slot scan returns (580, 378): directly UNDER the first card,
 * mid-flow. Wrong twice over for an entry node: it reads as a step rather than a start, and any edge
 * from it must sweep BACKWARDS into the node it triggers.
 */
describe("nextNodePosition — entry (trigger) nodes", () => {
  /** The reported graph. */
  const ROW: XY[] = [
    { x: 580, y: 250 },
    { x: 935, y: 250 },
    { x: 1290, y: 250 },
    { x: 1640, y: 250 },
  ];

  it("without the flag, still lands mid-flow — the reported behaviour", () => {
    expect(nextNodePosition(ROW)).toEqual({ x: 580, y: 250 + ROW_PITCH });
  });

  it("as an entry node, lands one column LEFT and level with the flow", () => {
    const got = nextNodePosition(ROW, { entry: true });
    expect(got).toEqual({ x: 580 - COL_PITCH, y: 250 });
    // Level with the node it will feed ⇒ the edge runs straight, left-to-right.
    expect(got.y).toBe(ROW[0].y);
    // Upstream of EVERYTHING, so it can never read as a step in the middle.
    expect(got.x).toBeLessThan(Math.min(...ROW.map((n) => n.x)));
  });

  it("does not overlap the card it sits beside", () => {
    const got = nextNodePosition(ROW, { entry: true });
    for (const n of ROW) {
      const clear =
        Math.abs(got.x - n.x) >= CARD_W || Math.abs(got.y - n.y) >= CARD_H;
      expect(clear, `overlaps ${JSON.stringify(n)}`).toBe(true);
    }
  });

  /**
   * A second trigger stacks BELOW the first, in the same column — two entry points read as parallel
   * starts. The caller passes the existing triggers because this module doesn't know node KINDS;
   * without that it would step one column further left each time, marching the graph sideways.
   */
  it("stacks a second trigger downward instead of stepping further left", () => {
    const first = nextNodePosition(ROW, { entry: true });
    const second = nextNodePosition([...ROW, first], {
      entry: true,
      entries: [first],
    });
    expect(second).toEqual({ x: first.x, y: first.y + ROW_PITCH });
  });

  /** An empty canvas is unchanged: the first node is the first node, trigger or not. */
  it("puts the first node of an empty canvas at FIRST_NODE either way", () => {
    expect(nextNodePosition([], { entry: true })).toEqual(FIRST_NODE);
    expect(nextNodePosition([])).toEqual(FIRST_NODE);
  });

  /** Aligns to the TOPMOST card in the leftmost column, not an arbitrary one. */
  it("anchors on the topmost card in the leftmost column", () => {
    const stacked: XY[] = [
      { x: 580, y: 600 },
      { x: 580, y: 250 },
      { x: 935, y: 250 },
    ];
    expect(nextNodePosition(stacked, { entry: true })).toEqual({
      x: 580 - COL_PITCH,
      y: 250,
    });
  });
});

/**
 * The entry-column fallbacks must stay collision-checked. An unchecked fallback returning a fixed
 * slot is the exact overlap bug this module exists to prevent — flagged in review on the first
 * version, which returned `{ x: columnX - COL_PITCH, y: lowest }` without looking.
 */
describe("nextNodePosition — entry fallbacks never return an occupied slot", () => {
  it("skips past a full trigger column without landing on a card", () => {
    const base: XY = { x: 1000, y: 100 };
    // A full column of triggers, plus a card sitting exactly where the old fallback pointed.
    const triggers: XY[] = Array.from({ length: 40 }, (_, i) => ({
      x: base.x - COL_PITCH,
      y: base.y + i * ROW_PITCH,
    }));
    const blocker: XY = {
      x: base.x - 2 * COL_PITCH,
      y: base.y + 39 * ROW_PITCH,
    };
    const existing = [base, ...triggers, blocker];

    const got = nextNodePosition(existing, { entry: true, entries: triggers });

    for (const n of existing) {
      const clear =
        Math.abs(got.x - n.x) >= CARD_W || Math.abs(got.y - n.y) >= CARD_H;
      expect(clear, `overlaps ${JSON.stringify(n)}`).toBe(true);
    }
  });
});
