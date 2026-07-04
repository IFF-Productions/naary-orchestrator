import * as path from "node:path";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approvalSignal,
  stateQuery,
  TASK_QUEUE,
  webhookResponseQuery,
} from "@naary/contracts";
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
  computeDateTime: async (input: {
    base: string | number | null;
    addSeconds?: number;
  }): Promise<activities.DateTimeResult> => {
    // Deterministic stand-in for the clock read (base=null → fixed epoch).
    const baseMs = input.base === null ? 1_700_000_000_000 : Number(input.base);
    const epochMs = baseMs + (input.addSeconds ?? 0) * 1000;
    return { iso: new Date(epochMs).toISOString(), epochMs };
  },
  resolveSubWorkflowGraph: async (meta: {
    tenantId: string;
    workflowKey: string;
  }): Promise<activities.SubWorkflowGraph> => {
    subResolveCalls.push(meta);
    const graph =
      meta.workflowKey === "reject-flow"
        ? subRejectChildGraph
        : meta.workflowKey === "throw-flow"
          ? subThrowChildGraph
          : meta.workflowKey === "err-flow"
            ? errorHandlerGraph
            : subChildGraph;
    return { graph, contentHash: "child-hash", version: 1 };
  },
  callHmac: async (
    cfg: activities.ResolvedHmac,
    _input: unknown,
    _meta: activities.AgentMeta,
  ): Promise<activities.HmacResult> => {
    hmacCalls.push(cfg);
    return {
      status: "ok",
      digest: `digest(${JSON.stringify(cfg.payload)})`,
      costUsd: 0,
    };
  },
  callJwt: async (
    cfg: activities.ResolvedJwt,
    _input: unknown,
    _meta: activities.AgentMeta,
  ): Promise<activities.JwtResult> => {
    jwtCalls.push(cfg);
    return { status: "ok", token: "jwt.token.sig", costUsd: 0 };
  },
  callSendEmail: async (
    cfg: activities.ResolvedSendEmail,
    _input: unknown,
    _meta: activities.AgentMeta,
  ): Promise<activities.SendEmailResult> => {
    emailCalls.push(cfg);
    return { status: "ok", messageId: "<sent@test>", costUsd: 0 };
  },
  callTotp: async (
    cfg: activities.TotpConfig,
    _input: unknown,
    _meta: activities.AgentMeta,
  ): Promise<activities.TotpResult> => {
    totpCalls.push(cfg);
    return { status: "ok", code: "123456", costUsd: 0 };
  },
  callRssRead: async (
    cfg: activities.ResolvedRss,
    _input: unknown,
    _meta: activities.AgentMeta,
  ): Promise<activities.RssResult> => {
    rssCalls.push(cfg);
    const items = [
      { title: "A", link: "l1", summary: "", published: "", id: "1" },
      { title: "B", link: "l2", summary: "", published: "", id: "2" },
    ];
    return { status: "ok", items, count: items.length, costUsd: 0 };
  },
  callCode: async (
    cfg: activities.CodeNodeConfig,
    input: activities.CodeInput,
    _meta: activities.AgentMeta,
  ): Promise<activities.CodeResult> => {
    codeCalls.push({ cfg, input });
    // Echo back what the interpreter handed the sandbox (proves the snapshot).
    return { status: "ok", result: { got: input }, costUsd: 0 };
  },
  recordExecution: async (): Promise<void> => undefined, // run-ownership upsert; no-op here
  setExecutionStatus: async (): Promise<void> => undefined, // read-model push; no-op here
};
const codeCalls: {
  cfg: activities.CodeNodeConfig;
  input: activities.CodeInput;
}[] = [];
const totpCalls: activities.TotpConfig[] = [];
const rssCalls: activities.ResolvedRss[] = [];
const emailCalls: activities.ResolvedSendEmail[] = [];
const hmacCalls: activities.ResolvedHmac[] = [];
const jwtCalls: activities.ResolvedJwt[] = [];
const subResolveCalls: { tenantId: string; workflowKey: string }[] = [];
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

