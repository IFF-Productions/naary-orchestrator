import * as path from "node:path";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approvalSignal, stateQuery, TASK_QUEUE } from "@naary/contracts";
import { githubReviewGraph, sampleGraph, webhookSampleGraph } from "@naary/dsl";
import type { GraphDef } from "@naary/dsl";
import type * as activities from "../src/temporal/activities";
import { runGraph } from "../src/temporal/workflows";

// Temporal's own bundler (not vitest) processes this path, so it must be a real
// absolute filesystem path. require.resolve() is intercepted under vitest and
// fails here — use __dirname instead.
const WORKFLOWS_PATH = path.join(__dirname, "../src/temporal/workflows.ts");

// Mock runAgent so the e2e stays hermetic — no real LLM/key/DB. (The real agent
// activity is unit-tested in agent.activity.spec.ts; live run is deferred until
// a provider key is supplied.) Captures the meta to prove tenantId threading.
const agentCalls: activities.AgentMeta[] = [];
const mockActivities = {
  runAgent: async (
    _cfg: activities.AgentConfig,
    _input: unknown,
    meta: activities.AgentMeta,
  ): Promise<activities.AgentResult> => {
    agentCalls.push(meta);
    return {
      status: "ok",
      output: { category: "billing", urgency: 3 },
      model: "claude-opus-4-8",
      costUsd: 0.01,
    };
  },
  callMcpTool: async (
    cfg: activities.McpToolConfig,
    _input: unknown,
    _meta: activities.AgentMeta,
  ): Promise<activities.McpToolResult> => {
    mcpCalls.push(cfg);
    return {
      status: "ok",
      content: [{ type: "text", text: "commented" }],
      costUsd: 0,
    };
  },
  callHttpRequest: async (
    cfg: activities.HttpRequestConfig,
    _input: unknown,
    _meta: activities.AgentMeta,
  ): Promise<activities.HttpRequestResult> => {
    httpCalls.push(cfg);
    return httpResponse;
  },
  callSqlQuery: async (
    cfg: activities.SqlQueryConfig,
    _input: unknown,
    _meta: activities.AgentMeta,
  ): Promise<activities.SqlQueryResult> => {
    sqlCalls.push(cfg);
    return {
      status: "ok",
      rows: [{ id: 7, email: "a@b.co" }],
      rowCount: 1,
      costUsd: 0,
    };
  },
  recordExecution: async (): Promise<void> => undefined, // run-ownership upsert; no-op here
  setExecutionStatus: async (): Promise<void> => undefined, // read-model push; no-op here
};
const mcpCalls: activities.McpToolConfig[] = [];
const httpCalls: activities.HttpRequestConfig[] = [];
const sqlCalls: activities.SqlQueryConfig[] = [];
// Mutable so each test fixes the HTTP node's response (status drives the branch).
let httpResponse: activities.HttpRequestResult = {
  status: "ok",
  httpStatus: 200,
  headers: {},
  body: { ok: true },
  costUsd: 0,
};

// webhook → httpRequest → branch on status: <400 ends; ≥400 routes to an agent.
const httpBranchGraph: GraphDef = {
  startNodeId: "trigger",
  nodes: [
    { id: "trigger", type: "webhookTrigger" },
    {
      id: "http",
      type: "httpRequest",
      config: { method: "GET", url: "https://api.example.com/x" },
    },
    {
      id: "errAgent",
      type: "agent",
      config: {
        provider: "anthropic",
        model: "claude-opus-4-8",
        systemPrompt: "handle the error",
      },
    },
    { id: "ok", type: "end" },
    { id: "done", type: "end" },
  ],
  edges: [
    { from: "trigger", to: "http" },
    {
      from: "http",
      to: "ok",
      condition: { path: "http.status", op: "lt", value: 400 },
    },
    {
      from: "http",
      to: "errAgent",
      condition: { path: "http.status", op: "gt", value: 399 },
    },
    { from: "errAgent", to: "done" },
  ],
};

