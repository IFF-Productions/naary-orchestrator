/**
 * The canvas's unsaved-changes rule. It decides whether the user is warned before navigating
 * away, before closing the tab, and whether Test / Check flow have to ask to save first — so the
 * cases below are the ones a wrong answer is felt in: a false "dirty" nags on a canvas nobody
 * touched, a false "clean" loses work silently.
 */
import { describe, expect, it } from "vitest";
import type { GraphDef } from "@naary/dsl";
import {
  isCanvasDirty,
  savedWorkflowName,
  UNTITLED_WORKFLOW,
} from "../src/screens/canvas/canvas-dirty";

const graph: GraphDef = {
  startNodeId: "start",
  nodes: [
    { id: "start", type: "start" },
    { id: "notify", type: "email", config: { to: "ops@example.com" } },
  ],
  edges: [{ from: "start", to: "notify" }],
};

const baseline = { graph, name: "Refund triage" };

describe("isCanvasDirty", () => {
  it("is CLEAN before a baseline is captured (a fresh mount has nothing to compare)", () => {
    expect(
      isCanvasDirty({ baseline: null, graph, name: "Refund triage" }),
    ).toBe(false);
  });

  it("is CLEAN with no baseline AND no compilable graph (nothing to describe)", () => {
    expect(
      isCanvasDirty({ baseline: null, graph: undefined, name: "Anything" }),
    ).toBe(false);
  });

  it("is CLEAN for a loaded, untouched canvas (a structurally equal recompile)", () => {
    // What the canvas actually hands back after a load: the same graph re-created by
    // decompile→compile, so it is a different object — and node ORDER may differ.
    const recompiled: GraphDef = {
      ...structuredClone(graph),
      nodes: [...structuredClone(graph).nodes].reverse(),
    };
    expect(
      isCanvasDirty({ baseline, graph: recompiled, name: "Refund triage" }),
    ).toBe(false);
  });

  it("is DIRTY once a node's config is edited", () => {
    const edited = structuredClone(graph);
    edited.nodes[1].config = { to: "someone-else@example.com" };
    expect(
      isCanvasDirty({ baseline, graph: edited, name: "Refund triage" }),
    ).toBe(true);
  });

  it("is DIRTY once a node is added", () => {
    const edited = structuredClone(graph);
    edited.nodes.push({ id: "end", type: "end" });
    edited.edges.push({ from: "notify", to: "end" });
    expect(
      isCanvasDirty({ baseline, graph: edited, name: "Refund triage" }),
    ).toBe(true);
  });

  it("is DIRTY on a RENAME alone, with the graph untouched", () => {
    expect(isCanvasDirty({ baseline, graph, name: "Refund triage v2" })).toBe(
      true,
    );
  });

  it("is CLEAN when only the title's surrounding whitespace changed (a save trims it)", () => {
    expect(isCanvasDirty({ baseline, graph, name: "  Refund triage  " })).toBe(
      false,
    );
  });

  it("is CLEAN when a blank title is compared against the name a blank title saves as", () => {
    expect(
      isCanvasDirty({
        baseline: { graph, name: UNTITLED_WORKFLOW },
        graph,
        name: "   ",
      }),
    ).toBe(false);
  });

  it("is DIRTY when the canvas no longer compiles (it was edited into that state)", () => {
    // The most important case to get right: an uncompilable graph is unsavable work, which is
    // exactly the work worth warning about — and `undefined` must not read as "no changes".
    expect(
      isCanvasDirty({ baseline, graph: undefined, name: "Refund triage" }),
    ).toBe(true);
  });

  it("is DIRTY for a never-saved canvas the user has since edited", () => {
    // A never-saved canvas baselines on the seed graph it was first presented with, so editing
    // it is dirty even though there is no saved version to diff against.
    const seedBaseline = { graph, name: UNTITLED_WORKFLOW };
    const edited = structuredClone(graph);
    edited.nodes[1].name = "Tell the on-call";
    expect(
      isCanvasDirty({
        baseline: seedBaseline,
        graph: edited,
        name: UNTITLED_WORKFLOW,
      }),
    ).toBe(true);
  });
});

describe("savedWorkflowName", () => {
  it("trims, and falls back to the untitled name for a blank title", () => {
    expect(savedWorkflowName("  Refund triage ")).toBe("Refund triage");
    expect(savedWorkflowName("   ")).toBe(UNTITLED_WORKFLOW);
  });
});
