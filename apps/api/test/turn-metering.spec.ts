import type { GraphDef } from "@naary/dsl";
import { describe, expect, it } from "vitest";
import type { GenMeter } from "../src/graphs/graph-generator.service";
import {
  deriveTitle,
  estimateTurnCostUsd,
  summarizeChange,
} from "../src/builder/turn-metering";

const graph = {
  startNodeId: "n1",
  nodes: [{ id: "n1", type: "start", config: {} }],
  edges: [],
} as unknown as GraphDef;

describe("estimateTurnCostUsd — Tier-1 §6 fail-safe (never zero for a real call)", () => {
  it("prices real reported usage via the shared ledger pricing", () => {
    const meter: GenMeter = {
      provider: "anthropic",
      model: "claude-opus-4-8",
      tokens: { inputTokens: 1000, outputTokens: 2000, cachedInputTokens: 0 },
    };
    const cost = estimateTurnCostUsd(meter, graph);
    // A concrete positive number (opus is priced); exact value tracked in pricing.ts.
    expect(cost).toBeGreaterThan(0);
  });

  it("ESTIMATES a non-zero cost when the provider reported no usage (claude-code / v6 bug)", () => {
    const meter: GenMeter = {
      provider: "anthropic",
      model: "claude-opus-4-8",
      tokens: null, // subprocess / undefined-usage path
    };
    const cost = estimateTurnCostUsd(meter, graph);
    expect(cost).toBeGreaterThan(0); // estimated from graph size, never silently free
  });

  it("falls back to a nominal non-zero floor for an unpriced model", () => {
    const meter = {
      provider: "anthropic",
      model: "totally-made-up-model",
      tokens: { inputTokens: 100, outputTokens: 100, cachedInputTokens: 0 },
    } as unknown as GenMeter;
    const cost = estimateTurnCostUsd(meter, graph);
    expect(cost).toBeGreaterThan(0);
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
