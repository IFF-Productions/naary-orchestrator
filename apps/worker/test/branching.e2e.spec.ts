import * as path from "node:path";
import { ApplicationFailure } from "@temporalio/activity";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { createLocalTestEnv } from "./local-test-env";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TASK_QUEUE } from "@naary/contracts";
import type { GraphDef } from "@naary/dsl";
import type * as activities from "../src/temporal/activities";
import { runGraph } from "../src/temporal/workflows";

const WORKFLOWS_PATH = path.join(__dirname, "../src/temporal/workflows.ts");

// Hermetic mocks. callMcpTool records the connectionId so we can see which branch
// actually ran; runAgent returns a fixed classification to drive conditions.
let mcpConns: string[] = [];
// "flaky-conn" fails the first 3 attempts then succeeds — to prove per-node retry lets a node
// exceed the default 3-attempt cap (the 4th attempt only runs if maxAttempts > 3).
let flakyAttempts = 0;
const mockActivities = {
  runAgent: async (): Promise<activities.AgentResult> => ({
    status: "ok",
    output: { category: "billing", urgency: 3 },
    model: "claude-opus-4-8",
    costUsd: 0.01,
  }),
  callMcpTool: async (
    cfg: activities.McpToolConfig,
  ): Promise<activities.McpToolResult> => {
    mcpConns.push(cfg.connectionId);
    // "boom-conn" fails (non-retryable → fast) so tests can exercise the per-node error
    // policy; every other connection succeeds.
    if (cfg.connectionId === "boom-conn") {
      throw ApplicationFailure.nonRetryable("mcp tool exploded", "BoomError");
    }
    if (cfg.connectionId === "flaky-conn") {
      flakyAttempts++;
      // RETRYABLE plain error for the first 3 tries; succeeds on the 4th.
      if (flakyAttempts < 4) throw new Error("transient flake");
      return { status: "ok", content: [], costUsd: 0 };
    }
    // echo the configured per-call cost, like the real activity (Arch§4.6)
    return { status: "ok", content: [], costUsd: cfg.costUsd ?? 0 };
  },
  recordExecution: async (): Promise<void> => undefined, // run-ownership upsert; no-op here
  setExecutionStatus: async (): Promise<void> => undefined, // read-model push; no-op here
  loadVariables: async (): Promise<Record<string, string>> => ({}), // $vars seed; empty here
  // Agent guardrails (#576): the interpreter resolves the workspace tool policy once per run for a
  // graph containing an mcpTool/integration node. Empty projection = "everything allowed", which is
  // what every scenario in this file assumes.
  resolveToolPolicy: async (): Promise<activities.ToolPolicyProjection> => ({}),
  recordAuditEvent: async (): Promise<void> => undefined,
};

let env: TestWorkflowEnvironment;
beforeAll(async () => {
  env = await createLocalTestEnv();
}, 60_000);
afterAll(async () => env?.teardown());
beforeEach(() => {
  mcpConns = [];
  flakyAttempts = 0;
});

function makeWorker(): Promise<Worker> {
  return Worker.create({
    connection: env.nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowsPath: WORKFLOWS_PATH,
    activities: mockActivities,
  });
}

const mcp = (id: string, conn: string) => ({
  id,
  type: "mcpTool" as const,
  config: { connectionId: conn, tool: "noop" },
});

