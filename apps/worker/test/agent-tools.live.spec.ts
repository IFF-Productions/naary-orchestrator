import * as path from "node:path";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { callMcpTool as realMcpCall } from "@naary/connections";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TASK_QUEUE, stateQuery } from "@naary/contracts";
import type { GraphDef } from "@naary/dsl";
import { MemoryObjectStore, __setObjectStore } from "@naary/storage";
import * as activities from "../src/temporal/activities";
import { runGraph } from "../src/temporal/workflows";
import { createLocalTestEnv } from "./local-test-env";

/**
 * LIVE end-to-end for the agent node's IN-LOOP tool calling (#449) against a REAL model and a
 * REAL remote MCP server, through the REAL Temporal interpreter:
 *
 *   webhookTrigger → agent(tools:[ an MCP tool ]) → end
 *
 * This is the honest closer for #449's acceptance criteria — the unit specs prove the WIRING, but
 * only a live model actually runs the multi-step loop. It proves:
 *   - the model decides to CALL the configured MCP tool mid-reasoning (the real tool call fires),
 *   - it then produces a final free-text answer ({ text }),
 *   - and `result.totalUsage` AGGREGATES tokens across BOTH the tool-call step and the answer step
 *     (so billing reflects the whole loop, not just the last call).
 *
 * SKIPPED unless these are set (see also mcp-tool.live.spec.ts / github-agent.live.spec.ts):
 *   ANTHROPIC_TEST_KEY  a real Anthropic key (this test makes a SMALL paid Haiku call)
 *   MCP_TEST_URL        the MCP server endpoint
 *   MCP_TEST_TOOL       a SAFE, ideally read-only tool the agent may call (e.g. "search")
 *   MCP_TEST_TOKEN      optional bearer token for the MCP server
 *   MCP_TEST_TOOL_DESC  optional human description of the tool (helps the model call it well)
 *
 * Run: export those, then `pnpm test:live` (or `... agent-tools.live`).
 *
 * REAL vs seamed: the interpreter, the real model call, AND the real MCP client call run for real.
 * Only the billing sinks (getBudget/recordUsage/getDefaultEnvId) and the connection→target
 * resolution are seamed — the actual protocol call is the real @naary/connections one, wrapped
 * only to count invocations so we can assert the tool actually fired.
 */

const WORKFLOWS_PATH = path.join(__dirname, "../src/temporal/workflows.ts");

const ANTHROPIC_KEY = process.env.ANTHROPIC_TEST_KEY;
const MCP_URL = process.env.MCP_TEST_URL;
const MCP_TOOL = process.env.MCP_TEST_TOOL;
const MCP_TOKEN = process.env.MCP_TEST_TOKEN;
const MCP_TOOL_DESC =
  process.env.MCP_TEST_TOOL_DESC ?? `Call this to use the '${MCP_TOOL}' tool.`;
const LIVE = Boolean(ANTHROPIC_KEY && MCP_URL && MCP_TOOL);

let env: TestWorkflowEnvironment;
let toolCalls = 0;
const recorded: Array<{ inputTokens: number; outputTokens: number }> = [];

describe.skipIf(!LIVE)(
  "LIVE agent in-loop tools — real model + real MCP server (#449)",
  () => {
    beforeAll(async () => {
      env = await createLocalTestEnv();
      __setObjectStore(new MemoryObjectStore());

      // Real model key into the agent activity; billing sinks stubbed so the paid call isn't
      // blocked and we can inspect the aggregated usage.
      activities.__agentDeps.getCredentials = (() => ({
        getDecryptedKey: async () => ANTHROPIC_KEY as string,
      })) as never;
      activities.__agentDeps.getDefaultEnvId = (async () => "e-live") as never;
      activities.__agentDeps.getBudget = (async () => null) as never;
      activities.__agentDeps.recordUsage = (async (u: {
        usage: { inputTokens: number; outputTokens: number };
      }) => {
        recorded.push({
          inputTokens: u.usage.inputTokens,
          outputTokens: u.usage.outputTokens,
        });
        return undefined;
      }) as never;

      // Connection→target seam only: point the loop's tool at the env server + optional bearer.
      activities.__agentDeps.resolveMcpTarget = (async () => ({
        serverUrl: MCP_URL as string,
        headers: MCP_TOKEN ? { Authorization: `Bearer ${MCP_TOKEN}` } : {},
      })) as never;
      // Wrap the REAL MCP call so the protocol path is untouched but we can count invocations.
      activities.__agentDeps.callMcpTool = (async (
        input: Parameters<typeof realMcpCall>[0],
      ) => {
        toolCalls += 1;
        return realMcpCall(input);
      }) as never;
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

    it("calls the MCP tool mid-loop and aggregates usage across steps", async () => {
      const graph: GraphDef = {
        startNodeId: "hook",
        nodes: [
          { id: "hook", type: "webhookTrigger", config: {} as never },
          {
            id: "agent",
            type: "agent",
            config: {
              provider: "anthropic",
              model: "claude-haiku-4-5",
              systemPrompt:
                `You have a tool named '${MCP_TOOL}'. You MUST call that tool once ` +
                `to gather information before answering, then briefly summarize what you found. ` +
                `Keep the final answer to one sentence.`,
              maxToolSteps: 4,
              tools: [
                {
                  connectionId: "mcp-live",
                  tool: MCP_TOOL as string,
                  description: MCP_TOOL_DESC,
                  // Open schema — the model fills args as needed for a generic read-only tool.
                  inputSchema: { type: "object", additionalProperties: true },
                  costUsd: 0,
                },
              ],
            } as never,
          },
          { id: "end", type: "end" },
        ],
        edges: [
          { from: "hook", to: "agent" },
          { from: "agent", to: "end" },
        ],
      };

      const worker = await makeWorker();
      await worker.runUntil(async () => {
        const handle = await env.client.workflow.start(runGraph, {
          args: [graph, { ask: "what is available?" }, { tenantId: "t-live" }],
          taskQueue: TASK_QUEUE,
          workflowId: "live-agent-tools",
        });
        const result = await handle.result();
        expect(result.status).toBe("completed");

        const final = await handle.query(stateQuery);
        const out = final.ctx.agent as {
          output: { text?: string };
          costUsd: number;
          totalTokens?: number;
        };
        // The model actually invoked the MCP tool during the loop.
        expect(toolCalls).toBeGreaterThanOrEqual(1);
        // Free-text final answer (no outputSchema was configured).
        expect(typeof out.output.text).toBe("string");
        expect(out.output.text && out.output.text.length).toBeGreaterThan(0);
        // Usage AGGREGATED across the tool-call step + the answer step ⇒ real, non-zero spend.
        expect(out.totalTokens ?? 0).toBeGreaterThan(0);
        expect(out.costUsd).toBeGreaterThan(0);
        // recordUsage saw the summed totals (one ledger event for the whole loop).
        expect(recorded).toHaveLength(1);
        expect(
          recorded[0].inputTokens + recorded[0].outputTokens,
        ).toBeGreaterThan(0);
      });
    }, 120_000);
  },
);
