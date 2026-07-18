import * as path from "node:path";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { createLocalTestEnv } from "./local-test-env";
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
  callIntegration: async (
    cfg: { provider: string; action: string },
    fields: Record<string, unknown>,
    _meta: activities.AgentMeta,
  ): Promise<activities.IntegrationResult> => {
    integrationCalls.push({ cfg, fields });
    // get_pull_request (read) → the raw diff text as body; writes → an ok create.
    return cfg.action === "get_pull_request"
      ? {
          status: "ok",
          httpStatus: 200,
          ok: true,
          body: "diff --git a/x b/x\n+new\n",
        }
      : { status: "ok", httpStatus: 201, ok: true, body: { id: 1 } };
  },
  callHttpRequest: async (
    cfg: activities.HttpRequestConfig,
    _input: unknown,
    _meta: activities.AgentMeta,
  ): Promise<activities.HttpRequestResult> => {
    httpCalls.push(cfg);
    return httpResponse;
  },
  callGraphQL: async (
    cfg: activities.ResolvedGraphQL,
    _input: unknown,
    _meta: activities.AgentMeta,
  ): Promise<activities.GraphQLResult> => {
    graphqlCalls.push(cfg);
    return {
      status: "ok",
      httpStatus: 200,
      data: { echoedVariables: cfg.variables },
      errors: null,
      costUsd: 0,
    };
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
  callSqlExec: async (
    cfg: activities.SqlExecConfig,
    _input: unknown,
    _meta: activities.AgentMeta,
  ): Promise<activities.SqlExecResult> => {
    sqlExecCalls.push(cfg);
    return { status: "ok", rowsAffected: 2, costUsd: 0 };
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
    environmentId?: string;
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
  callXml: async (
    cfg: activities.XmlConfig,
    input: unknown,
    _meta: activities.AgentMeta,
  ): Promise<activities.XmlResult> => {
    xmlCalls.push({ cfg, input });
    return { status: "ok", result: { parsed: input }, costUsd: 0 };
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
  // Per-node matrix (Part 2): activity-backed transform nodes. Deterministic stubs so the e2e stays
  // hermetic (the real parse/crypto/Buffer work is unit-tested); each captures its resolved request so
  // a test can prove the interpreter threaded config + upstream bindings into the activity.
  callCsv: async (
    cfg: activities.CsvConfig,
    input: unknown,
    _meta: activities.AgentMeta,
  ): Promise<activities.CsvResult> => {
    csvCalls.push({ cfg, input });
    // Echo a deterministic parse result so ctx.<node> === res.result (interpreter unwraps .result).
    return {
      status: "ok",
      result: [{ id: "1", name: "Ada" }],
      costUsd: 0,
    };
  },
  callEncode: async (
    cfg: activities.EncodeConfig,
    input: unknown,
    _meta: activities.AgentMeta,
  ): Promise<activities.EncodeResult> => {
    encodeCalls.push({ cfg, input });
    return { status: "ok", result: `enc(${String(input)})`, costUsd: 0 };
  },
  callHash: async (
    cfg: activities.ResolvedHash,
    _input: unknown,
    _meta: activities.AgentMeta,
  ): Promise<activities.HashResult> => {
    hashCalls.push(cfg);
    return { status: "ok", digest: "deadbeef", costUsd: 0 };
  },
  callRandom: async (
    cfg: activities.RandomConfig,
    _meta: activities.AgentMeta,
  ): Promise<activities.RandomResult> => {
    randomCalls.push(cfg);
    return { status: "ok", value: "r4nd0mhex", costUsd: 0 };
  },
  callHtmlExtract: async (
    cfg: activities.HtmlExtractConfig,
    input: unknown,
    _meta: activities.AgentMeta,
  ): Promise<activities.HtmlExtractResult> => {
    htmlExtractCalls.push({ cfg, input });
    return { status: "ok", result: { title: "Hello" }, costUsd: 0 };
  },
  callMarkdown: async (
    input: unknown,
    _meta: activities.AgentMeta,
  ): Promise<activities.MarkdownResult> => {
    markdownCalls.push(input);
    return { status: "ok", result: { markdown: "# Hi" }, costUsd: 0 };
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
  callPoll: async (
    _cfg: unknown,
    meta: activities.PollMeta,
  ): Promise<activities.PollResult> => {
    pollCalls.push(meta);
    return { status: "ok", changed: pollChanged, body: { v: 1 }, costUsd: 0 };
  },
  sendNotification: async (
    input: activities.NotificationInput,
  ): Promise<void> => {
    notifyCalls.push(input);
  },
  recordExecution: async (): Promise<void> => undefined, // run-ownership upsert; no-op here
  setExecutionStatus: async (): Promise<void> => undefined, // read-model push; no-op here
  // Global Variables ($vars): return the env-scoped config the interpreter seeds into ctx.$vars.
  // Captures the meta so a test can prove the run's (tenantId, environmentId) reach the read.
  loadVariables: async (meta: {
    tenantId: string;
    environmentId?: string;
  }): Promise<Record<string, string>> => {
    loadVariablesCalls.push(meta);
    return loadVariablesResult;
  },
  // Items model A3: the batched per-item map. Echo each item's input so the test can prove the
  // interpreter passed the CURRENT ITEM per iteration (not the run input N times).
  mapNode: async (
    nodeType: string,
    items: activities.MapNodeItem[],
    _meta: activities.AgentMeta,
  ): Promise<activities.MapNodeResult> => {
    mapNodeCalls.push({ nodeType, count: items.length });
    return {
      outputs: items.map((it) => ({ ran: nodeType, on: it.input })),
      costUsd: items.length * 0.01,
    };
  },
};
const mapNodeCalls: { nodeType: string; count: number }[] = [];
const loadVariablesCalls: { tenantId: string; environmentId?: string }[] = [];
// Mutable so each test can fix the env's variable set (default: one var proving resolution).
let loadVariablesResult: Record<string, string> = { slackChannel: "#alerts" };
const pollCalls: activities.PollMeta[] = [];
let pollChanged = true;
const notifyCalls: activities.NotificationInput[] = [];

// pollTrigger(entry) → branch on poll.changed: changed → agent → end; else → end.
const pollGraph: GraphDef = {
  startNodeId: "poll",
  nodes: [
    {
      id: "poll",
      type: "pollTrigger",
      config: { url: "https://api.example.com/x", intervalSeconds: 60 },
    },
    {
      id: "act",
      type: "agent",
      config: {
        provider: "anthropic",
        model: "claude-opus-4-8",
        systemPrompt: "handle the change",
      },
    },
    { id: "end", type: "end" },
  ],
  edges: [
    {
      from: "poll",
      to: "act",
      condition: { path: "poll.changed", op: "eq", value: true },
    },
    {
      from: "poll",
      to: "end",
      condition: { path: "poll.changed", op: "neq", value: true },
    },
    { from: "act", to: "end" },
  ],
};
const codeCalls: {
  cfg: activities.CodeNodeConfig;
  input: activities.CodeInput;
}[] = [];
const totpCalls: activities.TotpConfig[] = [];
// Per-node matrix (Part 2) capture arrays.
const csvCalls: { cfg: activities.CsvConfig; input: unknown }[] = [];
const encodeCalls: { cfg: activities.EncodeConfig; input: unknown }[] = [];
const hashCalls: activities.ResolvedHash[] = [];
const randomCalls: activities.RandomConfig[] = [];
const htmlExtractCalls: {
  cfg: activities.HtmlExtractConfig;
  input: unknown;
}[] = [];
const markdownCalls: unknown[] = [];
const xmlCalls: { cfg: activities.XmlConfig; input: unknown }[] = [];
const rssCalls: activities.ResolvedRss[] = [];
const emailCalls: activities.ResolvedSendEmail[] = [];
const hmacCalls: activities.ResolvedHmac[] = [];
const jwtCalls: activities.ResolvedJwt[] = [];
const subResolveCalls: {
  tenantId: string;
  environmentId?: string;
  workflowKey: string;
}[] = [];
const mcpCalls: activities.McpToolConfig[] = [];
const integrationCalls: {
  cfg: { provider: string; action: string };
  fields: Record<string, unknown>;
}[] = [];
const httpCalls: activities.HttpRequestConfig[] = [];
const graphqlCalls: activities.ResolvedGraphQL[] = [];
const sqlCalls: activities.SqlQueryConfig[] = [];
const sqlExecCalls: activities.SqlExecConfig[] = [];
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

// webhook → sqlExec (write) → end. Proves the write node dispatches + rowsAffected
// lands in ctx (params bound the same way as sqlQuery).
const sqlExecGraph: GraphDef = {
  startNodeId: "trigger",
  nodes: [
    { id: "trigger", type: "webhookTrigger" },
    {
      id: "write",
      type: "sqlExec",
      config: {
        connectionId: "db-1",
        sql: "UPDATE users SET seen = true WHERE id = $1",
        paramBindings: { 1: { from: "trigger", path: "userId" } },
      },
    },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "trigger", to: "write" },
    { from: "write", to: "end" },
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

// webhook → compareDatasets(old vs new by id) → end. Pure — no activity.
const compareGraph: GraphDef = {
  startNodeId: "trigger",
  nodes: [
    { id: "trigger", type: "webhookTrigger" },
    {
      id: "diff",
      type: "compareDatasets",
      config: {
        a: { from: "trigger", path: "old" },
        b: { from: "trigger", path: "new" },
        key: "id",
      },
    },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "trigger", to: "diff" },
    { from: "diff", to: "end" },
  ],
};

// webhook → xml(parse) → end. The parse runs in the (mocked) activity.
const xmlGraph: GraphDef = {
  startNodeId: "trigger",
  nodes: [
    { id: "trigger", type: "webhookTrigger" },
    {
      id: "x",
      type: "xml",
      config: { operation: "parse", from: "trigger", path: "body" },
    },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "trigger", to: "x" },
    { from: "x", to: "end" },
  ],
};

// start → humanApproval(timeoutHours:1) → end. With no signal, the durable
// auto-reject timer elapses (the time-skipping env advances it) → rejected.
const approvalTimeoutGraph: GraphDef = {
  startNodeId: "s",
  nodes: [
    { id: "s", type: "start" },
    // ~1.8s real (env is createLocal, not time-skipping) so the durable timer
    // actually fires inside the test; the interpreter math is timeoutHours * 3.6M ms.
    { id: "appr", type: "humanApproval", config: { timeoutHours: 0.0005 } },
    { id: "e", type: "end" },
  ],
  edges: [
    { from: "s", to: "appr" },
    { from: "appr", to: "e" },
  ],
};

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await createLocalTestEnv();
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

/** Items model (design ITEMS-MODEL-CURRENT-ITEM.md) — a splitOut region runs its linear pure body
 *  once per array element, and loopEnd collects the per-item outputs. Graph:
 *  start → splitOut(__input.items) → set{doubled ← sp.n} → loopEnd(set) → end. */
function itemsGraph(): GraphDef {
  return {
    startNodeId: "start",
    nodes: [
      { id: "start", type: "start" },
      {
        id: "sp",
        type: "splitOut",
        config: { from: "__input", path: "items" },
      },
      {
        id: "map",
        type: "set",
        config: { fieldBindings: { doubled: { from: "sp", path: "n" } } },
      },
      { id: "le", type: "loopEnd", config: { from: "map" } },
      { id: "end", type: "end" },
    ],
    edges: [
      { from: "start", to: "sp" },
      { from: "sp", to: "map" },
      { from: "map", to: "le" },
      { from: "le", to: "end" },
    ],
  };
}

describe("runGraph interpreter — unresolved-input diagnostic (ctx.__unresolved)", () => {
  it("records which source produced no output; a fully-resolved run has no __unresolved key", async () => {
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      // `s` binds x from a node that doesn't exist; `ok` binds y from the trigger (resolves).
      const graph: GraphDef = {
        startNodeId: "trigger",
        nodes: [
          { id: "trigger", type: "webhookTrigger" },
          {
            id: "s",
            type: "set",
            config: { fieldBindings: { x: { from: "ghost", path: "y" } } },
          },
          {
            id: "ok",
            type: "set",
            config: { fieldBindings: { y: { from: "trigger", path: "v" } } },
          },
          { id: "end", type: "end" },
        ],
        edges: [
          { from: "trigger", to: "s" },
          { from: "s", to: "ok" },
          { from: "ok", to: "end" },
        ],
      };
      const handle = await env.client.workflow.start(runGraph, {
        args: [graph, { v: 42 }, { tenantId: "t-unresolved" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-unresolved",
      });
      expect((await handle.result()).status).toBe("completed");
      const final = await handle.query(stateQuery);
      const diag = final.ctx.__unresolved as Record<string, unknown[]>;
      // `s` is flagged with the missing source named; the resolved `ok` node is NOT present.
      expect(diag.s).toEqual([
        {
          nodeId: "s",
          field: "fieldBindings.x",
          from: "ghost",
          ref: "ghost.y",
          sourceExists: false,
        },
      ]);
      expect(diag.ok).toBeUndefined();
    });
  });
});

describe("runGraph interpreter — items model (splitOut region)", () => {
  it("runs the region once per item; loopEnd collects the per-item outputs (proves current-item)", async () => {
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [
          itemsGraph(),
          { items: [{ n: 1 }, { n: 2 }, { n: 3 }] },
          { tenantId: "t-items" },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-items-map",
      });
      expect((await handle.result()).status).toBe("completed");
      const final = await handle.query(stateQuery);
      // each iteration read the CURRENT item (sp.n = 1,2,3), not item 0 three times
      expect(final.ctx.le).toEqual([
        { doubled: 1 },
        { doubled: 2 },
        { doubled: 3 },
      ]);
      // items-authoritative: ctx of the region nodes is the FIRST item's projection
      expect(final.ctx.sp).toEqual({ n: 1 });
      expect(final.ctx.map).toEqual({ doubled: 1 });
      // A5-trace: a linear (A2) region captures a per-item grid too — every node LIVE, one row per item.
      const trace = (final.ctx.__regionTrace as Record<string, unknown>).sp as {
        nodes: string[];
        items: Record<string, unknown>[];
      };
      expect(trace.nodes).toEqual(["sp", "map"]);
      expect(trace.items).toEqual([
        { sp: { v: { n: 1 } }, map: { v: { doubled: 1 } } },
        { sp: { v: { n: 2 } }, map: { v: { doubled: 2 } } },
        { sp: { v: { n: 3 } }, map: { v: { doubled: 3 } } },
      ]);
    });
  });

  it("A4: routes each item down an if/else branch and rejoins at a merge (per-item sub-DAG)", async () => {
    // sp → if(sp.big) → true:setBig / false:setSmall → merge → loopEnd(collects merge).
    const a4Graph: GraphDef = {
      startNodeId: "start",
      nodes: [
        { id: "start", type: "start" },
        {
          id: "sp",
          type: "splitOut",
          config: { from: "__input", path: "items" },
        },
        {
          id: "if",
          type: "if",
          config: { conditions: [{ path: "sp.big", op: "eq", value: true }] },
        },
        {
          id: "big",
          type: "set",
          config: {
            fields: { branch: "big" },
            fieldBindings: { n: { from: "sp", path: "n" } },
          },
        },
        {
          id: "small",
          type: "set",
          config: {
            fields: { branch: "small" },
            fieldBindings: { n: { from: "sp", path: "n" } },
          },
        },
        { id: "m", type: "merge", config: { mode: "object" } },
        { id: "le", type: "loopEnd", config: { from: "m" } },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "start", to: "sp" },
        { from: "sp", to: "if" },
        {
          from: "if",
          to: "big",
          condition: { path: "if.result", op: "eq", value: true },
        },
        {
          from: "if",
          to: "small",
          condition: { path: "if.result", op: "eq", value: false },
        },
        { from: "big", to: "m" },
        { from: "small", to: "m" },
        { from: "m", to: "le" },
        { from: "le", to: "end" },
      ],
    };
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [
          a4Graph,
          {
            items: [
              { n: 1, big: true },
              { n: 2, big: false },
              { n: 3, big: true },
            ],
          },
          { tenantId: "t-a4" },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-items-a4",
      });
      expect((await handle.result()).status).toBe("completed");
      const final = await handle.query(stateQuery);
      // each item took ITS branch and rejoined — the merge funnels the one live branch per item
      expect(final.ctx.le).toEqual([
        { branch: "big", n: 1 },
        { branch: "small", n: 2 },
        { branch: "big", n: 3 },
      ]);
    });
  });

  it("A5-trace: captures a per-item tri-state grid (live value / dead branch) in __regionTrace", async () => {
    // Same if/else region as the routing test — assert the intermediate trace, not just the collected
    // output. Item 1 (big=true) → `big` live, `small` DEAD; item 2 (big=false) → the inverse.
    const a4Graph: GraphDef = {
      startNodeId: "start",
      nodes: [
        { id: "start", type: "start" },
        {
          id: "sp",
          type: "splitOut",
          config: { from: "__input", path: "items" },
        },
        {
          id: "if",
          type: "if",
          config: { conditions: [{ path: "sp.big", op: "eq", value: true }] },
        },
        {
          id: "big",
          type: "set",
          config: { fields: { branch: "big" } },
        },
        {
          id: "small",
          type: "set",
          config: { fields: { branch: "small" } },
        },
        { id: "m", type: "merge", config: { mode: "object" } },
        { id: "le", type: "loopEnd", config: { from: "m" } },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "start", to: "sp" },
        { from: "sp", to: "if" },
        {
          from: "if",
          to: "big",
          condition: { path: "if.result", op: "eq", value: true },
        },
        {
          from: "if",
          to: "small",
          condition: { path: "if.result", op: "eq", value: false },
        },
        { from: "big", to: "m" },
        { from: "small", to: "m" },
        { from: "m", to: "le" },
        { from: "le", to: "end" },
      ],
    };
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [
          a4Graph,
          {
            items: [
              { n: 1, big: true },
              { n: 2, big: false },
            ],
          },
          { tenantId: "t-trace" },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-items-trace",
      });
      expect((await handle.result()).status).toBe("completed");
      const final = await handle.query(stateQuery);
      const trace = (final.ctx.__regionTrace as Record<string, unknown>).sp as {
        nodes: string[];
        items: Record<string, unknown>[];
      };
      // columns = splitOut (input item) then the region nodes in topo order
      expect(trace.nodes).toEqual(["sp", "if", "small", "big", "m"]);
      // item 1: big=true → `big` LIVE, `small` DEAD
      expect(trace.items[0].sp).toEqual({ v: { n: 1, big: true } });
      expect(trace.items[0].big).toEqual({ v: { branch: "big" } });
      expect(trace.items[0].small).toEqual({ dead: true });
      // item 2: big=false → the inverse
      expect(trace.items[1].small).toEqual({ v: { branch: "small" } });
      expect(trace.items[1].big).toEqual({ dead: true });
      // __-prefixed → hidden from the node-output list (isNodeOutputKey drops __*)
      expect(final.ctx.__regionTrace).toBeDefined();
    });
  });

  it("A5-trace: __regionTrace SURVIVES continueAsNew (the load-bearing §0.4.2 claim)", async () => {
    // The whole architecture rests on the trace surviving a CAN boundary (post-CAN history is
    // truncated, so a live-only query would lose it). Force a CAN right after the region runs, then
    // assert the completed run STILL carries the grid — proving ctx (and __regionTrace) rides the CAN.
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [
          itemsGraph(),
          { items: [{ n: 1 }, { n: 2 }] },
          // continueAsNewAfterSteps forces a CAN at the first boundary after the region (which alone
          // bumps stepCount past 2); the run then resumes and completes in a fresh segment.
          {
            tenantId: "t-trace-can",
            maxStepsPerRun: 100,
            continueAsNewAfterSteps: 2,
          },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-items-trace-can",
      });
      expect((await handle.result()).status).toBe("completed");
      const final = await handle.query(stateQuery);
      const trace = (final.ctx.__regionTrace as Record<string, unknown>).sp as {
        items: Record<string, unknown>[];
      };
      expect(trace.items).toHaveLength(2); // grid intact across the CAN, not dropped
      expect(trace.items[0].map).toEqual({ v: { doubled: 1 } });
    });
  });

  it("A4: parallel fan-out from splitOut — the merge combines BOTH live branches (object mode)", async () => {
    // sp → {left, right} (both unconditional, both live) → merge(object) → loopEnd.
    const parGraph: GraphDef = {
      startNodeId: "start",
      nodes: [
        { id: "start", type: "start" },
        {
          id: "sp",
          type: "splitOut",
          config: { from: "__input", path: "items" },
        },
        {
          id: "left",
          type: "set",
          config: { fieldBindings: { a: { from: "sp", path: "n" } } },
        },
        {
          id: "right",
          type: "set",
          config: { fields: { tag: "x" } },
        },
        { id: "m", type: "merge", config: { mode: "object" } },
        { id: "le", type: "loopEnd", config: { from: "m" } },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "start", to: "sp" },
        { from: "sp", to: "left" },
        { from: "sp", to: "right" },
        { from: "left", to: "m" },
        { from: "right", to: "m" },
        { from: "m", to: "le" },
        { from: "le", to: "end" },
      ],
    };
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [
          parGraph,
          { items: [{ n: 5 }, { n: 6 }] },
          { tenantId: "t-a4p" },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-items-a4-parallel",
      });
      expect((await handle.result()).status).toBe("completed");
      const final = await handle.query(stateQuery);
      // both branches ran and the merge combined them, per item
      expect(final.ctx.le).toEqual([
        { a: 5, tag: "x" },
        { a: 6, tag: "x" },
      ]);
    });
  });

  it("A4: onError:'continue' on a live-branch node writes {error} into the collected output", async () => {
    // sp → json(parse a NON-JSON field, onError:continue) → merge → loopEnd. The parse throws each
    // item; onError swallows it into {error}, which the merge funnels and loopEnd collects.
    const graph: GraphDef = {
      startNodeId: "start",
      nodes: [
        { id: "start", type: "start" },
        {
          id: "sp",
          type: "splitOut",
          config: { from: "__input", path: "items" },
        },
        {
          id: "j",
          type: "json",
          config: { operation: "parse", from: "sp", path: "bad" },
          onError: "continue",
        },
        { id: "m", type: "merge", config: { mode: "object" } },
        { id: "le", type: "loopEnd", config: { from: "m" } },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "start", to: "sp" },
        { from: "sp", to: "j" },
        { from: "j", to: "m" },
        { from: "m", to: "le" },
        { from: "le", to: "end" },
      ],
    };
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [graph, { items: [{ bad: "xyz" }] }, { tenantId: "t-a4e" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-items-a4-onerror",
      });
      expect((await handle.result()).status).toBe("completed");
      const final = await handle.query(stateQuery);
      const le = final.ctx.le as { error?: string }[];
      expect(le).toHaveLength(1);
      expect(le[0].error).toBeTruthy(); // the parse failure surfaced as {error}, not a run failure
    });
  });

  it("A4: fails closed when per-item activity executions exceed the cap", async () => {
    // sp → httpRequest → merge → loopEnd (a4 because of the merge). One activity per item; 101 items
    // trips MAX_A4_REGION_ACTIVITY_EXECUTIONS (100).
    const graph: GraphDef = {
      startNodeId: "start",
      nodes: [
        { id: "start", type: "start" },
        {
          id: "sp",
          type: "splitOut",
          config: { from: "__input", path: "items" },
        },
        {
          id: "h",
          type: "httpRequest",
          config: { method: "GET", url: "https://x" },
        },
        { id: "m", type: "merge", config: { mode: "array" } },
        { id: "le", type: "loopEnd", config: { from: "m" } },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "start", to: "sp" },
        { from: "sp", to: "h" },
        { from: "h", to: "m" },
        { from: "m", to: "le" },
        { from: "le", to: "end" },
      ],
    };
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const items = Array.from({ length: 101 }, (_, i) => ({ n: i }));
      const handle = await env.client.workflow.start(runGraph, {
        args: [graph, { items }, { tenantId: "t-a4cap" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-items-a4-cap",
      });
      // The nonRetryable cap throw fails the run closed (Temporal wraps the inner ITEMS_A4_ACTIVITY_CAP
      // message as a generic workflow failure). Failing at all is the guarantee under test.
      await expect(handle.result()).rejects.toThrow();
    });
  });

  it("an EMPTY array runs the region zero times → loopEnd is []", async () => {
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [itemsGraph(), { items: [] }, { tenantId: "t-items" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-items-empty",
      });
      expect((await handle.result()).status).toBe("completed");
      const final = await handle.query(stateQuery);
      expect(final.ctx.le).toEqual([]);
    });
  });

  it("a single-element array maps exactly once", async () => {
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [itemsGraph(), { items: [{ n: 7 }] }, { tenantId: "t-items" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-items-single",
      });
      expect((await handle.result()).status).toBe("completed");
      const final = await handle.query(stateQuery);
      expect(final.ctx.le).toEqual([{ doubled: 7 }]);
    });
  });

  it("FAILS CLOSED when the split source is a defined non-array (not silent empty)", async () => {
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [
          itemsGraph(),
          { items: "not-an-array" },
          { tenantId: "t-items" },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-items-nonarray",
      });
      // The run FAILS (rejects) rather than silently mapping 0 times — the ITEMS_NOT_ARRAY
      // ApplicationFailure is wrapped by Temporal's WorkflowFailedError.
      await expect(handle.result()).rejects.toThrow();
    });
  });

  it("region-node executions count toward the step breaker (a wide region × N trips it)", async () => {
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      // start + splitOut + per item (item step + 1 region node) → exceeds a low cap mid-loop.
      const handle = await env.client.workflow.start(runGraph, {
        args: [
          itemsGraph(),
          { items: [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }, { n: 5 }] },
          { tenantId: "t-items", maxStepsPerRun: 4 },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-items-breaker",
      });
      expect((await handle.result()).status).toBe("circuit_open");
    });
  });

  it("A3: an AGENT inside a region runs once per item via ONE batched mapNode (node-major)", async () => {
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const graph: GraphDef = {
        startNodeId: "start",
        nodes: [
          { id: "start", type: "start" },
          {
            id: "sp",
            type: "splitOut",
            config: { from: "__input", path: "items" },
          },
          { id: "ag", type: "agent", config: { systemPrompt: "classify" } },
          { id: "le", type: "loopEnd", config: { from: "ag" } },
          { id: "end", type: "end" },
        ],
        edges: [
          { from: "start", to: "sp" },
          { from: "sp", to: "ag" },
          { from: "ag", to: "le" },
          { from: "le", to: "end" },
        ],
      };
      mapNodeCalls.length = 0;
      const handle = await env.client.workflow.start(runGraph, {
        args: [
          graph,
          { items: [{ n: 1 }, { n: 2 }, { n: 3 }] },
          { tenantId: "t-a3" },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-items-agent",
      });
      expect((await handle.result()).status).toBe("completed");
      const final = await handle.query(stateQuery);
      // loopEnd collected the per-item agent outputs — each got the CURRENT item as input.
      expect(final.ctx.le).toEqual([
        { ran: "agent", on: { n: 1 } },
        { ran: "agent", on: { n: 2 } },
        { ran: "agent", on: { n: 3 } },
      ]);
      // ONE mapNode activity handled all 3 items (not 3 separate agent activities).
      expect(mapNodeCalls).toEqual([{ nodeType: "agent", count: 3 }]);
      // A5-trace: a node-major (batched-activity) region does NOT build a per-item grid — it emits the
      // legible `unavailable` marker so the run view can point at the collected-array table instead.
      expect((final.ctx.__regionTrace as Record<string, unknown>).sp).toEqual({
        unavailable: "batched",
      });
    });
  });

  it("A3: the per-execution budget cap is enforced INSIDE a region (batch cost trips it)", async () => {
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      // The mock mapNode charges items.length * 0.01 → 3 items = 0.03 > cap 0.02.
      const graph: GraphDef = {
        startNodeId: "start",
        nodes: [
          { id: "start", type: "start" },
          {
            id: "sp",
            type: "splitOut",
            config: { from: "__input", path: "items" },
          },
          { id: "ag", type: "agent", config: { systemPrompt: "x" } },
          { id: "le", type: "loopEnd", config: { from: "ag" } },
          { id: "end", type: "end" },
        ],
        edges: [
          { from: "start", to: "sp" },
          { from: "sp", to: "ag" },
          { from: "ag", to: "le" },
          { from: "le", to: "end" },
        ],
      };
      const handle = await env.client.workflow.start(runGraph, {
        args: [
          graph,
          { items: [{ n: 1 }, { n: 2 }, { n: 3 }] },
          { tenantId: "t-a3", perExecutionCapUsd: 0.02 },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-items-budget",
      });
      expect((await handle.result()).status).toBe("budget_exceeded");
    });
  });

  it("A3: a batch over the MAX_MAP_BATCH_ITEMS cap FAILS CLOSED (payload-cap guard)", async () => {
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const graph: GraphDef = {
        startNodeId: "start",
        nodes: [
          { id: "start", type: "start" },
          {
            id: "sp",
            type: "splitOut",
            config: { from: "__input", path: "items" },
          },
          { id: "ag", type: "agent", config: { systemPrompt: "x" } },
          { id: "le", type: "loopEnd", config: { from: "ag" } },
          { id: "end", type: "end" },
        ],
        edges: [
          { from: "start", to: "sp" },
          { from: "sp", to: "ag" },
          { from: "ag", to: "le" },
          { from: "le", to: "end" },
        ],
      };
      const items = Array.from({ length: 101 }, (_, i) => ({ n: i })); // > cap (100)
      const handle = await env.client.workflow.start(runGraph, {
        args: [graph, { items }, { tenantId: "t-a3", maxStepsPerRun: 1000 }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-items-batchcap",
      });
      // Fails closed (rejects) rather than crossing the ~2MB history payload cap.
      await expect(handle.result()).rejects.toThrow();
    });
  });

  it("a missing/undefined split source is treated as empty (no error)", async () => {
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [itemsGraph(), {}, { tenantId: "t-items" }], // no `items` key
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-items-missing",
      });
      expect((await handle.result()).status).toBe("completed");
      expect((await handle.query(stateQuery)).ctx.le).toEqual([]);
    });
  });

  // Back-compat wall (design §8): a graph with NO splitOut must be byte-identical to before the
  // items path existed — the patched gate is never entered.
  it("a graph with no splitOut is unaffected by the items path", async () => {
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const plain: GraphDef = {
        startNodeId: "s",
        nodes: [
          { id: "s", type: "start" },
          {
            id: "set",
            type: "set",
            config: { fields: { hello: "world" } },
          },
          { id: "e", type: "end" },
        ],
        edges: [
          { from: "s", to: "set" },
          { from: "set", to: "e" },
        ],
      };
      const handle = await env.client.workflow.start(runGraph, {
        args: [plain, {}, { tenantId: "t-plain" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-items-nosplit",
      });
      expect((await handle.result()).status).toBe("completed");
      expect((await handle.query(stateQuery)).ctx.set).toEqual({
        hello: "world",
      });
    });
  });
});

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

      await handle.signal(approvalSignal, {
        approved: true,
        comment: "looks good",
      });

      const result = await handle.result();
      expect(result.status).toBe("completed");
      // the decision + reviewer note are recorded on the node's output (durable,
      // branchable downstream as approval.approved / approval.comment)
      expect(result.ctx.approval).toEqual({
        approved: true,
        comment: "looks good",
      });
      // pausing for approval fired a best-effort tenant notification
      expect(
        notifyCalls.some(
          (n) => n.kind === "approval_pending" && n.tenantId === "t-123",
        ),
      ).toBe(true);
    });
  });

  it("humanApproval: auto-rejects when the timeout elapses with no decision (durable timer)", async () => {
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [approvalTimeoutGraph, {}, { tenantId: "t-approve-timeout" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-approve-timeout",
      });
      // No signal is ever sent — the time-skipping env advances the 1h timer, so
      // wf.condition times out → the interpreter auto-rejects.
      const result = await handle.result();
      expect(result.status).toBe("rejected");
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

  it("B5 reference flow: webhook → get_pull_request(diff) → agent → comment_issue → humanApproval composes", async () => {
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const event = {
        action: "opened",
        number: 99,
        repository: { owner: { login: "octocat" }, name: "hello" },
        pull_request: { number: 99 },
      };
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
      // trigger → diff (integration read) → review (agent) → comment (integration write)
      // all ran before the approval pause.
      expect(paused.ctx.trigger).toEqual(event);
      expect(paused.ctx.diff).toMatchObject({ status: "ok", ok: true });
      expect(paused.ctx.review).toMatchObject({ status: "ok" });
      expect(paused.ctx.comment).toMatchObject({ status: "ok" });
      // The interpreter resolved each integration node's fields from UPSTREAM outputs:
      // the diff FETCH uses get_pull_request with owner/repo/number from the trigger,
      // and the comment POST is a comment_issue write on the same PR.
      const fetchCall = integrationCalls[0];
      expect(fetchCall.cfg).toMatchObject({
        provider: "github",
        action: "get_pull_request",
      });
      expect(fetchCall.fields).toMatchObject({
        owner: "octocat",
        repo: "hello",
        pullNumber: 99,
      });
      const commentCall = integrationCalls[integrationCalls.length - 1];
      expect(commentCall.cfg).toMatchObject({
        provider: "github",
        action: "comment_issue",
      });
      expect(commentCall.fields).toMatchObject({ issueNumber: 99 });

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

  it("sqlExec: runs the write + exposes {rowsAffected}; params bound like sqlQuery", async () => {
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [sqlExecGraph, { userId: 7 }, { tenantId: "t-sqlexec" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-sqlexec",
      });
      const result = await handle.result();
      expect(result.status).toBe("completed");
      expect(result.ctx.write).toEqual({ rowsAffected: 2 });
      const call = sqlExecCalls[sqlExecCalls.length - 1];
      expect(call.sql).toBe("UPDATE users SET seen = true WHERE id = $1");
      expect(call.params).toEqual([7]); // bound from trigger.userId, not the SQL text
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
        args: [
          subParentGraph,
          { message: "go" },
          { tenantId: "t-sub", environmentId: "e-sub" },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-subworkflow",
      });
      const result = await handle.result();
      expect(result.status).toBe("completed");
      // the child graph was resolved by workflowKey (in the activity) AND in the PARENT's env — a
      // sub-workflow inherits its parent's environment (Slice 5b).
      expect(subResolveCalls[subResolveCalls.length - 1]).toEqual({
        tenantId: "t-sub",
        environmentId: "e-sub",
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
      // the failure fired a best-effort run_failed notification for the tenant
      expect(
        notifyCalls.some(
          (n) => n.kind === "run_failed" && n.tenantId === "t-stop",
        ),
      ).toBe(true);
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

  it("forEach: fans out ACROSS concurrency-window chunks, in order, replay-safe (audit A-3)", async () => {
    // 25 items with a window of 10 ⇒ chunks [10, 10, 5] (incl. a partial last chunk).
    // Proves the chunked path processes every item in ARRAY ORDER across chunk
    // boundaries, then replays the recorded history with no nondeterminism — the
    // authoritative guard that the sequential-await-per-chunk structure is
    // deterministic (a plain happy-path pass can't prove replay safety).
    const items = Array.from({ length: 25 }, (_, i) => ({ n: i }));
    const worker = await makeWorker();
    const history = await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [forEachGraph(), { items }, { tenantId: "t-fe-chunk" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-foreach-chunk",
      });
      const result = await handle.result();
      expect(result.status).toBe("completed");
      const loop = result.ctx.loop as {
        status: string;
        output: Record<string, unknown>;
      }[];
      expect(loop).toHaveLength(25);
      // every item completed, in array order — chunk boundaries don't reorder/drop
      expect(loop.every((r) => r.status === "completed")).toBe(true);
      expect(loop.map((r) => (r.output.trigger as { n: number }).n)).toEqual(
        items.map((it) => it.n),
      );
      // each child's mocked 0.01 folds into the parent (25 × 0.01)
      expect(result.ctx.__costUsd).toBeCloseTo(0.25, 5);
      return handle.fetchHistory();
    });
    // Replay under the ORIGINAL workflowId — the forEach derives child workflowIds
    // from the parent's id, which runReplayHistory otherwise stubs to "fake".
    await expect(
      Worker.runReplayHistory(
        { workflowsPath: WORKFLOWS_PATH },
        history,
        "e2e-foreach-chunk",
      ),
    ).resolves.toBeUndefined();
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

  it("pollTrigger: CHANGED runs the downstream branch; ctx.poll = {changed,body}", async () => {
    pollChanged = true;
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [pollGraph, {}, { tenantId: "t-poll", workflowKey: "poller" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-poll-changed",
      });
      const result = await handle.result();
      expect(result.status).toBe("completed");
      expect(result.ctx.poll).toEqual({ changed: true, body: { v: 1 } });
      // the "changed" branch reached the agent
      expect(agentCalls.some((m) => m.nodeId === "act")).toBe(true);
      // the activity got the cross-run key (tenant + workflowKey + node)
      expect(pollCalls[pollCalls.length - 1]).toMatchObject({
        tenantId: "t-poll",
        workflowKey: "poller",
        nodeId: "poll",
      });
    });
  });

  it("pollTrigger: UNCHANGED short-circuits to end (downstream skipped)", async () => {
    pollChanged = false;
    const before = agentCalls.length;
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [pollGraph, {}, { tenantId: "t-poll", workflowKey: "poller" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-poll-unchanged",
      });
      const result = await handle.result();
      expect(result.status).toBe("completed");
      expect(result.ctx.poll).toMatchObject({ changed: false });
      // no new agent call — the change branch was NOT taken
      expect(agentCalls.length).toBe(before);
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

  it("compareDatasets: diffs two upstream arrays by key (pure)", async () => {
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [
          compareGraph,
          {
            old: [
              { id: 1, v: "a" },
              { id: 2, v: "b" },
            ],
            new: [
              { id: 2, v: "B" },
              { id: 3, v: "c" },
            ],
          },
          { tenantId: "t-cmp" },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-compare",
      });
      const result = await handle.result();
      expect(result.status).toBe("completed");
      expect(result.ctx.diff).toEqual({
        added: [{ id: 3, v: "c" }],
        removed: [{ id: 1, v: "a" }],
        changed: [{ key: 2, a: { id: 2, v: "b" }, b: { id: 2, v: "B" } }],
        same: [],
      });
    });
  });

  it("xml: interpreter passes the operation + input to the activity, stores the result", async () => {
    xmlCalls.length = 0;
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [xmlGraph, { body: "<n>1</n>" }, { tenantId: "t-xml" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-xml",
      });
      const result = await handle.result();
      expect(result.status).toBe("completed");
      expect(xmlCalls[0]).toMatchObject({
        cfg: { operation: "parse" },
        input: "<n>1</n>",
      });
      expect(result.ctx.x).toEqual({ parsed: "<n>1</n>" });
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

describe("runGraph interpreter — global variables ($vars)", () => {
  it("seeds ctx.$vars from the env-scoped read and resolves {{ $vars.KEY }} in config", async () => {
    loadVariablesResult = { slackChannel: "#alerts", region: "eu" };
    loadVariablesCalls.length = 0;
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      // start → set{channel ← "{{ $vars.slackChannel }}"} → end. The template resolves against the
      // seeded ctx.$vars using the SAME getByPath the rest of the engine uses (no resolver change).
      const graph: GraphDef = {
        startNodeId: "start",
        nodes: [
          { id: "start", type: "start" },
          {
            id: "cfg",
            type: "set",
            config: { fields: { channel: "{{ $vars.slackChannel }}" } },
          },
          { id: "end", type: "end" },
        ],
        edges: [
          { from: "start", to: "cfg" },
          { from: "cfg", to: "end" },
        ],
      };
      const handle = await env.client.workflow.start(runGraph, {
        args: [graph, {}, { tenantId: "t-vars", environmentId: "env-prod" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-vars",
      });
      expect((await handle.result()).status).toBe("completed");
      const final = await handle.query(stateQuery);
      // $vars is seeded as DATA into ctx…
      expect(final.ctx.$vars).toEqual({
        slackChannel: "#alerts",
        region: "eu",
      });
      // …and the template resolved end-to-end into the set node's output.
      expect((final.ctx.cfg as Record<string, unknown>).channel).toBe(
        "#alerts",
      );
      // The run's (tenantId, environmentId) reached the env-scoped read exactly once.
      expect(loadVariablesCalls).toEqual([
        { tenantId: "t-vars", environmentId: "env-prod" },
      ]);
    });
  });
});

describe("runGraph interpreter — environment secrets ($secrets, Tier-1 §4)", () => {
  it("passes `{{ $secrets.X }}` to the activity LITERAL and never puts it in ctx/__unresolved", async () => {
    httpCalls.length = 0;
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      // webhook → httpRequest whose auth header references a secret → end. The workflow must NOT
      // resolve the secret (that would put plaintext in ctx/history); it stays literal for the
      // activity to resolve in-memory. And it must not spuriously flag the header as "unresolved".
      const graph: GraphDef = {
        startNodeId: "trigger",
        nodes: [
          { id: "trigger", type: "webhookTrigger" },
          {
            id: "call",
            type: "httpRequest",
            config: {
              method: "GET",
              url: "https://api.example.com/x",
              headers: { Authorization: "Bearer {{ $secrets.GH_TOKEN }}" },
            },
          },
          { id: "end", type: "end" },
        ],
        edges: [
          { from: "trigger", to: "call" },
          { from: "call", to: "end" },
        ],
      };
      const handle = await env.client.workflow.start(runGraph, {
        args: [graph, { v: 1 }, { tenantId: "t-sec" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-secrets",
      });
      expect((await handle.result()).status).toBe("completed");

      // The activity received the token VERBATIM — the workflow did not resolve or blank it.
      expect(httpCalls[httpCalls.length - 1]?.headers?.Authorization).toBe(
        "Bearer {{ $secrets.GH_TOKEN }}",
      );
      const final = await handle.query(stateQuery);
      // The secret NAME must not leak into the unresolved-input diagnostic (rides history/CAN).
      expect(final.ctx.__unresolved).toBeUndefined();
    });
  });

  it("leaves `{{ $secrets.X }}` literal through the mcpTool ARGUMENT path (resolveMcpArguments)", async () => {
    mcpCalls.length = 0;
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      // A static mcpTool argument references a secret; the interpreter (resolveMcpArguments) must
      // pass the token through VERBATIM for the activity to resolve — never resolve it itself.
      const graph: GraphDef = {
        startNodeId: "start",
        nodes: [
          { id: "start", type: "start" },
          {
            id: "call",
            type: "mcpTool",
            config: {
              connectionId: "conn-x",
              tool: "search",
              arguments: { apiKey: "{{ $secrets.SEARCH_KEY }}", q: "hi" },
            },
          },
          { id: "end", type: "end" },
        ],
        edges: [
          { from: "start", to: "call" },
          { from: "call", to: "end" },
        ],
      };
      const handle = await env.client.workflow.start(runGraph, {
        args: [graph, {}, { tenantId: "t-sec-mcp" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-secrets-mcp",
      });
      expect((await handle.result()).status).toBe("completed");
      // The activity received the token VERBATIM in the arguments.
      expect(
        (mcpCalls[mcpCalls.length - 1]?.arguments as Record<string, unknown>)
          ?.apiKey,
      ).toBe("{{ $secrets.SEARCH_KEY }}");
      const final = await handle.query(stateQuery);
      expect(final.ctx.__unresolved).toBeUndefined();
    });
  });
});

describe("runGraph interpreter — graphQL node", () => {
  it("resolves variable bindings + leaves $secrets literal, exposes {data,errors,httpStatus}", async () => {
    graphqlCalls.length = 0;
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      // webhook → graphQL(query with a variable bound from the trigger + a $secrets auth header) → end.
      const graph: GraphDef = {
        startNodeId: "trigger",
        nodes: [
          { id: "trigger", type: "webhookTrigger" },
          {
            id: "gql",
            type: "graphQL",
            config: {
              url: "https://api.example.com/graphql",
              query: "query($id:ID!){ user(id:$id){ name } }",
              variables: { id: "static" },
              headers: { Authorization: "Bearer {{ $secrets.GQL_TOKEN }}" },
              // bind variables.id from the trigger payload
              argumentBindings: {
                "variables.id": { from: "trigger", path: "userId" },
              },
            },
          },
          { id: "end", type: "end" },
        ],
        edges: [
          { from: "trigger", to: "gql" },
          { from: "gql", to: "end" },
        ],
      };
      const handle = await env.client.workflow.start(runGraph, {
        args: [graph, { userId: "u-9" }, { tenantId: "t-gql" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-graphql",
      });
      expect((await handle.result()).status).toBe("completed");

      const sent = graphqlCalls[graphqlCalls.length - 1];
      // the interpreter resolved the variable binding from the trigger…
      expect(sent?.variables).toEqual({ id: "u-9" });
      // …and left the secret token LITERAL for the activity to resolve in-memory.
      expect(sent?.headers?.Authorization).toBe(
        "Bearer {{ $secrets.GQL_TOKEN }}",
      );
      const final = await handle.query(stateQuery);
      const out = final.ctx.gql as Record<string, unknown>;
      expect(out.httpStatus).toBe(200);
      expect(out.errors).toBeNull();
      expect(final.ctx.__unresolved).toBeUndefined();
    });
  });
});

/**
 * Conditional & multi-path routing — the interpreter walking real branches. Proves switch
 * (multi-way), the standalone if gate, the full edge-condition operator set, a diamond fan-out→merge,
 * and a nested if→switch chain. All pure control-flow (no activity stubs): the branch a run takes is
 * asserted by which terminal `set` node wrote its output into ctx.
 */
describe("runGraph interpreter — conditional & multi-path routing", () => {
  // Run a graph to completion and return {status, ctx}. Each caller passes a unique workflowId.
  async function runFlow(
    graph: GraphDef,
    input: Record<string, unknown>,
    workflowId: string,
    tenantId = "t-route",
  ): Promise<{ status: string; ctx: Record<string, unknown> }> {
    const worker = await makeWorker();
    let result!: { status: string; ctx: Record<string, unknown> };
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [graph, input, { tenantId }],
        taskQueue: TASK_QUEUE,
        workflowId,
      });
      result = (await handle.result()) as {
        status: string;
        ctx: Record<string, unknown>;
      };
    });
    return result;
  }

  // --- switch: multi-way branch on the first matching rule, else fallback ---------------------
  const switchGraph: GraphDef = {
    startNodeId: "trigger",
    nodes: [
      { id: "trigger", type: "webhookTrigger" },
      {
        id: "sw",
        type: "switch",
        config: {
          rules: [
            { name: "high", condition: { path: "trigger.amount", op: "gt", value: 100 } },
            { name: "mid", condition: { path: "trigger.amount", op: "gt", value: 10 } },
          ],
          fallback: "low",
        },
      },
      { id: "tHigh", type: "set", config: { fields: { tier: "high" } } },
      { id: "tMid", type: "set", config: { fields: { tier: "mid" } } },
      { id: "tLow", type: "set", config: { fields: { tier: "low" } } },
      { id: "end", type: "end" },
    ],
    edges: [
      { from: "trigger", to: "sw" },
      { from: "sw", to: "tHigh", condition: { path: "sw.matched", op: "eq", value: "high" } },
      { from: "sw", to: "tMid", condition: { path: "sw.matched", op: "eq", value: "mid" } },
      { from: "sw", to: "tLow", condition: { path: "sw.matched", op: "eq", value: "low" } },
      { from: "tHigh", to: "end" },
      { from: "tMid", to: "end" },
      { from: "tLow", to: "end" },
    ],
  };

  it("switch: first matching rule wins (250 matches high AND mid → high) and only that branch runs", async () => {
    const r = await runFlow(switchGraph, { amount: 250 }, "e2e-switch-high");
    expect(r.status).toBe("completed");
    expect(r.ctx.sw).toEqual({ matched: "high" });
    expect(r.ctx.tHigh).toEqual({ tier: "high" });
    expect(r.ctx.tMid).toBeUndefined();
    expect(r.ctx.tLow).toBeUndefined();
  });

  it("switch: a later rule matches when the first doesn't (50 → mid)", async () => {
    const r = await runFlow(switchGraph, { amount: 50 }, "e2e-switch-mid");
    expect(r.ctx.sw).toEqual({ matched: "mid" });
    expect(r.ctx.tMid).toEqual({ tier: "mid" });
    expect(r.ctx.tHigh).toBeUndefined();
  });

  it("switch: no rule matches → the fallback branch (5 → low)", async () => {
    const r = await runFlow(switchGraph, { amount: 5 }, "e2e-switch-low");
    expect(r.ctx.sw).toEqual({ matched: "low" });
    expect(r.ctx.tLow).toEqual({ tier: "low" });
  });

  // --- if: boolean gate → true/false edges ----------------------------------------------------
  function ifGraph(config: Record<string, unknown>): GraphDef {
    return {
      startNodeId: "trigger",
      nodes: [
        { id: "trigger", type: "webhookTrigger" },
        { id: "gate", type: "if", config },
        { id: "tYes", type: "set", config: { fields: { took: "yes" } } },
        { id: "tNo", type: "set", config: { fields: { took: "no" } } },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "trigger", to: "gate" },
        { from: "gate", to: "tYes", condition: { path: "gate.result", op: "eq", value: true } },
        { from: "gate", to: "tNo", condition: { path: "gate.result", op: "eq", value: false } },
        { from: "tYes", to: "end" },
        { from: "tNo", to: "end" },
      ],
    };
  }

  it("if: a passing predicate takes the true edge", async () => {
    const g = ifGraph({ conditions: [{ path: "trigger.amount", op: "gt", value: 100 }] });
    const r = await runFlow(g, { amount: 250 }, "e2e-if-true");
    expect(r.ctx.gate).toEqual({ result: true });
    expect(r.ctx.tYes).toEqual({ took: "yes" });
    expect(r.ctx.tNo).toBeUndefined();
  });

  it("if: a failing predicate takes the false edge", async () => {
    const g = ifGraph({ conditions: [{ path: "trigger.amount", op: "gt", value: 100 }] });
    const r = await runFlow(g, { amount: 5 }, "e2e-if-false");
    expect(r.ctx.gate).toEqual({ result: false });
    expect(r.ctx.tNo).toEqual({ took: "no" });
    expect(r.ctx.tYes).toBeUndefined();
  });

  it("if: combine 'or' passes when any predicate holds; 'and' needs all", async () => {
    const or = ifGraph({
      combine: "or",
      conditions: [
        { path: "trigger.a", op: "eq", value: 1 },
        { path: "trigger.b", op: "eq", value: 2 },
      ],
    });
    expect((await runFlow(or, { a: 0, b: 2 }, "e2e-if-or")).ctx.gate).toEqual({ result: true });

    const and = ifGraph({
      combine: "and",
      conditions: [
        { path: "trigger.a", op: "eq", value: 1 },
        { path: "trigger.b", op: "eq", value: 2 },
      ],
    });
    expect((await runFlow(and, { a: 1, b: 0 }, "e2e-if-and")).ctx.gate).toEqual({ result: false });
  });

  it("if: empty conditions ⇒ false (a gate with nothing to test doesn't pass)", async () => {
    const r = await runFlow(ifGraph({ conditions: [] }), {}, "e2e-if-empty");
    expect(r.ctx.gate).toEqual({ result: false });
    expect(r.ctx.tNo).toEqual({ took: "no" });
  });

  // --- edge-condition operators: the full op set, via a single-condition if gate --------------
  const OP_CASES: Array<{
    op: string;
    value?: unknown;
    v: unknown;
    expected: boolean;
  }> = [
    { op: "eq", value: "x", v: "x", expected: true },
    { op: "eq", value: "x", v: "y", expected: false },
    { op: "neq", value: "x", v: "y", expected: true },
    { op: "gt", value: 10, v: 20, expected: true },
    { op: "gt", value: 10, v: 5, expected: false },
    { op: "gte", value: 10, v: 10, expected: true },
    { op: "lt", value: 10, v: 5, expected: true },
    { op: "lte", value: 10, v: 10, expected: true },
    { op: "in", value: ["a", "b"], v: "b", expected: true },
    { op: "in", value: ["a", "b"], v: "c", expected: false },
    { op: "contains", value: "ell", v: "hello", expected: true },
    { op: "notContains", value: "z", v: "hello", expected: true },
    { op: "startsWith", value: "he", v: "hello", expected: true },
    { op: "endsWith", value: "lo", v: "hello", expected: true },
    { op: "regex", value: "^h.*o$", v: "hello", expected: true },
    { op: "exists", v: "present", expected: true },
    { op: "isEmpty", v: "", expected: true },
    { op: "notEmpty", v: "x", expected: true },
  ];

  it.each(OP_CASES)(
    "edge condition op '$op' (value=$value, v=$v) → $expected",
    async ({ op, value, v, expected }) => {
      const condition =
        value === undefined
          ? { path: "trigger.v", op }
          : { path: "trigger.v", op, value };
      const g = ifGraph({ conditions: [condition] });
      const r = await runFlow(g, { v }, `e2e-op-${op}-${String(v)}`);
      expect(r.ctx.gate).toEqual({ result: expected });
    },
  );

  // --- diamond: unconditional fan-out to 3 parallel branches → merge (object) ------------------
  it("diamond: fan-out to 3 parallel set nodes, merge combines all (multi-path join)", async () => {
    const diamond: GraphDef = {
      startNodeId: "trigger",
      nodes: [
        { id: "trigger", type: "webhookTrigger" },
        { id: "a", type: "set", config: { fields: { a: 1 } } },
        { id: "b", type: "set", config: { fields: { b: 2 } } },
        { id: "c", type: "set", config: { fields: { c: 3 } } },
        { id: "join", type: "merge", config: { mode: "object" } },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "trigger", to: "a" },
        { from: "trigger", to: "b" },
        { from: "trigger", to: "c" },
        { from: "a", to: "join" },
        { from: "b", to: "join" },
        { from: "c", to: "join" },
        { from: "join", to: "end" },
      ],
    };
    const r = await runFlow(diamond, {}, "e2e-diamond");
    expect(r.status).toBe("completed");
    expect(r.ctx.join).toEqual({ a: 1, b: 2, c: 3 });
  });

  // --- nested: if → (true) switch → branch; the false branch is never entered -----------------
  it("nested if→switch: chained conditionals route to the deep branch", async () => {
    const nested: GraphDef = {
      startNodeId: "trigger",
      nodes: [
        { id: "trigger", type: "webhookTrigger" },
        { id: "gate", type: "if", config: { conditions: [{ path: "trigger.amount", op: "gt", value: 0 }] } },
        {
          id: "sw",
          type: "switch",
          config: {
            rules: [{ name: "b", condition: { path: "trigger.category", op: "eq", value: "b" } }],
            fallback: "other",
          },
        },
        { id: "hitB", type: "set", config: { fields: { path: "b" } } },
        { id: "hitOther", type: "set", config: { fields: { path: "other" } } },
        { id: "neg", type: "set", config: { fields: { path: "neg" } } },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "trigger", to: "gate" },
        { from: "gate", to: "sw", condition: { path: "gate.result", op: "eq", value: true } },
        { from: "gate", to: "neg", condition: { path: "gate.result", op: "eq", value: false } },
        { from: "sw", to: "hitB", condition: { path: "sw.matched", op: "eq", value: "b" } },
        { from: "sw", to: "hitOther", condition: { path: "sw.matched", op: "eq", value: "other" } },
        { from: "hitB", to: "end" },
        { from: "hitOther", to: "end" },
        { from: "neg", to: "end" },
      ],
    };
    const r = await runFlow(nested, { amount: 5, category: "b" }, "e2e-nested");
    expect(r.status).toBe("completed");
    expect(r.ctx.gate).toEqual({ result: true });
    expect(r.ctx.sw).toEqual({ matched: "b" });
    expect(r.ctx.hitB).toEqual({ path: "b" });
    expect(r.ctx.hitOther).toBeUndefined();
    expect(r.ctx.neg).toBeUndefined();
  });
});


