// Shared harness for the interpreter e2e specs (split out of interpreter.e2e.spec.ts).
// Runs the REAL runGraph interpreter under TestWorkflowEnvironment with all I/O
// activities MOCKED — hermetic, no LLM/key/DB/network. Each split spec file owns its
// own TestWorkflowEnvironment (created in its beforeAll) and calls makeWorker(env).
//
// ESM note: the mockActivities read a handful of MUTABLE knobs each test fixes
// (env variable set, poll changed-ness, HTTP response, budget-pause probes). ESM
// import bindings are read-only, so these live on the exported `harnessState`
// object (mutate its properties, never reassign the binding).
import * as path from "node:path";
import { ApplicationFailure } from "@temporalio/activity";
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { TASK_QUEUE, type ApprovalAwaitingRecord } from "@naary/contracts";
import { resolveTemplates } from "@naary/dsl";
import type { ApprovalNodeConfig, GraphDef } from "@naary/dsl";
import type * as activities from "../src/temporal/activities";
import {
  expandItems as realExpandItems,
  offloadCtxEntry as realOffloadCtxEntry,
} from "../src/temporal/activities/items";

// Mutable knobs the mockActivities read; tests fix these per-scenario. (Reassigning
// an ESM import binding is illegal, so they hang off this one exported object.)
export const harnessState: {
  loadVariablesResult: Record<string, string>;
  loadTemplateResult: {
    subject: string | null;
    blocks: import("@naary/dsl").TemplateBlock[];
  } | null;
  pollChanged: boolean;
  pauseAgentFailures: number;
  refreshBudgetResult: activities.BudgetSnapshot | null;
  httpResponse: activities.HttpRequestResult;
} = {
  loadVariablesResult: { slackChannel: "#alerts" },
  loadTemplateResult: null,
  pollChanged: true,
  pauseAgentFailures: 0,
  refreshBudgetResult: null,
  httpResponse: {
    status: "ok",
    httpStatus: 200,
    headers: {},
    body: { ok: true },
    costUsd: 0,
  },
};

// Temporal's own bundler (not vitest) processes this path, so it must be a real
// absolute filesystem path. require.resolve() is intercepted under vitest and
// fails here — use __dirname instead.
const WORKFLOWS_PATH = path.join(__dirname, "../src/temporal/workflows.ts");