// The child graph a sub-workflow node runs: webhook → agent → end. The agent is
// mocked (cost 0.01), so completing it proves cost is metered back to the parent.
const subChildGraph: GraphDef = {
  startNodeId: "trigger",
  nodes: [
    { id: "trigger", type: "webhookTrigger" },
    {
      id: "worker",
      type: "agent",
      config: { provider: "anthropic", model: "claude-opus-4-8" },
    },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "trigger", to: "worker" },
    { from: "worker", to: "end" },
  ],
};

// A child that ends non-completed SYNCHRONOUSLY: a dangling edge → the interpreter
// returns the terminal "invalid_graph" (no timer/signal needed, so it works under
// the non-time-skipping local test env). The parent should surface this status,
// not crash on it.
// A child that THROWS (stopAndError → non-retryable ApplicationFailure), so its
// executeChild REJECTS — forEach must catch this per item, not kill the batch.
const subThrowChildGraph: GraphDef = {
  startNodeId: "trigger",
  nodes: [
    { id: "trigger", type: "webhookTrigger" },
    { id: "boom", type: "stopAndError", config: { message: "item failed" } },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "trigger", to: "boom" },
    { from: "boom", to: "end" },
  ],
};

const subRejectChildGraph: GraphDef = {
  startNodeId: "trigger",
  nodes: [{ id: "trigger", type: "webhookTrigger" }],
  edges: [{ from: "trigger", to: "ghost" }], // "ghost" node does not exist
};

// An error-handler graph: errorTrigger → end. Its errorTrigger output is the failure
// context the interpreter hands it, so ctx.et === the error payload after it runs.
const errorHandlerGraph: GraphDef = {
  startNodeId: "et",
  nodes: [
    { id: "et", type: "errorTrigger" },
    { id: "end", type: "end" },
  ],
  edges: [{ from: "et", to: "end" }],
};

// A top-level graph that THROWS (webhook → stopAndError).
const throwGraph: GraphDef = {
  startNodeId: "trigger",
  nodes: [
    { id: "trigger", type: "webhookTrigger" },
    { id: "boom", type: "stopAndError", config: { message: "kaboom" } },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "trigger", to: "boom" },
    { from: "boom", to: "end" },
  ],
};

// A top-level graph that RETURNS a failure status (dangling edge → invalid_graph).
const danglingGraph: GraphDef = {
  startNodeId: "trigger",
  nodes: [{ id: "trigger", type: "webhookTrigger" }],
  edges: [{ from: "trigger", to: "ghost" }],
};

// Parent: webhook → executeSubWorkflow → end. Runs subChildGraph as a child.
const subParentGraph: GraphDef = {
  startNodeId: "trigger",
  nodes: [
    { id: "trigger", type: "webhookTrigger" },
    {
      id: "sub",
      type: "executeSubWorkflow",
      config: { workflowKey: "child-flow" },
    },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "trigger", to: "sub" },
    { from: "sub", to: "end" },
  ],
};

// webhook → forEach → end. Runs subChildGraph (webhook → agent → end) once per
// item of `trigger.items`; the child's `trigger` output echoes the item.
function forEachGraph(
  fromPath = "items",
  workflowKey = "child-flow",
): GraphDef {
  return {
    startNodeId: "trigger",
    nodes: [
      { id: "trigger", type: "webhookTrigger" },
      {
        id: "loop",
        type: "forEach",
        config: { workflowKey, from: "trigger", path: fromPath },
      },
      { id: "end", type: "end" },
    ],
    edges: [
      { from: "trigger", to: "loop" },
      { from: "loop", to: "end" },
    ],
  };
}

// webhook → wait → end. A tiny durable delay, then completes.
const waitGraph: GraphDef = {
  startNodeId: "trigger",
  nodes: [
    { id: "trigger", type: "webhookTrigger" },
    { id: "pause", type: "wait", config: { durationSeconds: 0.05 } },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "trigger", to: "pause" },
    { from: "pause", to: "end" },
  ],
};

// webhook → stopAndError. The node throws → the run fails at the Temporal level.
const stopGraph: GraphDef = {
  startNodeId: "trigger",
  nodes: [
    { id: "trigger", type: "webhookTrigger" },
    {
      id: "boom",
      type: "stopAndError",
      config: { message: "halt: bad input" },
    },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "trigger", to: "boom" },
    { from: "boom", to: "end" },
  ],
};

