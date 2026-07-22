// Global variables, environment secrets and the graphQL node.
// Split out of interpreter.e2e.spec.ts (issue #496). Shared harness + fixtures
// live in ./interpreter-harness; this file owns its own TestWorkflowEnvironment.
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { createLocalTestEnv } from "./local-test-env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stateQuery } from "@naary/contracts";
import type { GraphDef } from "@naary/dsl";
import { runGraph } from "../src/temporal/workflows";
import {
  TASK_QUEUE,
  loadVariablesCalls,
  mcpCalls,
  httpCalls,
  graphqlCalls,
  harnessState,
  makeWorker,
} from "./interpreter-harness";

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await createLocalTestEnv();
}, 60_000);

afterAll(async () => {
  await env?.teardown();
});

describe("runGraph interpreter — global variables ($vars)", () => {
  it("seeds ctx.$vars from the env-scoped read and resolves {{ $vars.KEY }} in config", async () => {
    harnessState.loadVariablesResult = { slackChannel: "#alerts", region: "eu" };
    loadVariablesCalls.length = 0;
    const worker = await makeWorker(env);
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
    const worker = await makeWorker(env);
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
    const worker = await makeWorker(env);
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
    const worker = await makeWorker(env);
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
