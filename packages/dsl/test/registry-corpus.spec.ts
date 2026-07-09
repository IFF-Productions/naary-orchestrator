import { describe, expect, it } from "vitest";
import {
  apiEnrichGraph,
  dbReportGraph,
  feedDigestGraph,
  githubReviewGraph,
  httpEnrichGraph,
  moderationGraph,
  sampleGraph,
  sqlEnrichGraph,
  supportReplyGraph,
  webhookSampleGraph,
} from "../src";
import type { GraphDef } from "../src/types";
import { nodeConfigSchema, validateGraphConfigs } from "../src/registry";

/**
 * RUNTIME-acceptance oracle (not just type parity): every node config in the in-repo graph corpus
 * must `safeParse` against its node's schema. If it doesn't, wiring the schema into the save path
 * would reject a known-good workflow — a worse regression than the untyped status quo. This lands
 * on the riskiest schemas: number-keyed sqlQuery/sqlExec paramBindings and the interface-less agent.
 */
const CORPUS: Record<string, GraphDef> = {
  sampleGraph,
  webhookSampleGraph,
  githubReviewGraph,
  httpEnrichGraph,
  sqlEnrichGraph,
  feedDigestGraph,
  supportReplyGraph,
  dbReportGraph,
  moderationGraph,
  apiEnrichGraph,
};

describe("registry — corpus round-trip (runtime acceptance)", () => {
  for (const [name, graph] of Object.entries(CORPUS)) {
    it(`accepts every node config in ${name}`, () => {
      for (const node of graph.nodes) {
        const res = nodeConfigSchema(node.type).safeParse(node.config ?? {});
        expect(
          res.success,
          `${name}.${node.id} (${node.type}) rejected: ${
            res.success ? "" : JSON.stringify(res.error.issues)
          }`,
        ).toBe(true);
      }
    });
  }

  it("the save gate (validateGraphConfigs) passes every corpus graph — no false rejections", () => {
    for (const [name, graph] of Object.entries(CORPUS)) {
      expect(validateGraphConfigs(graph), name).toEqual([]);
    }
  });

  it("specifically accepts number-keyed sqlExec/sqlQuery paramBindings", () => {
    // JSON object keys are strings ({"1": …}); prove zod v4's z.record(z.number(), …) accepts it.
    const cfg = {
      connectionId: "c",
      sql: "update t set x=$1 where id=$2",
      params: [1, 2],
      paramBindings: { 1: { from: "n", path: "a" }, 2: { from: "m" } },
    };
    expect(nodeConfigSchema("sqlExec").safeParse(cfg).success).toBe(true);
  });
});