// Diamond join: trigger fans out (unconditional) to two set nodes, both feed a
// merge, then a single agent runs downstream. Proves the merge runs ONCE and its
// downstream isn't duplicated.
function diamondGraph(mode: "array" | "object"): GraphDef {
  return {
    startNodeId: "trigger",
    nodes: [
      { id: "trigger", type: "webhookTrigger" },
      { id: "a", type: "set", config: { fields: { a: 1 } } },
      { id: "b", type: "set", config: { fields: { b: 2 } } },
      { id: "join", type: "merge", config: { mode } },
      {
        id: "after",
        type: "agent",
        config: { provider: "anthropic", model: "claude-opus-4-8" },
      },
      { id: "end", type: "end" },
    ],
    edges: [
      { from: "trigger", to: "a" },
      { from: "trigger", to: "b" },
      { from: "a", to: "join" },
      { from: "b", to: "join" },
      { from: "join", to: "after" },
      { from: "after", to: "end" },
    ],
  };
}

// webhook → renameKeys → dateTime → end. renameKeys remaps the trigger's keys;
// dateTime adds an offset to a bound epoch (deterministic via the mock).
const transformGraph: GraphDef = {
  startNodeId: "trigger",
  nodes: [
    { id: "trigger", type: "webhookTrigger" },
    {
      id: "renamed",
      type: "renameKeys",
      config: {
        from: "trigger",
        rename: { user_id: "userId" },
        drop: ["secret"],
      },
    },
    {
      id: "when",
      type: "dateTime",
      config: { source: { from: "trigger", path: "ts" }, addSeconds: 60 },
    },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "trigger", to: "renamed" },
    { from: "renamed", to: "when" },
    { from: "when", to: "end" },
  ],
};

// webhook → hmac → jwt → end. Signs the trigger body, then mints a token whose
// `sub` binds from the trigger. Both resolve their key in-activity (mocked here).
const signingGraph: GraphDef = {
  startNodeId: "trigger",
  nodes: [
    { id: "trigger", type: "webhookTrigger" },
    {
      id: "sig",
      type: "hmac",
      config: {
        connectionId: "sign-1",
        payloadBinding: { from: "trigger", path: "body" },
      },
    },
    {
      id: "tok",
      type: "jwt",
      config: {
        connectionId: "sign-1",
        claimsBindings: { sub: { from: "trigger", path: "userId" } },
      },
    },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "trigger", to: "sig" },
    { from: "sig", to: "tok" },
    { from: "tok", to: "end" },
  ],
};

// webhook → sendEmail → end. The recipient binds from the trigger; the SMTP URI
// is resolved in-activity (mocked here).
const emailGraph: GraphDef = {
  startNodeId: "trigger",
  nodes: [
    { id: "trigger", type: "webhookTrigger" },
    {
      id: "notify",
      type: "sendEmail",
      config: {
        connectionId: "smtp-1",
        subject: "done",
        text: "your run finished",
        fieldBindings: { to: { from: "trigger", path: "email" } },
      },
    },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "trigger", to: "notify" },
    { from: "notify", to: "end" },
  ],
};

// webhook → totp → end. Generates the current code from a signing-connection seed
// (resolved + clock read in-activity; mocked here).
const totpGraph: GraphDef = {
  startNodeId: "trigger",
  nodes: [
    { id: "trigger", type: "webhookTrigger" },
    { id: "code", type: "totp", config: { connectionId: "sign-1", digits: 6 } },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "trigger", to: "code" },
    { from: "code", to: "end" },
  ],
};

// webhook → filter → aggregate → end. The trigger carries an array; filter keeps
// active items, aggregate collects their names. Both are pure (no activity).
const arrayGraph: GraphDef = {
  startNodeId: "trigger",
  nodes: [
    { id: "trigger", type: "webhookTrigger" },
    {
      id: "actives",
      type: "filter",
      config: {
        from: "trigger",
        path: "users",
        condition: { path: "active", op: "eq", value: true },
      },
    },
    {
      id: "sorted",
      type: "listOps",
      config: { from: "actives", operation: "sort", field: "name" },
    },
    {
      id: "names",
      type: "aggregate",
      config: { from: "sorted", operation: "collect", field: "name" },
    },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "trigger", to: "actives" },
    { from: "actives", to: "sorted" },
    { from: "sorted", to: "names" },
    { from: "names", to: "end" },
  ],
};

