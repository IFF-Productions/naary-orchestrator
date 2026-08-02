import type { GraphDef } from "@naary/dsl";
import { describe, expect, it } from "vitest";
import type { GenMeter } from "../src/graphs/graph-generator.service";
import {
  deriveTitle,
  estimateTurnCostUsd,
  SAVE_OPTION,
  suggestNextOptions,
  summarizeChange,
} from "../src/builder/turn-metering";

const graph = {
  startNodeId: "n1",
  nodes: [{ id: "n1", type: "start", config: {} }],
  edges: [],
} as unknown as GraphDef;

/**
 * `NOMINAL_TURN_COST_USD` from `src/builder/turn-metering.ts` — the "we could not price this at
 * all" floor. Pinned by value here, and by the third test below, because it is the number the
 * other two must be DISTINGUISHED from.
 *
 * WHY THAT MATTERS. These three tests claim three different behaviours — priced from real usage,
 * estimated from graph size, floored — and all three used to assert the identical
 * `expect(cost).toBeGreaterThan(0)`. Every branch of `estimateTurnCostUsd` returns a positive
 * number (`cost > 0 ? cost : NOMINAL` inside a `try`/`catch { return NOMINAL }`), so `> 0` cannot
 * tell them apart. Measured: make `computeCost` yield 0 — which is what a pricing table that
 * loses `claude-opus-4-8` does — and the first two tests stayed GREEN while every builder turn
 * silently billed the 0.0001 floor instead of its real cost, roughly a 500x under-charge. A test
 * named "prices real reported usage" must fail when nothing was priced.
 */
const NOMINAL_FLOOR = 0.0001;

describe("estimateTurnCostUsd — Tier-1 §6 fail-safe (never zero for a real call)", () => {
  it("prices real reported usage via the shared ledger pricing", () => {
    const meter: GenMeter = {
      provider: "anthropic",
      model: "claude-opus-4-8",
      tokens: { inputTokens: 1000, outputTokens: 2000, cachedInputTokens: 0 },
    };
    const cost = estimateTurnCostUsd(meter, graph);
    // Priced, not floored. Exact value tracked in pricing.ts; the claim here is that the real
    // pricing path ran, which only a number ABOVE the unpriced floor can show.
    expect(cost).toBeGreaterThan(NOMINAL_FLOOR);
  });

  it("ESTIMATES a non-zero cost when the provider reported no usage (claude-code / v6 bug)", () => {
    const meter: GenMeter = {
      provider: "anthropic",
      model: "claude-opus-4-8",
      tokens: null, // subprocess / undefined-usage path
    };
    const cost = estimateTurnCostUsd(meter, graph);
    // Estimated from graph size and then PRICED — so it too must clear the floor. Landing exactly
    // on the floor would mean the estimate never happened, which is the silently-free call.
    expect(cost).toBeGreaterThan(NOMINAL_FLOOR);
  });

  it("falls back to a nominal non-zero floor for an unpriced model", () => {
    const meter = {
      provider: "anthropic",
      model: "totally-made-up-model",
      tokens: { inputTokens: 100, outputTokens: 100, cachedInputTokens: 0 },
    } as unknown as GenMeter;
    const cost = estimateTurnCostUsd(meter, graph);
    // The floor EXACTLY — this is the one test whose subject is the floor, so it pins the value
    // the two above are measured against.
    expect(cost).toBe(NOMINAL_FLOOR);
  });
});

describe("summarizeChange — cheap, non-sensitive (no second model call)", () => {
  it("summarizes node/edge counts with the workflow name (no user text)", () => {
    const g = {
      startNodeId: "n1",
      nodes: [{ id: "n1" }, { id: "n2" }],
      edges: [{ from: "n1", to: "n2" }],
    } as unknown as GraphDef;
    expect(summarizeChange("Onboarding", g)).toBe(
      "Updated “Onboarding” — 2 nodes, 1 edge.",
    );
  });

  it("singularizes and defaults a blank name", () => {
    const g = {
      startNodeId: "n1",
      nodes: [{ id: "n1" }],
      edges: [],
    } as unknown as GraphDef;
    expect(summarizeChange("", g)).toBe(
      "Updated “Workflow” — 1 node, 0 edges.",
    );
  });
});

describe("deriveTitle", () => {
  it("trims, collapses whitespace, and caps at 120 chars", () => {
    expect(deriveTitle("  Add a  Slack   step ")).toBe("Add a Slack step");
    expect(deriveTitle("x".repeat(200))).toHaveLength(120);
  });
});

describe("suggestNextOptions — deterministic quick replies (#487), bounded + total", () => {
  const g = (nodes: unknown[]): GraphDef =>
    ({ startNodeId: "n1", nodes, edges: [] }) as unknown as GraphDef;

  it("suggests every gap for a bare graph, then the accept option last", () => {
    const out = suggestNextOptions(
      g([{ id: "n1", type: "agent", config: {} }]),
    );
    expect(out).toEqual([
      "Add an approval step",
      "Add an email notification",
      "Add error handling",
      SAVE_OPTION,
    ]);
  });

  it("drops a suggestion once the graph already has that node type", () => {
    const out = suggestNextOptions(
      g([
        { id: "n1", type: "humanApproval" },
        { id: "n2", type: "sendEmail", config: {} },
        { id: "n3", type: "stopAndError", config: {} },
      ]),
    );
    // All three gaps are filled → only the accept option remains.
    expect(out).toEqual([SAVE_OPTION]);
  });

  it("treats a continue-on-error node as error handling", () => {
    const out = suggestNextOptions(
      g([{ id: "n1", type: "httpRequest", config: {}, onError: "continue" }]),
    );
    expect(out).not.toContain("Add error handling");
    expect(out).toContain(SAVE_OPTION);
  });

  it("is total — an empty/undefined graph still returns the accept option and never throws", () => {
    expect(suggestNextOptions({ nodes: [] } as unknown as GraphDef)).toContain(
      SAVE_OPTION,
    );
    expect(suggestNextOptions({} as unknown as GraphDef)).toEqual([
      "Add an approval step",
      "Add an email notification",
      "Add error handling",
      SAVE_OPTION,
    ]);
  });

  it("caps edit suggestions at three plus the accept (bounded)", () => {
    const out = suggestNextOptions(
      g([{ id: "n1", type: "agent", config: {} }]),
    );
    expect(out.length).toBeLessThanOrEqual(4);
    expect(out[out.length - 1]).toBe(SAVE_OPTION);
  });
});