// webhook → sqlQuery → end. Proves the node dispatches and rows land in ctx.
const sqlGraph: GraphDef = {
  startNodeId: "trigger",
  nodes: [
    { id: "trigger", type: "webhookTrigger" },
    {
      id: "lookup",
      type: "sqlQuery",
      config: {
        connectionId: "db-1",
        sql: "SELECT id, email FROM users WHERE id = $1",
        paramBindings: { 1: { from: "trigger", path: "userId" } },
      },
    },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "trigger", to: "lookup" },
    { from: "lookup", to: "end" },
  ],
};

// webhook → set → end. The set node builds an object from static fields + a
// binding to the trigger output; its output IS that object (replace-only).
const setGraph: GraphDef = {
  startNodeId: "trigger",
  nodes: [
    { id: "trigger", type: "webhookTrigger" },
    {
      id: "shape",
      type: "set",
      config: {
        fields: { status: "reviewed" },
        fieldBindings: { userId: { from: "trigger", path: "userId" } },
      },
    },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "trigger", to: "shape" },
    { from: "shape", to: "end" },
  ],
};

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createLocal();
}, 60_000);

afterAll(async () => {
  await env?.teardown();
});

function makeWorker(): Promise<Worker> {
  return Worker.create({
    connection: env.nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowsPath: WORKFLOWS_PATH,
    activities: mockActivities,
  });
}

/** Poll a predicate until true or timeout — the agent activity has to run
 *  before the run reaches awaiting_approval, so a single immediate query races. */
async function waitFor(
  pred: () => Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("waitFor: condition not met within timeout");
}