// webhook → rssRead → aggregate(count) → end. Proves the feed items land in ctx
// and downstream array nodes can operate on them.
const rssGraph: GraphDef = {
  startNodeId: "trigger",
  nodes: [
    { id: "trigger", type: "webhookTrigger" },
    { id: "feed", type: "rssRead", config: { url: "https://x.co/feed.xml" } },
    {
      id: "n",
      type: "aggregate",
      config: { from: "feed", path: "items", operation: "count" },
    },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "trigger", to: "feed" },
    { from: "feed", to: "n" },
    { from: "n", to: "end" },
  ],
};

// webhook → respondToWebhook → end. Sets a 201 response whose body binds from the
// trigger; the run then continues to end. The response is read via the query.
const respondGraph: GraphDef = {
  startNodeId: "trigger",
  nodes: [
    { id: "trigger", type: "webhookTrigger" },
    {
      id: "respond",
      type: "respondToWebhook",
      config: {
        statusCode: 201,
        body: { ok: true },
        bodyBinding: { from: "trigger", path: "echo" },
      },
    },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "trigger", to: "respond" },
    { from: "respond", to: "end" },
  ],
};

// webhook → set(shape) → code → end. Proves the interpreter hands the code node the
// entry input as $input and a __-stripped snapshot of upstream outputs as $ctx.
const codeGraph: GraphDef = {
  startNodeId: "trigger",
  nodes: [
    { id: "trigger", type: "webhookTrigger" },
    { id: "shape", type: "set", config: { fields: { k: 1 } } },
    { id: "compute", type: "code", config: { code: "return $input" } },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "trigger", to: "shape" },
    { from: "shape", to: "compute" },
    { from: "compute", to: "end" },
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

  it("executeSubWorkflow: runs the child, exposes {status,ctx}, and meters child cost into the parent", async () => {
    subResolveCalls.length = 0;
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [subParentGraph, { message: "go" }, { tenantId: "t-sub" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-subworkflow",
      });
      const result = await handle.result();
      expect(result.status).toBe("completed");
      // the child graph was resolved by workflowKey (in the activity)
      expect(subResolveCalls[subResolveCalls.length - 1]).toEqual({
        tenantId: "t-sub",
        workflowKey: "child-flow",
      });
      // the node output exposes the child's terminal status + its ctx
      const sub = result.ctx.sub as {
        status: string;
        output: Record<string, unknown>;
      };
      expect(sub.status).toBe("completed");
      expect(sub.output.worker).toMatchObject({ status: "ok" });
      // internal bookkeeping keys are NOT copied into the parent (bounded payload)
      expect(sub.output.__input).toBeUndefined();
      expect(sub.output.__costUsd).toBeUndefined();
      // the child's agent cost (mock 0.01) was metered into the PARENT budget
      expect(result.ctx.__costUsd).toBeCloseTo(0.01, 5);
    });
  });

  it("executeSubWorkflow: refuses to launch past the nesting cap (circuit_open, child never resolved)", async () => {
    subResolveCalls.length = 0;
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      // Start already at the max depth → the node trips the guard before any I/O.
      const handle = await env.client.workflow.start(runGraph, {
        args: [
          subParentGraph,
          { message: "go" },
          { tenantId: "t-depth", subWorkflowDepth: 5 },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-subworkflow-depth",
      });
      const result = await handle.result();
      expect(result.status).toBe("circuit_open");
      // guard fired BEFORE resolving/launching the child
      expect(subResolveCalls).toHaveLength(0);
      expect(result.ctx.sub).toBeUndefined();
    });
  });

  it("executeSubWorkflow: a child that ends non-completed surfaces as a branchable status (parent doesn't crash)", async () => {
    const rejectParentGraph: GraphDef = {
      startNodeId: "trigger",
      nodes: [
        { id: "trigger", type: "webhookTrigger" },
        {
          id: "sub",
          type: "executeSubWorkflow",
          config: { workflowKey: "reject-flow" },
        },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "trigger", to: "sub" },
        { from: "sub", to: "end" },
      ],
    };
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [rejectParentGraph, { message: "go" }, { tenantId: "t-sub-rej" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-subworkflow-reject",
      });
      const result = await handle.result();
      // the child ended non-completed, but the PARENT completed — the child's
      // terminal status is exposed (branchable), not propagated as a parent failure
      expect(result.status).toBe("completed");
      expect((result.ctx.sub as { status: string }).status).toBe(
        "invalid_graph",
      );
    });
  });

  it("wait: pauses on a durable timer, then completes", async () => {
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [waitGraph, { hi: 1 }, { tenantId: "t-wait" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-wait",
      });
      const result = await handle.result();
      expect(result.status).toBe("completed");
    });
  });

  it("stopAndError: fails the run at the Temporal level with the configured message", async () => {
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [stopGraph, {}, { tenantId: "t-stop" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-stop",
      });
      // The node throws a non-retryable ApplicationFailure → the workflow FAILS
      // (result() rejects). The configured message rides in the underlying
      // ApplicationFailure (WorkflowFailedError.cause), not the top-level error.
      const err = await handle.result().then(
        () => {
          throw new Error("expected the run to fail");
        },
        (e: unknown) => e as { cause?: { message?: string } },
      );
      expect(err.cause?.message).toMatch(/halt: bad input/);
    });
  });

  it("merge (array): joins parallel branches once, combining their outputs in edge order", async () => {
    const before = agentCalls.filter((c) => c.nodeId === "after").length;
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [diamondGraph("array"), {}, { tenantId: "t-merge" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-merge-array",
      });
      const result = await handle.result();
      expect(result.status).toBe("completed");
      // combined output = [parentA, parentB] in declared inbound-edge order
      expect(result.ctx.join).toEqual([{ a: 1 }, { b: 2 }]);
      // the post-merge agent ran EXACTLY ONCE — the join didn't duplicate downstream
      const after = agentCalls.filter((c) => c.nodeId === "after").length;
      expect(after - before).toBe(1);
      expect(result.ctx.after).toMatchObject({ status: "ok" });
    });
  });

  it("merge (object): combines the inbound parents' outputs into one object", async () => {
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [diamondGraph("object"), {}, { tenantId: "t-merge-obj" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-merge-object",
      });
      const result = await handle.result();
      expect(result.status).toBe("completed");
      expect(result.ctx.join).toEqual({ a: 1, b: 2 });
    });
  });

  it("merge: waits for a genuinely-async inbound branch (agent) before firing", async () => {
    // One branch runs an agent (real activity await), the other is pure — the join
    // must wait for the slow branch, not fire on lucky microtask ordering.
    const asyncDiamond: GraphDef = {
      startNodeId: "trigger",
      nodes: [
        { id: "trigger", type: "webhookTrigger" },
        {
          id: "slow",
          type: "agent",
          config: { provider: "anthropic", model: "claude-opus-4-8" },
        },
        { id: "fast", type: "set", config: { fields: { b: 2 } } },
        { id: "join", type: "merge", config: { mode: "array" } },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "trigger", to: "slow" },
        { from: "trigger", to: "fast" },
        { from: "slow", to: "join" },
        { from: "fast", to: "join" },
        { from: "join", to: "end" },
      ],
    };
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [asyncDiamond, {}, { tenantId: "t-merge-async" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-merge-async",
      });
      const result = await handle.result();
      expect(result.status).toBe("completed");
      // join[0] = the agent branch's output, join[1] = the pure branch's
      const join = result.ctx.join as unknown[];
      expect(join[0]).toMatchObject({ status: "ok" });
      expect(join[1]).toEqual({ b: 2 });
    });
  });

  it("merge: a stranded join (one inbound branch gated off upstream) fails invalid_graph, not silent success", async () => {
    // Both edges INTO the merge are unconditional (validateGraph passes), but a
    // conditional edge UPSTREAM routes only one branch — so the merge gets 1 of 2
    // arrivals and never fires. This must NOT report a clean completion.
    const strandedGraph: GraphDef = {
      startNodeId: "trigger",
      nodes: [
        { id: "trigger", type: "webhookTrigger" },
        { id: "a", type: "set", config: { fields: { a: 1 } } },
        { id: "b", type: "set", config: { fields: { b: 2 } } },
        { id: "join", type: "merge" },
        { id: "end", type: "end" },
      ],
      edges: [
        {
          from: "trigger",
          to: "a",
          condition: { path: "__input.go", op: "eq", value: true },
        },
        {
          from: "trigger",
          to: "b",
          condition: { path: "__input.go", op: "eq", value: false },
        },
        { from: "a", to: "join" },
        { from: "b", to: "join" },
        { from: "join", to: "end" },
      ],
    };
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [strandedGraph, { go: true }, { tenantId: "t-merge-strand" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-merge-strand",
      });
      const result = await handle.result();
      // only branch A fired → merge stranded at 1/2 → surfaced, not "completed"
      expect(result.status).toBe("invalid_graph");
      expect(result.ctx.join).toBeUndefined();
    });
  });

  it("renameKeys + dateTime: reshape keys (pure) then timestamp math (activity)", async () => {
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [
          transformGraph,
          { user_id: "u-9", email: "x@y.co", secret: "hide", ts: 1_000_000 },
          { tenantId: "t-transform" },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-transform",
      });
      const result = await handle.result();
      expect(result.status).toBe("completed");
      // renameKeys: user_id→userId, dropped secret, kept email + ts (unmapped)
      expect(result.ctx.renamed).toEqual({
        userId: "u-9",
        email: "x@y.co",
        ts: 1_000_000,
      });
      // dateTime: base 1_000_000 + 60s = 1_060_000 ms
      expect(result.ctx.when).toMatchObject({ epochMs: 1_060_000 });
    });
  });

  it("hmac + jwt: sign payload then mint a token (keys resolved in-activity)", async () => {
    hmacCalls.length = 0;
    jwtCalls.length = 0;
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [
          signingGraph,
          { body: { amount: 5 }, userId: "u-7" },
          { tenantId: "t-sign" },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-signing",
      });
      const result = await handle.result();
      expect(result.status).toBe("completed");
      // hmac received the RAW bound payload (stringify happens in-activity); output
      // is just the digest (no key)
      expect(hmacCalls[0]).toMatchObject({
        connectionId: "sign-1",
        payload: { amount: 5 },
      });
      expect(result.ctx.sig).toEqual({ digest: 'digest({"amount":5})' });
      // jwt resolved the `sub` claim from the trigger; output is the token
      expect(jwtCalls[0].claims).toMatchObject({ sub: "u-7" });
      expect(result.ctx.tok).toEqual({ token: "jwt.token.sig" });
    });
  });

  it("sendEmail: resolves recipient from upstream + exposes messageId (URI in-activity)", async () => {
    emailCalls.length = 0;
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [emailGraph, { email: "user@corp.co" }, { tenantId: "t-email" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-email",
      });
      const result = await handle.result();
      expect(result.status).toBe("completed");
      // the `to` field was resolved from the trigger; only connectionId (no URI)
      expect(emailCalls[0]).toMatchObject({
        connectionId: "smtp-1",
        to: "user@corp.co",
        subject: "done",
      });
      expect(result.ctx.notify).toEqual({ messageId: "<sent@test>" });
    });
  });

  it("totp: generates a code from the signing connection (seed + clock in-activity)", async () => {
    totpCalls.length = 0;
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [totpGraph, {}, { tenantId: "t-totp" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-totp",
      });
      const result = await handle.result();
      expect(result.status).toBe("completed");
      expect(totpCalls[0]).toMatchObject({ connectionId: "sign-1", digits: 6 });
      expect(result.ctx.code).toEqual({ code: "123456" });
    });
  });

  it("filter + aggregate: subset an array then collapse it (pure, arrays as values)", async () => {
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [
          arrayGraph,
          {
            users: [
              { name: "Ada", active: true },
              { name: "Bo", active: false },
              { name: "Cy", active: true },
            ],
          },
          { tenantId: "t-arr" },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-array",
      });
      const result = await handle.result();
      expect(result.status).toBe("completed");
      // filter kept the active items (its output IS the filtered array)
      expect(result.ctx.actives).toEqual([
        { name: "Ada", active: true },
        { name: "Cy", active: true },
      ]);
      // aggregate collected their names into { result }
      expect(result.ctx.names).toEqual({ result: ["Ada", "Cy"] });
    });
  });

  it("forEach: runs the child once per item (item as input) and collects results in order", async () => {
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [
          forEachGraph(),
          { items: [{ n: 1 }, { n: 2 }, { n: 3 }] },
          { tenantId: "t-foreach" },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-foreach",
      });
      const result = await handle.result();
      expect(result.status).toBe("completed");
      const loop = result.ctx.loop as {
        status: string;
        output: Record<string, unknown>;
      }[];
      expect(loop).toHaveLength(3);
      // every item ran to completion, in ARRAY ORDER, with the item as its input
      expect(loop.map((r) => r.status)).toEqual([
        "completed",
        "completed",
        "completed",
      ]);
      expect(loop.map((r) => r.output.trigger)).toEqual([
        { n: 1 },
        { n: 2 },
        { n: 3 },
      ]);
      // each child's mocked agent cost (0.01) summed into the parent (3 × 0.01)
      expect(result.ctx.__costUsd).toBeCloseTo(0.03, 5);
    });
  });

  it("forEach: empty/non-array source → [] (no children)", async () => {
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [
          forEachGraph("missing"),
          { items: [] },
          { tenantId: "t-fe-empty" },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-foreach-empty",
      });
      const result = await handle.result();
      expect(result.status).toBe("completed");
      expect(result.ctx.loop).toEqual([]);
    });
  });

  it("forEach: a THROWING child (stopAndError) becomes a failed entry, not a batch kill", async () => {
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [
          forEachGraph("items", "throw-flow"),
          { items: [{ n: 1 }, { n: 2 }] },
          { tenantId: "t-fe-throw" },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-foreach-throw",
      });
      const result = await handle.result();
      // the whole forEach still COMPLETES; each thrown child is a failed entry
      expect(result.status).toBe("completed");
      const loop = result.ctx.loop as { status: string }[];
      expect(loop).toHaveLength(2);
      expect(loop.map((r) => r.status)).toEqual(["failed", "failed"]);
    });
  });

  it("forEach: an array past the item cap trips circuit_open (no silent truncation)", async () => {
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const items = Array.from({ length: 101 }, (_, i) => ({ n: i }));
      const handle = await env.client.workflow.start(runGraph, {
        args: [forEachGraph(), { items }, { tenantId: "t-fe-cap" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-foreach-cap",
      });
      const result = await handle.result();
      expect(result.status).toBe("circuit_open");
      expect(result.ctx.loop).toBeUndefined();
    });
  });

  it("rssRead: exposes {items,count}; downstream array nodes can operate on it", async () => {
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [rssGraph, {}, { tenantId: "t-rss" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-rss",
      });
      const result = await handle.result();
      expect(result.status).toBe("completed");
      expect(rssCalls[0]).toMatchObject({ url: "https://x.co/feed.xml" });
      expect(result.ctx.feed).toMatchObject({ count: 2 });
      // aggregate(count) over feed.items
      expect(result.ctx.n).toEqual({ result: 2 });
    });
  });

  it("respondToWebhook: sets a synchronous response (queryable) then continues to completion", async () => {
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [
          respondGraph,
          { echo: { hello: "world" } },
          { tenantId: "t-respond" },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-respond",
      });
      const result = await handle.result();
      // the run CONTINUED past respond → completed
      expect(result.status).toBe("completed");
      expect(result.ctx.respond).toEqual({ statusCode: 201 });
      // the response the ingress would return, read via the query (closed run)
      const response = await handle.query(webhookResponseQuery);
      expect(response).toEqual({
        statusCode: 201,
        body: { hello: "world" }, // bound from the trigger, overriding static body
      });
    });
  });

  it("code: interpreter passes $input (entry) + $ctx (upstream snapshot) and stores the result", async () => {
    codeCalls.length = 0;
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [codeGraph, { a: 9 }, { tenantId: "t-code" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-code",
      });
      const result = await handle.result();
      expect(result.status).toBe("completed");
      // $input is the entry input; $ctx carries the upstream `shape` output; no __*.
      expect(codeCalls[0].input.input).toEqual({ a: 9 });
      expect(codeCalls[0].input.ctx.shape).toEqual({ k: 1 });
      expect(Object.keys(codeCalls[0].input.ctx)).not.toContain("__input");
      // the activity's return value is the node output
      expect(result.ctx.compute).toEqual({
        got: { input: { a: 9 }, ctx: expect.any(Object) },
      });
    });
  });

  it("error-handler: a THROWN failure starts the detached handler with the error payload", async () => {
    subResolveCalls.length = 0;
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const parentId = "e2e-onerror-thrown";
      const handle = await env.client.workflow.start(runGraph, {
        args: [
          throwGraph,
          { x: 1 },
          {
            tenantId: "t-err",
            workflowKey: "wk-a",
            errorWorkflowKey: "err-flow",
          },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: parentId,
      });
      await expect(handle.result()).rejects.toThrow(); // the parent FAILS
      // the detached handler ran with the failure context as its errorTrigger output
      const child = env.client.workflow.getHandle(`${parentId}-onerror`);
      const childResult = (await child.result()) as {
        status: string;
        ctx: Record<string, { failedWorkflowId?: string }>;
      };
      expect(childResult.status).toBe("completed");
      expect(childResult.ctx.et).toMatchObject({
        failedWorkflowId: parentId,
        workflowKey: "wk-a",
        status: "failed",
        error: { type: "STOP_AND_ERROR" },
      });
    });
  });

  it("error-handler: a RETURNED failure status (invalid_graph) also starts the handler", async () => {
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const parentId = "e2e-onerror-returned";
      const handle = await env.client.workflow.start(runGraph, {
        args: [
          danglingGraph,
          {},
          {
            tenantId: "t-err",
            workflowKey: "wk-b",
            errorWorkflowKey: "err-flow",
          },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: parentId,
      });
      const result = await handle.result(); // RETURNS (doesn't reject)
      expect(result.status).toBe("invalid_graph");
      const child = env.client.workflow.getHandle(`${parentId}-onerror`);
      const childResult = (await child.result()) as {
        ctx: Record<string, { status?: string }>;
      };
      expect(childResult.ctx.et).toMatchObject({
        failedWorkflowId: parentId,
        status: "invalid_graph",
      });
    });
  });

  it("error-handler: does NOT fire for a handler run (loop guard) or a completed run", async () => {
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      // (a) a FAILING run that is itself a handler → no nested handler
      subResolveCalls.length = 0;
      const h1 = await env.client.workflow.start(runGraph, {
        args: [
          throwGraph,
          {},
          {
            tenantId: "t-err",
            workflowKey: "wk-h",
            errorWorkflowKey: "err-flow",
            isErrorHandler: true,
          },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-onerror-loopguard",
      });
      await expect(h1.result()).rejects.toThrow();
      expect(subResolveCalls.some((c) => c.workflowKey === "err-flow")).toBe(
        false,
      ); // handler never resolved

      // (b) a COMPLETED run with a handler bound → no handler
      subResolveCalls.length = 0;
      const h2 = await env.client.workflow.start(runGraph, {
        args: [
          setGraph,
          { userId: "u" },
          {
            tenantId: "t-err",
            workflowKey: "wk-ok",
            errorWorkflowKey: "err-flow",
          },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-onerror-completed",
      });
      const r2 = await h2.result();
      expect(r2.status).toBe("completed");
      expect(subResolveCalls.some((c) => c.workflowKey === "err-flow")).toBe(
        false,
      );
    });
  });

  it("error-handler: continueAsNew is NOT mistaken for a failure (handler fires once, at the real failure)", async () => {
    // self-loop that continueAsNews every 2 steps until the circuit breaker trips.
    // With an errorWorkflowKey bound, each CAN boundary throws to unwind — the catch
    // must re-throw it, NOT treat it as a failure. The run must still resume across
    // CANs and reach circuit_open, and the handler must fire exactly ONCE (for that
    // real terminal failure), never per-CAN-boundary.
    subResolveCalls.length = 0;
    const loopGraph: GraphDef = {
      startNodeId: "loop",
      nodes: [{ id: "loop", type: "start" }],
      edges: [{ from: "loop", to: "loop" }],
    };
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [
          loopGraph,
          {},
          {
            tenantId: "t-err",
            workflowKey: "wk-loop",
            errorWorkflowKey: "err-flow",
            maxStepsPerRun: 5,
            continueAsNewAfterSteps: 2,
          },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-onerror-can",
      });
      const result = await handle.result();
      expect(result.status).toBe("circuit_open"); // resumed cleanly across CANs
      // handler resolved exactly once (the real failure), not once per CAN boundary
      expect(
        subResolveCalls.filter((c) => c.workflowKey === "err-flow"),
      ).toHaveLength(1);
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