/**
 * Per-node execution matrix (Part 2): prove every remaining node type actually RUNS through the real
 * interpreter and produces its documented output. Part 1 covered the conditional/routing nodes and the
 * I/O nodes above; this block fills the gaps — the pure transforms (noOp/number), the activity-backed
 * transforms (csv/encode/hash/htmlExtract/markdown/random), and the three passthrough entry triggers
 * (chatTrigger/formTrigger/scheduleTrigger). Config shapes + output shapes are taken from the DSL
 * schema (packages/dsl/src/registry.ts) and the interpreter's own dispatch (workflow/run-graph.ts).
 *
 * Note: `regex`, `group`, and `summary` are NOT node types — `regex` is a ConditionOp and
 * group/summary are catalog metadata fields. The intent is already covered: `text` (regexExtract) and
 * `aggregate` are tested elsewhere in this file.
 */
describe("runGraph interpreter — per-node execution matrix", () => {
  // Local run helper: start the graph, await the terminal result, return { status, ctx }.
  async function runFlow(
    graph: GraphDef,
    input: unknown,
    workflowId: string,
    tenantId = "t-matrix",
  ): Promise<{ status: string; ctx: Record<string, unknown> }> {
    const worker = await makeWorker();
    return worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [graph, input, { tenantId }],
        taskQueue: TASK_QUEUE,
        workflowId,
      });
      return (await handle.result()) as {
        status: string;
        ctx: Record<string, unknown>;
      };
    });
  }

  // Build a linear `webhookTrigger → <node> → end` graph feeding the node the run input.
  function oneNodeGraph(id: string, type: string, config?: unknown): GraphDef {
    return {
      startNodeId: "trigger",
      nodes: [
        { id: "trigger", type: "webhookTrigger" },
        { id, type, ...(config ? { config } : {}) },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "trigger", to: id },
        { from: id, to: "end" },
      ],
    } as GraphDef;
  }

  // ── A. Pure transform nodes ────────────────────────────────────────────────

  it("noOp: emits {} and passes control through (structural placeholder)", async () => {
    const result = await runFlow(
      oneNodeGraph("nop", "noOp"),
      { anything: 1 },
      "e2e-matrix-noop",
    );
    expect(result.status).toBe("completed");
    expect(result.ctx.nop).toEqual({});
  });

  it("number: runs the arithmetic op on static + bound operands → { result } (pure)", async () => {
    // a is static (6); b binds from the trigger (7) → multiply = 42. Proves both operand paths.
    const result = await runFlow(
      oneNodeGraph("calc", "number", {
        operation: "multiply",
        a: 6,
        bBinding: { from: "trigger", path: "factor" },
      }),
      { factor: 7 },
      "e2e-matrix-number",
    );
    expect(result.status).toBe("completed");
    expect(result.ctx.calc).toEqual({ result: 42 });
  });

  it("csv: passes {operation,header,delimiter} + resolved input to the activity; stores res.result", async () => {
    csvCalls.length = 0;
    const result = await runFlow(
      oneNodeGraph("parse", "csv", {
        operation: "parse",
        from: "trigger",
        path: "raw",
        header: true,
        delimiter: ",",
      }),
      { raw: "id,name\n1,Ada" },
      "e2e-matrix-csv",
    );
    expect(result.status).toBe("completed");
    // ctx.<node> IS the activity's `result` (interpreter unwraps .result for csv)
    expect(result.ctx.parse).toEqual([{ id: "1", name: "Ada" }]);
    // the interpreter resolved the input value from the trigger + threaded the parse options
    expect(csvCalls[0].input).toBe("id,name\n1,Ada");
    expect(csvCalls[0].cfg).toEqual({
      operation: "parse",
      header: true,
      delimiter: ",",
    });
  });

  it("encode: resolves input + operation, stores { result } (wrapped)", async () => {
    encodeCalls.length = 0;
    const result = await runFlow(
      oneNodeGraph("enc", "encode", {
        operation: "base64Encode",
        from: "trigger",
        path: "text",
      }),
      { text: "hi" },
      "e2e-matrix-encode",
    );
    expect(result.status).toBe("completed");
    // encode WRAPS: ctx.<node> = { result: res.result }
    expect(result.ctx.enc).toEqual({ result: "enc(hi)" });
    expect(encodeCalls[0].input).toBe("hi");
    expect(encodeCalls[0].cfg).toEqual({ operation: "base64Encode" });
  });

  it("hash: resolves the bound input in-workflow, hashes in-activity → { digest }", async () => {
    hashCalls.length = 0;
    const result = await runFlow(
      oneNodeGraph("h", "hash", {
        algorithm: "sha256",
        inputBinding: { from: "trigger", path: "body" },
        encoding: "hex",
      }),
      { body: { amount: 5 } },
      "e2e-matrix-hash",
    );
    expect(result.status).toBe("completed");
    expect(result.ctx.h).toEqual({ digest: "deadbeef" });
    // resolveHash threaded the bound value + algorithm/encoding into the activity (key never here)
    expect(hashCalls[0]).toEqual({
      algorithm: "sha256",
      input: { amount: 5 },
      encoding: "hex",
    });
  });

  it("htmlExtract: passes selectors + resolved HTML to the activity; stores res.result", async () => {
    htmlExtractCalls.length = 0;
    const result = await runFlow(
      oneNodeGraph("x", "htmlExtract", {
        from: "trigger",
        path: "html",
        extractions: [{ key: "title", selector: "h1" }],
      }),
      { html: "<h1>Hello</h1>" },
      "e2e-matrix-html",
    );
    expect(result.status).toBe("completed");
    expect(result.ctx.x).toEqual({ title: "Hello" });
    expect(htmlExtractCalls[0].input).toBe("<h1>Hello</h1>");
    expect(htmlExtractCalls[0].cfg).toEqual({
      extractions: [{ key: "title", selector: "h1" }],
    });
  });

  it("markdown: passes the resolved HTML to the activity; stores res.result", async () => {
    markdownCalls.length = 0;
    const result = await runFlow(
      oneNodeGraph("md", "markdown", { from: "trigger", path: "html" }),
      { html: "<h1>Hi</h1>" },
      "e2e-matrix-markdown",
    );
    expect(result.status).toBe("completed");
    expect(result.ctx.md).toEqual({ markdown: "# Hi" });
    // callMarkdown's first positional arg is the INPUT (no cfg param) — proves the resolved value
    expect(markdownCalls[0]).toBe("<h1>Hi</h1>");
  });

  // ── C. random (activity — Math.random is banned in workflow code) ──────────

  it("random: runs in an activity and threads its value downstream", async () => {
    randomCalls.length = 0;
    // trigger → rnd(random) → capture(set binds from rnd.value) → end. Proves the node runs AND its
    // value flows into a downstream node's output (not just sits in ctx).
    const graph: GraphDef = {
      startNodeId: "trigger",
      nodes: [
        { id: "trigger", type: "webhookTrigger" },
        {
          id: "rnd",
          type: "random",
          config: { operation: "hex", length: 16 },
        },
        {
          id: "capture",
          type: "set",
          config: { fieldBindings: { token: { from: "rnd", path: "value" } } },
        },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "trigger", to: "rnd" },
        { from: "rnd", to: "capture" },
        { from: "capture", to: "end" },
      ],
    };
    const result = await runFlow(graph, {}, "e2e-matrix-random");
    expect(result.status).toBe("completed");
    // output is { value } (the activity generates it — no input)
    expect(result.ctx.rnd).toEqual({ value: "r4nd0mhex" });
    // the config (operation + length) reached the activity
    expect(randomCalls[0]).toEqual({
      operation: "hex",
      length: 16,
      min: undefined,
      max: undefined,
    });
    // …and the value threaded into the downstream set node
    expect(result.ctx.capture).toEqual({ token: "r4nd0mhex" });
  });

  // ── B. Entry trigger nodes (output == the trigger event/fields) ────────────

  it.each([
    ["scheduleTrigger", { cron: "0 0 * * *" }],
    ["formTrigger", { title: "Contact" }],
    ["chatTrigger", {}],
  ] as const)(
    "%s: entry passthrough — the run input becomes the trigger node's output",
    async (type, config) => {
      const event = { message: "hello", sessionId: "s-1", n: 3 };
      const graph: GraphDef = {
        startNodeId: "trig",
        nodes: [
          { id: "trig", type, config },
          { id: "end", type: "end" },
        ],
        edges: [{ from: "trig", to: "end" }],
      } as GraphDef;
      const result = await runFlow(graph, event, `e2e-matrix-${type}`);
      expect(result.status).toBe("completed");
      // the inbound event IS the entry node's output (like webhookTrigger)
      expect(result.ctx.trig).toEqual(event);
    },
  );
});
