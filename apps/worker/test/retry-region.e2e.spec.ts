// Retry regions against a REAL Temporal — does the bracket actually repeat?
//
// Everything up to here (the model, the save gate) decides whether a region is LEGAL. None of it
// proves the interpreter runs it more than once, and a region that validated perfectly but walked
// straight through would look identical in every unit test.
//
// The second test is the one that matters most. When the attempts run out, the run must fail with
// the NODE'S OWN error — `failedNodeId`, the redacted HTTP capture, `classifyFailure`, the fix
// diagnosis and self-healing's dedupe signature all key off it. A "retry exhausted" wrapper would
// blind every one of them at once, so this asserts on the cause chain rather than the top-level
// message (which passes for any failure at all).
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { createLocalTestEnv } from "./local-test-env";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { GraphDef } from "@naary/dsl";
import { runGraph } from "../src/temporal/workflows";
import {
  TASK_QUEUE,
  harnessState,
  httpCalls,
  makeWorker,
} from "./interpreter-harness";

let env: TestWorkflowEnvironment;

/** trigger → retry → fetch(http) → retryEnd → end */
function retryGraph(config?: Record<string, unknown>): GraphDef {
  return {
    startNodeId: "trigger",
    nodes: [
      { id: "trigger", type: "webhookTrigger" },
      { id: "r", type: "retry", config },
      {
        id: "fetch",
        type: "httpRequest",
        config: { method: "GET", url: "https://api.example.com/thing" },
      },
      { id: "rend", type: "retryEnd" },
      { id: "end", type: "end" },
    ],
    edges: [
      { from: "trigger", to: "r" },
      { from: "r", to: "fetch" },
      { from: "fetch", to: "rend" },
      { from: "rend", to: "end" },
    ],
  } as unknown as GraphDef;
}

/** The whole cause chain — Temporal wraps, so a top-level assertion proves nothing. */
function failureText(e: unknown): string {
  const parts: string[] = [];
  let node: unknown = e;
  for (let i = 0; i < 8 && node; i++) {
    parts.push(String((node as Error).message ?? node));
    node = (node as { cause?: unknown }).cause;
  }
  return parts.join(" <- ");
}

beforeAll(async () => {
  env = await createLocalTestEnv();
}, 120_000);

afterAll(async () => {
  await env?.teardown();
  harnessState.httpFailures = 0;
});

beforeEach(() => {
  httpCalls.length = 0;
  harnessState.httpFailures = 0;
});

describe("retry region", () => {
  it("repeats the bracket until an attempt succeeds", async () => {
    // Two failures, then success — inside the default 3 attempts.
    harnessState.httpFailures = 2;
    const worker = await makeWorker(env);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [
          retryGraph({ initialIntervalSeconds: 0 }),
          { x: 1 },
          { tenantId: "t-retry", environmentId: "e-retry" },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-retry-succeeds",
      });
      const result = await handle.result();

      expect(result.status).toBe("completed");
      // The REGION ran three times, not the node once. This is the whole feature.
      expect(httpCalls).toHaveLength(3);
      // …and the third attempt's output is what downstream sees.
      expect(result.ctx.fetch).toMatchObject({ status: 200 });
      // The attempt count is visible rather than hidden inside a long-looking step.
      expect(result.ctx.__retryAttempts).toMatchObject({ r: 3 });
    });
  }, 120_000);

  it("fails with the NODE'S OWN error when the attempts run out", async () => {
    harnessState.httpFailures = 99; // never succeeds
    const worker = await makeWorker(env);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [
          retryGraph({ maxAttempts: 2, initialIntervalSeconds: 0 }),
          { x: 1 },
          { tenantId: "t-retry", environmentId: "e-retry" },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-retry-exhausted",
      });
      const rejection = await handle.result().then(
        () => undefined,
        (e) => e,
      );

      const text = failureText(rejection);
      // The real cause survives — this is what every diagnostic downstream reads. Asserting on
      // the NODE's message ("simulated network failure", the harness's own throw) rather than a
      // generic /http/: the wrapper text says "Activity task failed" for any activity at all.
      expect(text).toContain("simulated network failure");
      // …and is NOT replaced by a statement about how many times we asked.
      expect(text).not.toMatch(/retry exhausted|out of attempts/i);
      // Exactly the configured number of attempts, not one more or fewer.
      expect(httpCalls).toHaveLength(2);
    });
  }, 120_000);

  it("HONOURS onError:'continue' inside the region instead of retrying past it", async () => {
    // `onError: "continue"` is handled by exec-chain, not execNode — so the first version, which
    // called execNode directly, silently overrode the author's instruction: a node explicitly told
    // to continue past its error instead threw and retried the WHOLE region. Review caught it.
    //
    // A node marked "continue" is one whose failure is expected and handled downstream. Retrying
    // around it is repeating work to arrive at the same place.
    harnessState.httpFailures = 99; // fetch always fails…
    const g = retryGraph({ initialIntervalSeconds: 0 });
    g.nodes = g.nodes.map((n) =>
      n.id === "fetch" ? { ...n, onError: "continue" } : n,
    ) as typeof g.nodes;

    const worker = await makeWorker(env);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [g, { x: 1 }, { tenantId: "t-retry", environmentId: "e-retry" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-retry-on-error-continue",
      });
      const result = await handle.result();

      // …and the run COMPLETES, because the author said to carry on.
      expect(result.status).toBe("completed");
      // ONE call: the region did not retry around a node whose failure was expected.
      expect(httpCalls).toHaveLength(1);
      // The error is the node's output, exactly as it would be outside a retry region.
      expect(result.ctx.fetch).toMatchObject({ error: expect.any(String) });
    });
  }, 120_000);

  it("costs nothing when the first attempt succeeds", async () => {
    // The overwhelmingly common case: a region that works must not add a call or a wait.
    const worker = await makeWorker(env);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [
          retryGraph(),
          { x: 1 },
          { tenantId: "t-retry", environmentId: "e-retry" },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-retry-first-try",
      });
      const result = await handle.result();
      expect(result.status).toBe("completed");
      expect(httpCalls).toHaveLength(1);
      // No attempt bookkeeping at all — a clean run's ctx is unchanged by this feature.
      expect(result.ctx.__retryAttempts).toBeUndefined();
    });
  }, 120_000);

  it("continues past retryEnd to the rest of the flow", async () => {
    // A region that succeeds must hand control to whatever follows the closing bracket — the
    // `end` node here, which is what makes the run COMPLETE rather than stall.
    harnessState.httpFailures = 1;
    const worker = await makeWorker(env);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [
          retryGraph({ initialIntervalSeconds: 0 }),
          { x: 1 },
          { tenantId: "t-retry", environmentId: "e-retry" },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-retry-continues",
      });
      const result = await handle.result();
      expect(result.status).toBe("completed");
      expect(result.currentNodeId).toBe("end");
    });
  }, 120_000);
});