describe("runGraph interpreter — durable pause → signal → resume", () => {
  it("pauses at humanApproval, then resumes to completed on approval", async () => {
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [
          sampleGraph,
          { message: "double charged" },
          { tenantId: "t-123" },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-approve",
      });

      await waitFor(
        async () =>
          (await handle.query(stateQuery)).status === "awaiting_approval",
      );

      const paused = await handle.query(stateQuery);
      expect(paused.status).toBe("awaiting_approval");
      expect(paused.currentNodeId).toBe("approval");
      // the agent ran before the pause and its structured output is in ctx
      expect(paused.ctx.agent).toMatchObject({
        status: "ok",
        output: { category: "billing" },
      });
      // tenantId was threaded into the activity (never a secret in args)
      expect(agentCalls[agentCalls.length - 1]).toMatchObject({
        tenantId: "t-123",
        nodeId: "agent",
      });

      await handle.signal(approvalSignal, { approved: true });

      const result = await handle.result();
      expect(result.status).toBe("completed");
    });
  });

  it("resolves to rejected when approval is denied", async () => {
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [
          sampleGraph,
          { message: "double charged" },
          { tenantId: "t-123" },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-reject",
      });

      await waitFor(
        async () =>
          (await handle.query(stateQuery)).status === "awaiting_approval",
      );

      await handle.signal(approvalSignal, { approved: false });

      // The workflow returns (does not throw) on rejection.
      const result = await handle.result();
      expect(result.status).toBe("rejected");
    });
  });

  it("halts with budget_exceeded at the per-execution cap (terminal, not thrown)", async () => {
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      // mock runAgent returns costUsd 0.01; cap 0.005 trips at the node AFTER the agent.
      const handle = await env.client.workflow.start(runGraph, {
        args: [
          sampleGraph,
          { message: "x" },
          { tenantId: "t-cap", perExecutionCapUsd: 0.005, maxStepsPerRun: 50 },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-budget",
      });

      // Halts before the approval pause — assert the result directly, no signal.
      const result = await handle.result();
      expect(result.status).toBe("budget_exceeded");
      // the agent did run (cost accumulated) before the cap stopped the next node
      expect(result.ctx.agent).toMatchObject({ status: "ok" });
    });
  });

  it("webhook graph: the inbound event becomes the trigger node's output", async () => {
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const event = { action: "opened", pull_request: { number: 42 } };
      const handle = await env.client.workflow.start(runGraph, {
        args: [webhookSampleGraph, event, { tenantId: "t-wh" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-webhook",
      });

      await waitFor(
        async () =>
          (await handle.query(stateQuery)).status === "awaiting_approval",
      );
      const paused = await handle.query(stateQuery);
      // the webhookTrigger node exposed the event as its output
      expect(paused.ctx.trigger).toEqual(event);

      await handle.signal(approvalSignal, { approved: true });
      expect((await handle.result()).status).toBe("completed");
    });
  });

  it("B5 reference flow: webhook → agent → mcpTool → humanApproval composes", async () => {
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const event = { action: "opened", pull_request: { number: 99 } };
      const handle = await env.client.workflow.start(runGraph, {
        args: [githubReviewGraph, event, { tenantId: "t-ref" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-reference",
      });

      await waitFor(
        async () =>
          (await handle.query(stateQuery)).status === "awaiting_approval",
      );
      const paused = await handle.query(stateQuery);
      // trigger → agent → mcpTool all ran before the approval pause
      expect(paused.ctx.trigger).toEqual(event);
      expect(paused.ctx.agent).toMatchObject({ status: "ok" });
      expect(paused.ctx.comment).toMatchObject({ status: "ok" });
      // the mcpTool used the configured GitHub connection + tool, and the
      // interpreter resolved its arguments from UPSTREAM outputs (not the raw
      // event): pull number from the trigger, body from the agent's review.
      expect(mcpCalls[mcpCalls.length - 1]).toMatchObject({
        connectionId: "github",
        tool: "add_pull_request_comment",
        arguments: {
          pullNumber: 99,
          body: { category: "billing", urgency: 3 },
        },
      });

      await handle.signal(approvalSignal, { approved: true });
      expect((await handle.result()).status).toBe("completed");
    });
  });

  it("httpRequest: exposes {status,headers,body} in ctx; a 2xx takes the success edge", async () => {
    httpResponse = {
      status: "ok",
      httpStatus: 200,
      headers: { "content-type": "application/json" },
      body: { ok: true },
      costUsd: 0,
    };
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [httpBranchGraph, { hello: "world" }, { tenantId: "t-http" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-http-ok",
      });
      const result = await handle.result();
      expect(result.status).toBe("completed");
      // node output is the structured response — the graph branches on .status
      expect(result.ctx.http).toEqual({
        status: 200,
        headers: { "content-type": "application/json" },
        body: { ok: true },
      });
      // success edge (<400) was taken → the error-path agent never ran
      expect(result.ctx.errAgent).toBeUndefined();
    });
  });

  it("httpRequest: a >=400 status routes down the error edge (branching on .status)", async () => {
    httpResponse = {
      status: "ok",
      httpStatus: 503,
      headers: {},
      body: { error: "unavailable" },
      costUsd: 0,
    };
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [httpBranchGraph, {}, { tenantId: "t-http-err" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-http-err",
      });
      const result = await handle.result();
      expect(result.status).toBe("completed");
      expect(result.ctx.http).toMatchObject({ status: 503 });
      // ≥400 edge was taken → the error-path agent ran
      expect(result.ctx.errAgent).toMatchObject({ status: "ok" });
    });
  });

  it("sqlQuery: resolves params from upstream + exposes {rows,rowCount} in ctx", async () => {
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [sqlGraph, { userId: 7 }, { tenantId: "t-sql" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-sql",
      });
      const result = await handle.result();
      expect(result.status).toBe("completed");
      expect(result.ctx.lookup).toEqual({
        rows: [{ id: 7, email: "a@b.co" }],
        rowCount: 1,
      });
      // the $1 param was resolved from the trigger's userId (binding, not the sql text)
      const call = sqlCalls[sqlCalls.length - 1];
      expect(call.sql).toBe("SELECT id, email FROM users WHERE id = $1");
      expect(call.params).toEqual([7]);
    });
  });

  it("set: builds its output object from static fields + upstream bindings (pure, no activity)", async () => {
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [setGraph, { userId: "u-42" }, { tenantId: "t-set" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-set",
      });
      const result = await handle.result();
      expect(result.status).toBe("completed");
      // output IS the built object; the binding filled userId from the trigger
      expect(result.ctx.shape).toEqual({ status: "reviewed", userId: "u-42" });
    });
  });

  it("halts with circuit_open when the step counter exceeds maxStepsPerRun", async () => {
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      // start(1), agent(2), approval(3) → 3 > 2 trips before the pause.
      const handle = await env.client.workflow.start(runGraph, {
        args: [
          sampleGraph,
          { message: "x" },
          { tenantId: "t-cb", maxStepsPerRun: 2 },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-circuit",
      });

      const result = await handle.result();
      expect(result.status).toBe("circuit_open");
    });
  });
});
