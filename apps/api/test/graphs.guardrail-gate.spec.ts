// Agent guardrails (#576 AC1, save half) — GraphsService.upsert refuses a graph whose tools the
// workspace policy forbids, and refuses a forced-approval tool placed inside an agent's tool loop.
import { BadRequestException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentGuardrailPolicy, GraphDef } from "@naary/dsl";

const findFirst = vi.fn();
const create = vi.fn();
vi.mock("@naary/db", () => ({
  // #904: this spec has no renamed workflows, so the alias resolver is the identity. A spec
  // that DOES exercise aliases stubs it to return the live key (see workflow-key-alias.spec.ts).
  resolveWorkflowKey: async (_t: string, k: string) => k,
  getPrisma: () => ({
    graphDefinition: { findFirst, create },
  }),
}));

import { GraphsService } from "../src/graphs/graphs.service";
import type { GuardrailsService } from "../src/settings/guardrails.service";

let policy: AgentGuardrailPolicy = {};
const guardrails = {
  get: () => Promise.resolve(policy),
} as unknown as GuardrailsService;

const withAgentTool = (tool: string): GraphDef =>
  ({
    startNodeId: "a",
    nodes: [
      {
        id: "a",
        type: "agent",
        config: {
          provider: "anthropic",
          model: "claude-opus-4-8",
          tools: [{ connectionId: "c1", tool }],
        },
      },
      { id: "z", type: "end" },
    ],
    edges: [{ from: "a", to: "z" }],
  }) as unknown as GraphDef;

const withToolNode = (tool: string): GraphDef =>
  ({
    startNodeId: "m",
    nodes: [
      { id: "m", type: "mcpTool", config: { connectionId: "c1", tool } },
      { id: "z", type: "end" },
    ],
    edges: [{ from: "m", to: "z" }],
  }) as unknown as GraphDef;

/** A service wired WITH the policy reader (the production shape). */
const gated = () => new GraphsService(undefined, undefined, guardrails);

beforeEach(() => {
  policy = {};
  findFirst.mockReset().mockResolvedValue(null); // new workflowKey
  create
    .mockReset()
    .mockImplementation(({ data }: { data: object }) =>
      Promise.resolve({ ...data, version: 1 }),
    );
});

describe("GraphsService.upsert — guardrail tool policy gate", () => {
  it("rejects a DENIED agent tool with a message naming the node and the ref", async () => {
    policy = { tools: { deny: ["delete_*"] } };
    await expect(
      gated().upsert("t1", "e1", "wf", "WF", withAgentTool("delete_file")),
    ).rejects.toThrow(BadRequestException);
    await expect(
      gated().upsert("t1", "e1", "wf", "WF", withAgentTool("delete_file")),
    ).rejects.toThrow(/Guardrail policy — a \(agent\): tool 'c1:delete_file'/);
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a DENIED standalone tool node too", async () => {
    policy = { tools: { deny: ["delete_*"] } };
    await expect(
      gated().upsert("t1", "e1", "wf", "WF", withToolNode("delete_file")),
    ).rejects.toThrow(/blocked by this workspace/);
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a FORCED-APPROVAL tool inside an agent's tool loop, pointing at the standalone node", async () => {
    policy = { tools: { requireApproval: ["wire_money"] } };
    await expect(
      gated().upsert("t1", "e1", "wf", "WF", withAgentTool("wire_money")),
    ).rejects.toThrow(/standalone Tool\/Integration node/);
    expect(create).not.toHaveBeenCalled();
  });

  it("ACCEPTS the same forced-approval tool as a standalone node (that is where the pause lives)", async () => {
    policy = { tools: { requireApproval: ["wire_money"] } };
    const snap = await gated().upsert(
      "t1",
      "e1",
      "wf",
      "WF",
      withToolNode("wire_money"),
    );
    expect(snap.version).toBe(1);
    expect(create).toHaveBeenCalledOnce();
  });

  it("saves normally when no policy is configured", async () => {
    policy = {};
    await gated().upsert("t1", "e1", "wf", "WF", withAgentTool("delete_file"));
    expect(create).toHaveBeenCalledOnce();
  });

  it("skips the gate (and does not crash) when the policy reader is not wired", async () => {
    // The gate is DEFENSE IN DEPTH — the worker enforces the same policy in-activity — so an
    // unwired service must save rather than fail closed on a construction detail.
    policy = { tools: { deny: ["delete_*"] } };
    await new GraphsService().upsert(
      "t1",
      "e1",
      "wf",
      "WF",
      withAgentTool("delete_file"),
    );
    expect(create).toHaveBeenCalledOnce();
  });
});