describe("interpreter — branching / parallel / loop (Slice #6)", () => {
  it("routes down the edge whose condition matches the agent output", async () => {
    const graph: GraphDef = {
      startNodeId: "agent",
      nodes: [
        { id: "agent", type: "agent" },
        mcp("billing", "billing-conn"),
        mcp("other", "other-conn"),
        { id: "end", type: "end" },
      ],
      edges: [
        {
          from: "agent",
          to: "billing",
          condition: {
            path: "agent.output.category",
            op: "eq",
            value: "billing",
          },
        },
        {
          from: "agent",
          to: "other",
          condition: {
            path: "agent.output.category",
            op: "eq",
            value: "other",
          },
        },
        { from: "billing", to: "end" },
        { from: "other", to: "end" },
      ],
    };
    const worker = await makeWorker();
    const status = await worker.runUntil(async () => {
      const h = await env.client.workflow.start(runGraph, {
        args: [graph, {}, { tenantId: "t1" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-branch",
      });
      return (await h.result()).status;
    });
    expect(status).toBe("completed");
    // only the matching branch ran
    expect(mcpConns).toEqual(["billing-conn"]);
  });

  it("resolves {{ nodeId.path }} templates in config from an upstream output", async () => {
    // The mcpTool's connectionId is a template referencing the agent's output; the interpreter
    // must resolve it to "billing" (agent mock → output.category) BEFORE the activity runs.
    const graph: GraphDef = {
      startNodeId: "agent",
      nodes: [
        { id: "agent", type: "agent" },
        {
          id: "call",
          type: "mcpTool",
          config: { connectionId: "{{ agent.output.category }}", tool: "noop" },
        },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "agent", to: "call" },
        { from: "call", to: "end" },
      ],
    };
    const worker = await makeWorker();
    const status = await worker.runUntil(async () => {
      const h = await env.client.workflow.start(runGraph, {
        args: [graph, {}, { tenantId: "t1" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-template",
      });
      return (await h.result()).status;
    });
    expect(status).toBe("completed");
    // connectionId was resolved from agent.output.category, not passed literally
    expect(mcpConns).toEqual(["billing"]);
  });

  it("routes via a switch node: first matching rule wins, edges branch on .matched", async () => {
    // agent → category "billing", urgency 3. Rule 1 (urgent, urgency>=5) misses; rule 2
    // (billing) matches → matched="billing" → only the billing edge fires.
    const graph: GraphDef = {
      startNodeId: "agent",
      nodes: [
        { id: "agent", type: "agent" },
        {
          id: "sw",
          type: "switch",
          config: {
            rules: [
              {
                name: "urgent",
                condition: {
                  path: "agent.output.urgency",
                  op: "gte",
                  value: 5,
                },
              },
              {
                name: "billing",
                condition: {
                  path: "agent.output.category",
                  op: "eq",
                  value: "billing",
                },
              },
            ],
            fallback: "other",
          },
        },
        mcp("urgentBranch", "urgent-conn"),
        mcp("billingBranch", "billing-conn"),
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "agent", to: "sw" },
        {
          from: "sw",
          to: "urgentBranch",
          condition: { path: "sw.matched", op: "eq", value: "urgent" },
        },
        {
          from: "sw",
          to: "billingBranch",
          condition: { path: "sw.matched", op: "eq", value: "billing" },
        },
        { from: "urgentBranch", to: "end" },
        { from: "billingBranch", to: "end" },
      ],
    };
    const worker = await makeWorker();
    const status = await worker.runUntil(async () => {
      const h = await env.client.workflow.start(runGraph, {
        args: [graph, {}, { tenantId: "t1" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-switch",
      });
      return (await h.result()).status;
    });
    expect(status).toBe("completed");
    expect(mcpConns).toEqual(["billing-conn"]);
  });

  it("onError:continue turns a node failure into { error } and keeps going", async () => {
    // boom fails; onError:"continue" records boom.error and the flow branches on it.
    const graph: GraphDef = {
      startNodeId: "s",
      nodes: [
        { id: "s", type: "start" },
        {
          id: "boom",
          type: "mcpTool",
          config: { connectionId: "boom-conn", tool: "noop" },
          onError: "continue",
        },
        mcp("after", "after-conn"),
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "s", to: "boom" },
        {
          from: "boom",
          to: "after",
          condition: { path: "boom.error", op: "exists" },
        },
        { from: "after", to: "end" },
      ],
    };
    const worker = await makeWorker();
    const status = await worker.runUntil(async () => {
      const h = await env.client.workflow.start(runGraph, {
        args: [graph, {}, { tenantId: "t1" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-onerror-continue",
      });
      return (await h.result()).status;
    });
    expect(status).toBe("completed");
    // boom ran (and failed), then the error-branch node ran
    expect(mcpConns).toEqual(["boom-conn", "after-conn"]);
  });

  it("without onError, the same failure fails the run (default stop)", async () => {
    const graph: GraphDef = {
      startNodeId: "s",
      nodes: [
        { id: "s", type: "start" },
        {
          id: "boom",
          type: "mcpTool",
          config: { connectionId: "boom-conn", tool: "noop" },
        },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "s", to: "boom" },
        { from: "boom", to: "end" },
      ],
    };
    const worker = await makeWorker();
    await expect(
      worker.runUntil(async () => {
        const h = await env.client.workflow.start(runGraph, {
          args: [graph, {}, { tenantId: "t1" }],
          taskQueue: TASK_QUEUE,
          workflowId: "e2e-onerror-stop",
        });
        return (await h.result()).status;
      }),
    ).rejects.toThrow();
  });

  it("per-node retry lets a node exceed the default 3-attempt cap (fails 3×, succeeds on the 4th)", async () => {
    const graph: GraphDef = {
      startNodeId: "s",
      nodes: [
        { id: "s", type: "start" },
        {
          id: "flaky",
          type: "mcpTool",
          config: { connectionId: "flaky-conn", tool: "noop" },
          // maxAttempts 6 > the default 3 → the 4th (successful) attempt runs.
          retry: { maxAttempts: 6, initialIntervalSeconds: 0 },
        },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "s", to: "flaky" },
        { from: "flaky", to: "end" },
      ],
    };
    const worker = await makeWorker();
    const status = await worker.runUntil(async () => {
      const h = await env.client.workflow.start(runGraph, {
        args: [graph, {}, { tenantId: "t1" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-retry-override",
      });
      return (await h.result()).status;
    });
    expect(status).toBe("completed");
    expect(flakyAttempts).toBe(4); // 3 fails + 1 success
  });

  it("without the override, the default cap (3) fails the same flaky node", async () => {
    const graph: GraphDef = {
      startNodeId: "s",
      nodes: [
        { id: "s", type: "start" },
        {
          id: "flaky",
          type: "mcpTool",
          config: { connectionId: "flaky-conn", tool: "noop" },
        },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "s", to: "flaky" },
        { from: "flaky", to: "end" },
      ],
    };
    const worker = await makeWorker();
    await expect(
      worker.runUntil(async () => {
        const h = await env.client.workflow.start(runGraph, {
          args: [graph, {}, { tenantId: "t1" }],
          taskQueue: TASK_QUEUE,
          workflowId: "e2e-retry-default",
        });
        return (await h.result()).status;
      }),
    ).rejects.toThrow();
    expect(flakyAttempts).toBe(3); // stopped at the default cap
  });

  it("runs both branches on a parallel fan-out (two unconditional edges)", async () => {
    const graph: GraphDef = {
      startNodeId: "fork",
      nodes: [
        { id: "fork", type: "start" },
        mcp("a", "a-conn"),
        mcp("b", "b-conn"),
      ],
      edges: [
        { from: "fork", to: "a" },
        { from: "fork", to: "b" },
      ],
    };
    const worker = await makeWorker();
    const status = await worker.runUntil(async () => {
      const h = await env.client.workflow.start(runGraph, {
        args: [graph, {}, { tenantId: "t1" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-parallel",
      });
      return (await h.result()).status;
    });
    expect(status).toBe("completed");
    expect(mcpConns.sort()).toEqual(["a-conn", "b-conn"]); // both branches ran
  });

  it("loops bounded by the circuit breaker, surviving continueAsNew with stepCount intact", async () => {
    // self-loop; continueAsNew every 2 steps. If stepCount did NOT carry across
    // continueAsNew, maxStepsPerRun would never be reached → the run would never
    // terminate. Reaching circuit_open proves the carry.
    const graph: GraphDef = {
      startNodeId: "loop",
      nodes: [{ id: "loop", type: "start" }],
      edges: [{ from: "loop", to: "loop" }],
    };
    const worker = await makeWorker();
    const status = await worker.runUntil(async () => {
      const h = await env.client.workflow.start(runGraph, {
        args: [
          graph,
          {},
          { tenantId: "t1", maxStepsPerRun: 5, continueAsNewAfterSteps: 2 },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-loop",
      });
      return (await h.result()).status;
    });
    expect(status).toBe("circuit_open");
  });

  it("meters MCP tool cost into the per-execution budget (Arch§4.6)", async () => {
    // two tool nodes at $0.30 each; cap $0.25 → the first accrues 0.30, then the
    // cap trips at the second node (tool spend is now visible to the per-exec cap,
    // mirroring the agent node's "stop-after-exceeding" semantics).
    const graph: GraphDef = {
      startNodeId: "t1n",
      nodes: [
        {
          id: "t1n",
          type: "mcpTool",
          config: { connectionId: "c1", tool: "x", costUsd: 0.3 },
        },
        {
          id: "t2n",
          type: "mcpTool",
          config: { connectionId: "c2", tool: "x", costUsd: 0.3 },
        },
      ],
      edges: [{ from: "t1n", to: "t2n" }],
    };
    const worker = await makeWorker();
    const status = await worker.runUntil(async () => {
      const h = await env.client.workflow.start(runGraph, {
        args: [graph, {}, { tenantId: "t1", perExecutionCapUsd: 0.25 }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-mcp-meter",
      });
      return (await h.result()).status;
    });
    expect(status).toBe("budget_exceeded");
    expect(mcpConns).toEqual(["c1"]); // second tool never ran (cap tripped first)
  });

  it("a dangling edge yields a terminal invalid_graph (not an infinite retry)", async () => {
    const graph: GraphDef = {
      startNodeId: "a",
      nodes: [{ id: "a", type: "start" }],
      edges: [{ from: "a", to: "ghost" }],
    };
    const worker = await makeWorker();
    const status = await worker.runUntil(async () => {
      const h = await env.client.workflow.start(runGraph, {
        args: [graph, {}, { tenantId: "t1" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-invalid",
      });
      return (await h.result()).status;
    });
    expect(status).toBe("invalid_graph");
  });

  it("replays a completed branching run from history without nondeterminism", async () => {
    const graph: GraphDef = {
      startNodeId: "agent",
      nodes: [
        { id: "agent", type: "agent" },
        mcp("billing", "billing-conn"),
        { id: "end", type: "end" },
      ],
      edges: [
        {
          from: "agent",
          to: "billing",
          condition: {
            path: "agent.output.category",
            op: "eq",
            value: "billing",
          },
        },
        { from: "billing", to: "end" },
      ],
    };
    const worker = await makeWorker();
    const history = await worker.runUntil(async () => {
      const h = await env.client.workflow.start(runGraph, {
        args: [graph, {}, { tenantId: "t1" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-replay",
      });
      await h.result();
      return h.fetchHistory();
    });
    // Replays the recorded history against the current workflow code; throws on
    // any nondeterminism. This is the authoritative determinism guard (Arch§4.5).
    await expect(
      Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history),
    ).resolves.toBeUndefined();
  });

  it("replays a DIAMOND (fan-out → two activity branches → merge) without nondeterminism (audit A-2/Q-4)", async () => {
    // The merge fan-in fires on the LAST branch to arrive under the parallel
    // Promise.all — its correctness rests on replay-stable concurrent arrival order.
    // This replays a real diamond so any future change that breaks that ordering is
    // caught (the linear replay test above can't exercise it).
    const graph: GraphDef = {
      startNodeId: "fork",
      nodes: [
        { id: "fork", type: "start" },
        mcp("a", "a-conn"),
        mcp("b", "b-conn"),
        { id: "join", type: "merge", config: { mode: "array" } },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "fork", to: "a" },
        { from: "fork", to: "b" },
        { from: "a", to: "join" },
        { from: "b", to: "join" },
        { from: "join", to: "end" },
      ],
    };
    const worker = await makeWorker();
    const history = await worker.runUntil(async () => {
      const h = await env.client.workflow.start(runGraph, {
        args: [graph, {}, { tenantId: "t1" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-replay-diamond",
      });
      expect((await h.result()).status).toBe("completed");
      return h.fetchHistory();
    });
    await expect(
      Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history),
    ).resolves.toBeUndefined();
  });
});