// Mock runAgent so the e2e stays hermetic — no real LLM/key/DB. (The real agent
// activity is unit-tested in agent.activity.spec.ts; live run is deferred until
// a provider key is supplied.) Captures the meta to prove tenantId threading.
const agentCalls: activities.AgentMeta[] = [];
const codeAgentCalls: activities.CodeAgentActivityConfig[] = [];
const mockActivities = {
  runAgent: async (
    _cfg: activities.AgentConfig,
    _input: unknown,
    meta: activities.AgentMeta,
  ): Promise<activities.AgentResult> => {
    agentCalls.push(meta);
    // Slice 2 failure-classification probe: this tenant's agent fails like a real
    // provider 429 (agent.ts maps 429 → non-retryable "QUOTA").
    if (meta.tenantId === "t-quota-fail") {
      throw ApplicationFailure.nonRetryable(
        "Provider rate limit exhausted",
        "QUOTA",
      );
    }
    // Slice 3 pause-not-fail probe: mirror agent.ts under a LIVE policy of "pause" —
    // the monthly-cap reservation refuses N times (BUDGET_PAUSE), then succeeds
    // (the cap was raised / the month rolled over between attempts).
    if (harnessState.pauseAgentFailures > 0) {
      harnessState.pauseAgentFailures -= 1;
      throw ApplicationFailure.nonRetryable(
        "Monthly budget exceeded — run paused until the cap is raised or the month rolls over",
        "BUDGET_PAUSE",
        { tenantId: meta.tenantId },
      );
    }
    return {
      status: "ok",
      output: { category: "billing", urgency: 3 },
      model: "claude-opus-4-8",
      costUsd: 0.01,
    };
  },
  // Claude-Code-as-Agent-provider routing: an agent node with provider "claude-code" runs the
  // codeAgent activity instead of runAgent. Capture the mapped config to prove the mapping.
  callCodeAgent: async (
    cfg: activities.CodeAgentActivityConfig,
    _input: unknown,
    _meta: activities.AgentMeta,
  ): Promise<activities.CodeAgentResult> => {
    codeAgentCalls.push(cfg);
    return {
      status: "ok",
      output: {
        result: "PLAN: summarize the input",
        tool: cfg.tool ?? "claude",
      },
      costUsd: 0.02,
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
    return harnessState.httpResponse;
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
    return {
      status: "ok",
      changed: harnessState.pollChanged,
      body: { v: 1 },
      costUsd: 0,
    };
  },
  sendNotification: async (
    input: activities.NotificationInput,
  ): Promise<void> => {
    notifyCalls.push(input);
  },
  // Slice 1 pause-side snapshot. Mirrors the real activity's shape: contextFields resolved
  // with the SAME resolveTemplates against the ctx snapshot the interpreter handed over
  // (proving eval happens in-activity on pause-time data), a fixed pausedAt, and group
  // display names derived from the ids (the real activity reads them from PG).
  prepareApproval: async (input: {
    tenantId: string;
    nodeId: string;
    config: ApprovalNodeConfig;
    ctx: Record<string, unknown>;
  }): Promise<ApprovalAwaitingRecord> => {
    prepareApprovalCalls.push(input);
    const cfg = input.config;
    const contextFields = cfg.contextFields
      ? Object.fromEntries(
          Object.entries(cfg.contextFields).map(([k, v]) => {
            const r = (resolveTemplates({ v }, input.ctx) as { v: unknown }).v;
            return [
              k,
              r == null
                ? ""
                : typeof r === "object"
                  ? JSON.stringify(r)
                  : String(r),
            ];
          }),
        )
      : undefined;
    return {
      nodeId: input.nodeId,
      pausedAt: "2026-01-01T00:00:00.000Z",
      ...(cfg.slaHours ? { slaHours: cfg.slaHours } : {}),
      ...(contextFields ? { contextFields } : {}),
      ...(cfg.approvers
        ? {
            approvers: {
              emails: cfg.approvers.emails ?? [],
              groups: (cfg.approvers.groupIds ?? []).map((id) => ({
                id,
                name: `${id}-name`,
              })),
            },
          }
        : {}),
      ...(cfg.escalateAfterHours
        ? {
            escalateAfterHours: cfg.escalateAfterHours,
            ...(cfg.escalateTo ? { escalateTo: cfg.escalateTo } : {}),
          }
        : {}),
    };
  },
  recordExecution: async (): Promise<void> => undefined, // run-ownership upsert; no-op here
  // Slice 3: the post-resume budget re-read. Mutable result so a test can model the
  // PUT that raised the caps; captures calls to prove the re-read happens on resume.
  refreshBudget: async (meta: {
    tenantId: string;
  }): Promise<activities.BudgetSnapshot | null> => {
    refreshBudgetCalls.push(meta);
    return harnessState.refreshBudgetResult;
  },
  // Read-model push — captured so Slice-2 tests can assert the terminal-failure
  // status + classified failureKind reach the Execution row.
  setExecutionStatus: async (meta: {
    workflowId: string;
    status: string;
    costUsd?: number;
    failureKind?: string;
    failedNodeId?: string;
    executedNodeIds?: string[];
  }): Promise<void> => {
    statusPushes.push(meta);
  },
  // Global Variables ($vars): return the env-scoped config the interpreter seeds into ctx.$vars.
  // Captures the meta so a test can prove the run's (tenantId, environmentId) reach the read.
  loadVariables: async (meta: {
    tenantId: string;
    environmentId?: string;
  }): Promise<Record<string, string>> => {
    loadVariablesCalls.push(meta);
    return harnessState.loadVariablesResult;
  },
  // Content templates: return the template blocks a sendEmail node renders (null = deleted → the
  // handler falls back to the inline body). Default null, so specs not using templates are unaffected.
  loadTemplate: async (
    _templateId: string,
    _meta: { tenantId: string; environmentId?: string },
  ): Promise<{
    subject: string | null;
    blocks: import("@naary/dsl").TemplateBlock[];
  } | null> => harnessState.loadTemplateResult,
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
  // Items claim-check expansion (#479): the REAL activity, not a mock. Its only I/O is the object
  // store, which defaults to the in-memory implementation — so the e2e stays hermetic while
  // exercising the actual rehydrate → getByPath → per-element-offload path the interpreter relies on.
  // Imported from its own module (not the activities barrel) to keep DB/AWS clients out of the test.
  expandItems: realExpandItems,
  // continueAsNew ctx offload (#681): also the REAL activity, for the same reason as expandItems —
  // its only I/O is the object store (in-memory by default), so the chaos/CAN specs exercise the
  // actual claim-check PUT + reference the interpreter carries across the boundary.
  offloadCtxEntry: realOffloadCtxEntry,
};
const mapNodeCalls: { nodeType: string; count: number }[] = [];
const statusPushes: {
  workflowId: string;
  status: string;
  costUsd?: number;
  failureKind?: string;
  failedNodeId?: string;
  executedNodeIds?: string[];
}[] = [];
const loadVariablesCalls: { tenantId: string; environmentId?: string }[] = [];
const pollCalls: activities.PollMeta[] = [];
const refreshBudgetCalls: { tenantId: string }[] = [];
const notifyCalls: activities.NotificationInput[] = [];
const prepareApprovalCalls: {
  tenantId: string;
  nodeId: string;
  config: ApprovalNodeConfig;
  ctx: Record<string, unknown>;
}[] = [];

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

/** Build a Worker bound to the given per-file test env. */
export function makeWorker(env: TestWorkflowEnvironment): Promise<Worker> {
  return Worker.create({
    connection: env.nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowsPath: WORKFLOWS_PATH,
    activities: mockActivities,
  });
}

export {
  // constants
  TASK_QUEUE,
  WORKFLOWS_PATH,
  // capture arrays
  agentCalls,
  codeAgentCalls,
  mapNodeCalls,
  statusPushes,
  loadVariablesCalls,
  pollCalls,
  refreshBudgetCalls,
  notifyCalls,
  prepareApprovalCalls,
  codeCalls,
  totpCalls,
  csvCalls,
  encodeCalls,
  hashCalls,
  randomCalls,
  htmlExtractCalls,
  markdownCalls,
  xmlCalls,
  rssCalls,
  emailCalls,
  hmacCalls,
  jwtCalls,
  subResolveCalls,
  mcpCalls,
  integrationCalls,
  httpCalls,
  graphqlCalls,
  sqlCalls,
  sqlExecCalls,
  // graph fixtures
  pollGraph,
  httpBranchGraph,
  sqlGraph,
  sqlExecGraph,
  setGraph,
  subChildGraph,
  subThrowChildGraph,
  subRejectChildGraph,
  errorHandlerGraph,
  throwGraph,
  danglingGraph,
  subParentGraph,
  waitGraph,
  stopGraph,
  transformGraph,
  signingGraph,
  emailGraph,
  totpGraph,
  arrayGraph,
  rssGraph,
  respondGraph,
  codeGraph,
  compareGraph,
  xmlGraph,
  approvalTimeoutGraph,
  // fixture factories + helpers
  forEachGraph,
  diamondGraph,
  itemsGraph,
  waitFor,
};
