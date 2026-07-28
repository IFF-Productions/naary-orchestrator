import { describe, expect, it } from "vitest";
import { makeStreamPositions } from "../src/screens/canvas/stream-positions";

/**
 * The reason this module exists: a streamed graph is laid out repeatedly, over a growing subset
 * of itself, and the mid-stream positions are NOT the ones to keep. The test that matters is the
 * last one — a node added by an edit must take the layout computed over the finished graph, not
 * the one it happened to land on when a third of the graph had arrived.
 */
const at = (id: string, x: number, y: number) => ({ id, position: { x, y } });

describe("makeStreamPositions", () => {
  describe("place (mid-stream)", () => {
    it("freezes a node where it first landed, so later arrivals don't shove it", () => {
      const p = makeStreamPositions();
      p.place([at("a", 0, 0)]);
      // Second pass: the layout now spreads three nodes and would move `a`.
      const second = p.place([
        at("a", 300, 40),
        at("b", 500, 40),
        at("c", 700, 40),
      ]);
      expect(second[0].position).toEqual({ x: 0, y: 0 });
      // The newcomers take this pass's coordinates.
      expect(second[1].position).toEqual({ x: 500, y: 40 });
    });

    it("starts an EDIT from the canvas, so an untouched node never moves", () => {
      const p = makeStreamPositions([["a", { x: 120, y: 60 }]]);
      expect(p.place([at("a", 0, 0)])[0].position).toEqual({ x: 120, y: 60 });
    });
  });

  describe("settle (final reconcile)", () => {
    it("returns pre-existing nodes to where the user left them", () => {
      const p = makeStreamPositions([["a", { x: 120, y: 60 }]]);
      expect(p.settle([at("a", 900, 900)])[0].position).toEqual({
        x: 120,
        y: 60,
      });
    });

    it("gives a node ADDED by the edit the authoritative layout, NOT its mid-stream spot", () => {
      // The bug this guards: `place` caches every node it sees, including new ones, at a
      // coordinate from a layout over the partial graph. Reading that cache at the end pins the
      // added node to a position computed for a graph that no longer exists — overlapping a
      // neighbour, or nowhere near its own edges.
      const p = makeStreamPositions([["a", { x: 120, y: 60 }]]);
      p.place([at("a", 0, 0), at("added", 300, 0)]); // partial layout: 2 nodes
      const final = p.settle([at("a", 0, 0), at("added", 640, 220)]); // full layout
      expect(final[0].position).toEqual({ x: 120, y: 60 }); // survivor: home
      expect(final[1].position).toEqual({ x: 640, y: 220 }); // added: authoritative
    });

    it("on a CREATE nothing is preserved — the whole layout is authoritative", () => {
      const p = makeStreamPositions();
      p.place([at("a", 0, 0)]);
      expect(p.settle([at("a", 400, 90)])[0].position).toEqual({
        x: 400,
        y: 90,
      });
    });
  });

  it("copies the seeded positions — a later canvas mutation can't retro-move a settled node", () => {
    const live = { x: 10, y: 10 };
    const p = makeStreamPositions([["a", live]]);
    live.x = 999;
    expect(p.settle([at("a", 0, 0)])[0].position).toEqual({ x: 10, y: 10 });
  });
});
