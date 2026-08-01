// The pure half of the diff presentation: is there anything to show, and how much.
//
// `apps/web`'s vitest environment is `node` (no jsdom / testing-library), so the ROWS are covered
// by the Canvas/GraphDiffBody stories instead. What matters here is the two predicates callers
// branch on — an "empty" verdict that misses a change would render a diff panel that silently
// claims nothing happened, which is the failure this whole feature exists to prevent.
import { describe, expect, it } from "vitest";
import type { GraphDiff } from "@naary/dsl";
import {
  diffCounts,
  isEmptyDiff,
} from "../src/screens/app/workflows/GraphDiffBody";

const EMPTY: GraphDiff = {
  nodesAdded: [],
  nodesRemoved: [],
  nodesChanged: [],
  edgesAdded: [],
  edgesRemoved: [],
  edgesChanged: [],
  edgesReordered: false,
  startNodeChanged: false,
};

const node = (id: string) =>
  ({ id, type: "set" }) as GraphDiff["nodesAdded"][number];
const edge = (from: string, to: string) =>
  ({ from, to }) as GraphDiff["edgesAdded"][number];
const changedNode = (id: string): GraphDiff["nodesChanged"][number] => ({
  id,
  before: node(id),
  after: node(id),
  fields: ["config"],
  details: [
    { path: "config.url", kind: "changed", before: '"a"', after: '"b"' },
  ],
  detailsOmitted: 0,
});

describe("isEmptyDiff", () => {
  it("is empty only when nothing at all changed", () => {
    expect(isEmptyDiff(EMPTY)).toBe(true);
  });

  // Every field, one at a time: a predicate that forgets one makes the panel lie.
  const cases: [string, Partial<GraphDiff>][] = [
    ["a node added", { nodesAdded: [node("a")] }],
    ["a node removed", { nodesRemoved: [node("a")] }],
    ["a node changed", { nodesChanged: [changedNode("a")] }],
    ["an edge added", { edgesAdded: [edge("a", "b")] }],
    ["an edge removed", { edgesRemoved: [edge("a", "b")] }],
    // An edited edge CONDITION (#1020). It adds and removes nothing and reorders nothing, so a
    // predicate that forgets it reports "no changes" for a rerouted branch.
    [
      "an edge condition changed",
      {
        edgesChanged: [
          { from: "a", to: "b", after: { path: "x", op: "eq", value: 1 } },
        ],
      },
    ],
    // Both of these are behaviour changes with no node/edge SET change at all, which is exactly
    // why they need their own flags: edge order decides branch precedence, and the entry node
    // decides where the run starts.
    ["edges reordered", { edgesReordered: true }],
    ["the start node changed", { startNodeChanged: true }],
  ];

  for (const [label, patch] of cases) {
    it(`is NOT empty when ${label}`, () => {
      expect(isEmptyDiff({ ...EMPTY, ...patch })).toBe(false);
    });
  }
});

describe("diffCounts", () => {
  it("counts nodes and edges together, by kind", () => {
    expect(
      diffCounts({
        ...EMPTY,
        nodesAdded: [node("a"), node("b")],
        edgesAdded: [edge("a", "b")],
        nodesRemoved: [node("c")],
        nodesChanged: [changedNode("d")],
      }),
    ).toEqual({ add: 3, chg: 1, del: 1, total: 5 });
  });

  it("counts an edited edge condition as ONE change, not an add plus a delete", () => {
    // The old diff reported this as edgesAdded:1 + edgesRemoved:1 — "+1 added, −1 removed" for an
    // edit that moved a threshold and nothing else.
    expect(
      diffCounts({
        ...EMPTY,
        edgesChanged: [
          {
            from: "a",
            to: "b",
            before: { path: "x", op: "gt", value: 5 },
            after: { path: "x", op: "gt", value: 10 },
          },
        ],
      }),
    ).toEqual({ add: 0, chg: 1, del: 0, total: 1 });
  });

  it("counts a reorder and a start-node change as changes", () => {
    // Neither adds or removes anything, so without this they'd render as "0 changes" beside a
    // panel that is visibly showing two rows.
    expect(
      diffCounts({ ...EMPTY, edgesReordered: true, startNodeChanged: true }),
    ).toEqual({ add: 0, chg: 2, del: 0, total: 2 });
  });

  it("is all zeroes for an empty diff", () => {
    expect(diffCounts(EMPTY)).toEqual({ add: 0, chg: 0, del: 0, total: 0 });
  });
});
