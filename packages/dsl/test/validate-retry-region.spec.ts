// The SAVE GATE half of retry regions.
//
// `computeRetryRegions` deciding correctly is worth nothing if the save path doesn't ask it. This
// is the seam that turns a structurally unsafe graph into a correctable 400 instead of a run that
// sends an email twice — the same reason `computeItemsRegions` is called from here.
import { describe, expect, it } from "vitest";
import { validateGraph } from "../src/validate-graph";
import type { GraphDef, NodeDef } from "../src/types";

const node = (id: string, type: string, config?: NodeDef["config"]): NodeDef =>
  ({ id, type, config }) as NodeDef;

function graphWith(body: NodeDef[]): GraphDef {
  const ids = ["r", ...body.map((b) => b.id), "rend"];
  return {
    startNodeId: "trigger",
    nodes: [
      node("trigger", "webhookTrigger"),
      node("r", "retry"),
      ...body,
      node("rend", "retryEnd"),
      node("end", "end"),
    ],
    edges: [
      { from: "trigger", to: "r" },
      ...ids.slice(0, -1).map((from, i) => ({ from, to: ids[i + 1] })),
      { from: "rend", to: "end" },
    ],
  } as GraphDef;
}

describe("validateGraph — retry regions", () => {
  it("accepts a region of repeatable nodes", () => {
    const res = validateGraph(
      graphWith([
        node("fetch", "httpRequest", { url: "https://api.example.com" }),
        node("parse", "json", { operation: "parse", from: "fetch" }),
      ]),
    );
    expect(res.valid).toBe(true);
  });

  it("REFUSES a region containing an unrepeatable node, naming it", () => {
    // The point of the gate. Without this the graph saves, runs, and sends twice.
    const res = validateGraph(graphWith([node("notify-ops", "sendEmail")]));
    expect(res.valid).toBe(false);
    expect(res.error).toContain("notify-ops");
    expect(res.error).toMatch(/can't be safely repeated/);
  });

  it("REFUSES an integration write inside a region", () => {
    const res = validateGraph(
      graphWith([
        node("create", "integration", {
          provider: "github",
          action: "create_issue",
        }),
      ]),
    );
    expect(res.valid).toBe(false);
    expect(res.error).toContain("create");
  });

  it("REFUSES an unclosed region, and says the bracket is the problem", () => {
    const g: GraphDef = {
      startNodeId: "trigger",
      nodes: [
        node("trigger", "webhookTrigger"),
        node("r", "retry"),
        node("fetch", "httpRequest", { url: "https://x" }),
        node("end", "end"),
      ],
      edges: [
        { from: "trigger", to: "r" },
        { from: "r", to: "fetch" },
        { from: "fetch", to: "end" },
      ],
    } as GraphDef;
    const res = validateGraph(g);
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/no matching retryEnd/);
  });

  it("leaves a graph with NO retry nodes exactly as it was", () => {
    // The gate must be inert for the overwhelming majority of graphs — a new check that changes
    // the verdict on existing workflows would fail saves nobody asked it to.
    const g: GraphDef = {
      startNodeId: "trigger",
      nodes: [
        node("trigger", "webhookTrigger"),
        node("mail", "sendEmail"),
        node("end", "end"),
      ],
      edges: [
        { from: "trigger", to: "mail" },
        { from: "mail", to: "end" },
      ],
    } as GraphDef;
    // `sendEmail` is refused INSIDE a region and perfectly fine outside one.
    expect(validateGraph(g).valid).toBe(true);
  });
});
