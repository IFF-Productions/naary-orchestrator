import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { NODE_CATALOG } from "@naary/dsl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildMcpServer,
  type McpToolDeps,
  type McpRunState,
} from "../src/mcp/mcp.server";

// Exercise the real MCP server through a real MCP client over an in-memory transport pair —
// the same client SDK the worker uses to CALL remote servers, now pointed at OUR server.
async function connect(overrides: Partial<McpToolDeps> = {}) {
  const deps: McpToolDeps = {
    tenantId: "t-1",
    listWorkflows: vi.fn().mockResolvedValue([
      {
        workflowKey: "wf-a",
        name: "Flow A",
        version: 3,
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ]),
    getRun: vi.fn().mockResolvedValue({
      status: "completed",
      currentNodeId: "",
      ctx: { agent: { output: "hi" } },
    } satisfies McpRunState),
    runWorkflow: vi.fn().mockResolvedValue({ runId: "exec-new-1" }),
    createWorkflow: vi.fn().mockResolvedValue({
      name: "Drafted",
      graph: { nodes: [], edges: [], startNodeId: "s" },
      saved: false,
    }),
    approve: vi.fn().mockResolvedValue(undefined),
    exposedWorkflows: [],
    ...overrides,
  };
  const server = buildMcpServer(deps);
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, deps };
}

const parse = (res: Awaited<ReturnType<Client["callTool"]>>) =>
  JSON.parse((res.content as { type: string; text: string }[])[0].text);

describe("MCP server", () => {
  let client: Client;
  let deps: McpToolDeps;

  beforeEach(async () => {
    ({ client, deps } = await connect());
  });

  it("advertises the slice-1..4 tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "approve",
      "create_workflow",
      "get_run",
      "list_node_types",
      "list_workflows",
      "run_workflow",
    ]);
  });

  it("approve maps the decision to approved boolean + note", async () => {
    const ok = parse(
      await client.callTool({
        name: "approve",
        arguments: { runId: "exec-9", decision: "approve", note: "lgtm" },
      }),
    );
    expect(ok).toEqual({ runId: "exec-9", decision: "approve", ok: true });
    expect(deps.approve).toHaveBeenCalledWith("exec-9", true, "lgtm");

    await client.callTool({
      name: "approve",
      arguments: { runId: "exec-9", decision: "reject" },
    });
    expect(deps.approve).toHaveBeenCalledWith("exec-9", false, undefined);
  });

  it("approve rejects an invalid decision (schema-enforced enum)", async () => {
    const res = await client.callTool({
      name: "approve",
      arguments: { runId: "exec-9", decision: "maybe" },
    });
    expect(res.isError).toBe(true);
  });

  it("create_workflow forwards its args and returns the draft", async () => {
    const res = parse(
      await client.callTool({
        name: "create_workflow",
        arguments: { prompt: "email me a digest", save: false },
      }),
    );
    expect(res.saved).toBe(false);
    expect(res.name).toBe("Drafted");
    expect(deps.createWorkflow).toHaveBeenCalledWith({
      prompt: "email me a digest",
      save: false,
    });
  });

  it("list_node_types returns the full node catalog", async () => {
    const { nodes } = parse(
      await client.callTool({ name: "list_node_types", arguments: {} }),
    );
    expect(nodes).toHaveLength(Object.keys(NODE_CATALOG).length);
    const types = nodes.map((n: { type: string }) => n.type);
    for (const t of ["agent", "switch", "if", "random", "scheduleTrigger"]) {
      expect(types).toContain(t);
    }
  });

  it("list_workflows returns the tenant's saved workflows", async () => {
    const { workflows } = parse(
      await client.callTool({ name: "list_workflows", arguments: {} }),
    );
    expect(workflows).toEqual([
      {
        workflowKey: "wf-a",
        name: "Flow A",
        version: 3,
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ]);
    expect(deps.listWorkflows).toHaveBeenCalledTimes(1);
  });

  it("run_workflow starts a run with the key + input and returns the runId", async () => {
    const res = parse(
      await client.callTool({
        name: "run_workflow",
        arguments: { workflowKey: "wf-a", input: { issue: 42 } },
      }),
    );
    expect(res).toEqual({ runId: "exec-new-1" });
    expect(deps.runWorkflow).toHaveBeenCalledWith("wf-a", { issue: 42 });
  });

  it("run_workflow requires a workflowKey (schema-enforced)", async () => {
    const res = await client.callTool({ name: "run_workflow", arguments: {} });
    expect(res.isError).toBe(true);
  });

  it("get_run passes the runId through and returns status + ctx", async () => {
    const res = parse(
      await client.callTool({
        name: "get_run",
        arguments: { runId: "exec-123" },
      }),
    );
    expect(res.status).toBe("completed");
    expect(res.ctx).toEqual({ agent: { output: "hi" } });
    expect(deps.getRun).toHaveBeenCalledWith("exec-123");
  });

  it("get_run requires a runId (schema-enforced)", async () => {
    const res = await client.callTool({ name: "get_run", arguments: {} });
    expect(res.isError).toBe(true);
  });

  it("exposes each saved workflow as its own run_<key> tool (flavor B)", async () => {
    const ctx = await connect({
      exposedWorkflows: [
        { workflowKey: "support-reply", name: "Support Reply", version: 1 },
        { workflowKey: "daily digest!", name: "Daily Digest", version: 1 },
      ],
    });
    const names = (await ctx.client.listTools()).tools.map((t) => t.name);
    // hyphens are allowed; other chars sanitize to "_"
    expect(names).toContain("run_support-reply");
    expect(names).toContain("run_daily_digest_");

    const res = parse(
      await ctx.client.callTool({
        name: "run_support-reply",
        arguments: { input: { issue: 7 } },
      }),
    );
    expect(res).toEqual({ runId: "exec-new-1" });
    expect(ctx.deps.runWorkflow).toHaveBeenCalledWith("support-reply", {
      issue: 7,
    });
  });
});
