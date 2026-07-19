import * as path from "node:path";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TASK_QUEUE, stateQuery } from "@naary/contracts";
import type { GraphDef } from "@naary/dsl";
import { MemoryObjectStore, __setObjectStore } from "@naary/storage";
import * as activities from "../src/temporal/activities";
import { runGraph } from "../src/temporal/workflows";
import { createLocalTestEnv } from "./local-test-env";

/**
 * LIVE end-to-end for the mcpTool node against a REAL remote MCP server.
 *
 *   webhookTrigger → mcpTool(call a tool) → end
 *
 * Proves the full remote path: the real MCP client transport connects to your server URL, sends the
 * auth header, invokes the named tool, and surfaces its content back into the run context.
 *
 * SKIPPED unless MCP_TEST_URL and MCP_TEST_TOOL are set:
 *   MCP_TEST_URL    the server endpoint (e.g. https://mcp.example.com/mcp)
 *   MCP_TEST_TOOL   a SAFE, ideally read-only tool to invoke (e.g. "search", "list_tables")
 *   MCP_TEST_TOKEN  optional bearer token, if the server requires auth
 *   MCP_TEST_ARGS   optional JSON object of tool arguments (default "{}")
 *
 * Run: export those, then `pnpm test:live` (or `... mcp-tool.live`).
 *
 * REAL vs seamed: the interpreter and the real MCP client call run for real. Only the connection→
 * target resolution is injected (__mcpDeps.resolveMcpTarget → the env URL + bearer header) so we
 * need no seeded connection; the actual protocol call (__mcpDeps.callMcpTool) is untouched.
 */

const WORKFLOWS_PATH = path.join(__dirname, "../src/temporal/workflows.ts");

const MCP_URL = process.env.MCP_TEST_URL;
const MCP_TOOL = process.env.MCP_TEST_TOOL;
const MCP_TOKEN = process.env.MCP_TEST_TOKEN;
const LIVE = Boolean(MCP_URL && MCP_TOOL);

// Parse optional tool args once; a malformed value should fail loudly, not silently send {}.
const MCP_ARGS: Record<string, unknown> = (() => {
  const raw = process.env.MCP_TEST_ARGS;
  if (!raw) return {};
  return JSON.parse(raw) as Record<string, unknown>;
})();

let env: TestWorkflowEnvironment;

describe.skipIf(!LIVE)("LIVE mcpTool — real remote MCP server", () => {
  beforeAll(async () => {
    env = await createLocalTestEnv();
    __setObjectStore(new MemoryObjectStore());

    // Connection→target seam only: point at the env server + optional bearer. The real MCP client
    // call, transport, and SSRF guard are untouched (a public server URL passes the guard).
    activities.__mcpDeps.resolveMcpTarget = (async () => ({
      serverUrl: MCP_URL as string,
      headers: MCP_TOKEN ? { Authorization: `Bearer ${MCP_TOKEN}` } : {},
    })) as never;
  }, 120_000);

  afterAll(async () => {
    await env?.teardown();
  });

  function makeWorker(): Promise<Worker> {
    return Worker.create({
      connection: env.nativeConnection,
      taskQueue: TASK_QUEUE,
      workflowsPath: WORKFLOWS_PATH,
      activities: {
        ...activities,
        recordExecution: async () => undefined,
        setExecutionStatus: async () => undefined,
        loadVariables: async () => ({}),
      },
    });
  }

  it("invokes a real MCP tool and surfaces its content to the run", async () => {
    const graph: GraphDef = {
      startNodeId: "hook",
      nodes: [
        { id: "hook", type: "webhookTrigger", config: {} as never },
        {
          id: "mcp",
          type: "mcpTool",
          config: {
            connectionId: "mcp-live",
            tool: MCP_TOOL as string,
            arguments: MCP_ARGS,
          } as never,
        },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "hook", to: "mcp" },
        { from: "mcp", to: "end" },
      ],
    };

    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [graph, { event: "e2e" }, { tenantId: "t-live-mcp" }],
        taskQueue: TASK_QUEUE,
        workflowId: "live-mcp-tool",
      });
      const result = await handle.result();
      expect(result.status).toBe("completed");

      const final = await handle.query(stateQuery);
      const out = final.ctx.mcp as { status: string; content: unknown };
      // The tool call succeeded (a tool-level error would have failed the run) and returned content.
      expect(out.status).toBe("ok");
      expect(out.content).toBeDefined();
      expect(out.content).not.toBeNull();
    });
  });
});
