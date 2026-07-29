import { describe, expect, it } from "vitest";
import {
  apiEnrichGraph,
  dbReportGraph,
  feedDigestGraph,
  githubIssueTriageGraph,
  jiraTicketGraph,
  moderationGraph,
  supportReplyGraph,
} from "../src";
import { validateGraph } from "../src/validate-graph";
import type { GraphDef } from "../src/types";

// Product starter templates: a shipped template with a broken graph is a bad first
// impression (it won't open on the canvas), so assert every one is structurally
// valid — the same check the API + canvas run before saving.
const TEMPLATES: Record<string, GraphDef> = {
  feedDigestGraph,
  supportReplyGraph,
  dbReportGraph,
  moderationGraph,
  apiEnrichGraph,
  githubIssueTriageGraph,
  jiraTicketGraph,
};

describe("starter templates", () => {
  for (const [name, graph] of Object.entries(TEMPLATES)) {
    describe(name, () => {
      it("passes validateGraph", () => {
        expect(validateGraph(graph)).toEqual({ valid: true });
      });

      it("startNodeId resolves to a node", () => {
        expect(graph.nodes.map((n) => n.id)).toContain(graph.startNodeId);
      });

      it("has an end/terminal node and every edge endpoint exists", () => {
        const ids = new Set(graph.nodes.map((n) => n.id));
        for (const e of graph.edges) {
          expect(ids.has(e.from)).toBe(true);
          expect(ids.has(e.to)).toBe(true);
        }
        // reaches a terminal (end or respondToWebhook or stopAndError)
        const terminals = graph.nodes.filter((n) =>
          ["end", "respondToWebhook", "stopAndError"].includes(n.type),
        );
        expect(terminals.length).toBeGreaterThan(0);
      });
    });
  }
});
