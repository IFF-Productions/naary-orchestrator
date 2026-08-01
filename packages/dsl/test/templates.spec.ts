import { describe, expect, it } from "vitest";
import {
  apiEnrichGraph,
  budgetCappedResearchGraph,
  codeAgentPrGraph,
  dbReportGraph,
  escalationGraph,
  feedDigestGraph,
  formToDbGraph,
  githubIssueTriageGraph,
  jiraTicketGraph,
  mcpServerToolGraph,
  moderationGraph,
  ragAnswerGraph,
  ragIngestGraph,
  supervisorHandoffGraph,
  supportReplyGraph,
} from "../src";
import {
  agentOutputReads,
  promisedAgentFields,
} from "../src/agent-output-contract";
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

/**
 * A SHIPPED TEMPLATE MAY NOT READ A FIELD ITS AGENT NEVER PROMISED (#830).
 *
 * The generalisation of "the prompt says so": three templates told an agent to "respond with ONLY
 * a JSON object", then read `output.flagged` / `output.summary` / `output.issueType` downstream —
 * but an agent returns a structured object ONLY when its config carries an `outputSchema`, and
 * these had none. So every one of those fields was `undefined` at run time, and each template
 * failed in the quiet direction rather than erroring:
 *
 *   - `moderationGraph` — `flagged` undefined ⇒ `eq true` never matched and `neq true` always did,
 *     so the gate failed OPEN: every submission auto-accepted, human review unreachable.
 *   - `githubIssueTriageGraph` — the triage comment posted an empty body and no labels were set.
 *   - `jiraTicketGraph` — create_issue called with empty required args, after a human had already
 *     approved a ticket the run could not create.
 *
 * A prompt is a request; the schema is the contract. This asserts the contract exists for every
 * cross-node read, so the next template can't ship with the same hole. Deliberately checks the
 * ADVANCED templates too — they happen to be correct today, and this is what keeps them that way.
 */
describe("templates — every agent output a template reads is one its schema declares", () => {
  const ALL: Record<string, GraphDef> = {
    ...TEMPLATES,
    supervisorHandoffGraph,
    ragAnswerGraph,
    ragIngestGraph,
    codeAgentPrGraph,
    budgetCappedResearchGraph,
    mcpServerToolGraph,
    formToDbGraph,
    escalationGraph,
  };

  // `promisedAgentFields` and `agentOutputReads` used to live here as local helpers. They moved
  // into `src/agent-output-contract.ts` for #1016, because the canvas lint and the fork
  // migration have to answer the SAME two questions about tenant-authored graphs — and three
  // copies of "what does this node promise" would be exactly the drift this guard exists to
  // catch. This spec still owns the assertion; it no longer owns the definition.

  for (const [name, graph] of Object.entries(ALL)) {
    it(`${name}: reads only declared agent fields`, () => {
      const byId = new Map(graph.nodes.map((n) => [n.id, n]));
      for (const { from, field } of agentOutputReads(graph)) {
        const node = byId.get(from);
        if (node?.type !== "agent") continue; // only agents have an outputSchema contract
        expect(
          [...promisedAgentFields(node)],
          `${name}: node "${from}" is read for "${field}", which its outputSchema does not declare — it would be undefined at run time`,
        ).toContain(field);
      }
    });
  }
});
