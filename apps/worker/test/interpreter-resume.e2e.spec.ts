// Resume a failed run AT the failed node (docs/design/RESUME-FROM-FAILED-NODE.md).
//
// This is the proof for the whole feature, in the exact shape that motivated it: a NON-IDEMPOTENT
// node succeeds, the next node fails on a transport error, and the resumed run must continue WITHOUT
// repeating the side effect. A plain re-run sends the email twice; that is the bug being fixed, so
// `emailCalls` is the assertion that matters most here.
//
// It exercises the real interpreter through `ResumeState` — the same arg 4 the API's resume path
// builds from its snapshot — so what passes here is what production does, not a parallel mock.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import type { GraphDef } from "@naary/dsl";
import { runGraph } from "../src/temporal/workflows";
import {
  TASK_QUEUE,
  emailCalls,
  harnessState,
  httpCalls,
  loadVariablesCalls,
  makeWorker,
} from "./interpreter-harness";
import { createLocalTestEnv } from "./local-test-env";

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await createLocalTestEnv();
}, 60_000);

afterAll(async () => {
  await env?.teardown();
});

beforeEach(() => {
  emailCalls.length = 0;
  httpCalls.length = 0;
  loadVariablesCalls.length = 0;
  harnessState.httpFailures = 0;
});

/** email → http → tail. The email node is the one that must never run twice. */
const graph: GraphDef = {
  startNodeId: "email",
  nodes: [
    {
      id: "email",
      type: "sendEmail",
      config: {
        connectionId: "smtp-1",
        to: "ops@example.com",
        subject: "Order received",
        text: "thanks",
      } as never,
    },
    {
      id: "http",
      type: "httpRequest",
      config: {
        url: "https://api.example.com/orders",
        method: "POST",
      } as never,
    },
    { id: "tail", type: "set", config: { fields: { done: "yes" } } as never },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "email", to: "http" },
    { from: "http", to: "tail" },
    { from: "tail", to: "end" },
  ],
};

describe("runGraph interpreter — resume at the failed node", () => {
  it("fails at the http node AFTER the email was sent (the situation being fixed)", async () => {
    const worker = await makeWorker(env);
    harnessState.httpFailures = 1;
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [graph, { orderId: 7 }, { tenantId: "t-1" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-resume-original",
      });
      await expect(handle.result()).rejects.toThrow();
    });
    // The side effect happened exactly once, and the run died before the tail.
    expect(emailCalls).toHaveLength(1);
    expect(httpCalls).toHaveLength(1);
  });

  /**
   * THE test. Same graph, seeded with the ctx the failed run had, starting at the node that died.
   * A re-run would call sendEmail a second time; a resume must not.
   */
  it("resumes at the failed node: completes, and does NOT re-send the email", async () => {
    const worker = await makeWorker(env);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [
          graph,
          { orderId: 7 },
          { tenantId: "t-1" },
          {
            // What the API rehydrates from the snapshot in object storage.
            ctx: {
              email: { status: "ok", messageId: "<sent@test>" },
            },
            startNodeId: "http",
            costUsd: 0,
            stepCount: 0,
            reseedVars: true,
          },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-resume-continued",
      });
      const result = await handle.result();
      expect(result.status).toBe("completed");
    });

    // The whole point: the non-idempotent node upstream of the failure did NOT run again.
    expect(emailCalls).toHaveLength(0);
    // …while the failed node and everything after it did.
    expect(httpCalls).toHaveLength(1);
  });

  it("carries the earlier node's output forward, so downstream reads still resolve", async () => {
    const worker = await makeWorker(env);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [
          graph,
          { orderId: 7 },
          { tenantId: "t-1" },
          {
            ctx: { email: { status: "ok", messageId: "<carried@test>" } },
            startNodeId: "http",
            costUsd: 0,
            stepCount: 0,
            reseedVars: true,
          },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-resume-ctx",
      });
      // Read ctx from the RESULT, not a query: a closed workflow can't be queried, which is the
      // same constraint that makes the durable snapshot necessary in the first place.
      const result = await handle.result();
      // The seeded output is still addressable by later nodes / expressions…
      expect(result.ctx.email).toMatchObject({ messageId: "<carried@test>" });
      // …and the nodes from the failure onward produced their own.
      expect(result.ctx.http).toBeDefined();
      expect(result.ctx.tail).toMatchObject({ done: "yes" });
    });
  });

  /**
   * `run-graph` skips loadVariables for ANY resume, which is right for continueAsNew (its carried ctx
   * already holds $vars) and wrong for this path — the snapshot may predate them, and every
   * `{{ $vars.KEY }}` downstream would then resolve to nothing. `reseedVars` opts back in.
   */
  it("re-reads $vars when reseedVars is set, and not when it isn't", async () => {
    const worker = await makeWorker(env);
    await worker.runUntil(async () => {
      const withVars = await env.client.workflow.start(runGraph, {
        args: [
          graph,
          {},
          { tenantId: "t-1" },
          {
            ctx: { email: { status: "ok" } },
            startNodeId: "http",
            costUsd: 0,
            stepCount: 0,
            reseedVars: true,
          },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-resume-vars-on",
      });
      await withVars.result();
    });
    expect(loadVariablesCalls.length).toBeGreaterThan(0);

    loadVariablesCalls.length = 0;
    const worker2 = await makeWorker(env);
    await worker2.runUntil(async () => {
      const withoutVars = await env.client.workflow.start(runGraph, {
        args: [
          graph,
          {},
          { tenantId: "t-1" },
          {
            ctx: { email: { status: "ok" } },
            startNodeId: "http",
            costUsd: 0,
            stepCount: 0,
            // No reseedVars — the continueAsNew shape.
          },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-resume-vars-off",
      });
      await withoutVars.result();
    });
    expect(loadVariablesCalls).toHaveLength(0);
  });
});
