// Per-node behavior: filter/forEach/pollTrigger/rss/respond/code/error-handler/compare/xml nodes.
// Split out of interpreter.e2e.spec.ts (issue #496). Shared harness + fixtures
// live in ./interpreter-harness; this file owns its own TestWorkflowEnvironment.
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { createLocalTestEnv } from "./local-test-env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { webhookResponseQuery } from "@naary/contracts";
import { sampleGraph } from "@naary/dsl";
import type { GraphDef } from "@naary/dsl";
import { getObjectStore, maybeOffload } from "@naary/storage";
import { runGraph } from "../src/temporal/workflows";
import {
  TASK_QUEUE,
  WORKFLOWS_PATH,
  agentCalls,
  pollCalls,
  codeCalls,
  xmlCalls,
  rssCalls,
  subResolveCalls,
  harnessState,
  pollGraph,
  setGraph,
  throwGraph,
  danglingGraph,
  arrayGraph,
  rssGraph,
  respondGraph,
  codeGraph,
  compareGraph,
  xmlGraph,
  forEachGraph,
  makeWorker,
} from "./interpreter-harness";

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await createLocalTestEnv();
}, 60_000);

afterAll(async () => {
  await env?.teardown();
});

describe("runGraph interpreter — per-node behavior: flow control, loops, feeds & error handlers", () => {
  it("filter + aggregate: subset an array then collapse it (pure, arrays as values)", async () => {
    const worker = await makeWorker(env);
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
    const worker = await makeWorker(env);
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

  it("#479: forEach over a CLAIM-CHECKED source expands via the activity (was: 0 children)", async () => {
    // Same gap as the splitOut region: a large upstream array is offloaded, so ctx holds a
    // `{__claimCheck}` reference and the workflow's getByPath silently yielded undefined → zero
    // children fanned out, with no error. containsClaimCheckRef + expandItems now expand it.
    const store = getObjectStore();
    const bodyRef = await maybeOffload({ items: [{ n: 7 }, { n: 8 }] }, store, {
      keyPrefix: "e2e",
      thresholdBytes: 0, // force the reference regardless of size
    });
    const worker = await makeWorker(env);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [
          forEachGraph("body.items"),
          { body: bodyRef },
          { tenantId: "t-foreach-cc" },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-foreach-claimcheck",
      });
      const result = await handle.result();
      expect(result.status).toBe("completed");
      const loop = result.ctx.loop as {
        status: string;
        output: Record<string, unknown>;
      }[];
      // One child per REAL item, each fed its own item — not zero children.
      expect(loop).toHaveLength(2);
      expect(loop.map((r) => r.output.trigger)).toEqual([{ n: 7 }, { n: 8 }]);
    });
  });

  it("forEach: empty/non-array source → [] (no children)", async () => {
    const worker = await makeWorker(env);
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
    const worker = await makeWorker(env);
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
    const worker = await makeWorker(env);
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
    const worker = await makeWorker(env);
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
    harnessState.pollChanged = true;
    const worker = await makeWorker(env);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [
          pollGraph,
          {},
          {
            tenantId: "t-poll",
            environmentId: "env-poll",
            workflowKey: "poller",
          },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-poll-changed",
      });
      const result = await handle.result();
      expect(result.status).toBe("completed");
      expect(result.ctx.poll).toEqual({ changed: true, body: { v: 1 } });
      // the "changed" branch reached the agent
      expect(agentCalls.some((m) => m.nodeId === "act")).toBe(true);
      // the activity got the cross-run cursor key (tenant + ENV + workflowKey + node) —
      // env-scoped schedules: the run's env reaches the poll cursor
      expect(pollCalls[pollCalls.length - 1]).toMatchObject({
        tenantId: "t-poll",
        environmentId: "env-poll",
        workflowKey: "poller",
        nodeId: "poll",
      });
    });
  });

  it("pollTrigger: UNCHANGED short-circuits to end (downstream skipped)", async () => {
    harnessState.pollChanged = false;
    const before = agentCalls.length;
    const worker = await makeWorker(env);
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
    const worker = await makeWorker(env);
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
    const worker = await makeWorker(env);
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
    const worker = await makeWorker(env);
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
    const worker = await makeWorker(env);
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
    const worker = await makeWorker(env);
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
    const worker = await makeWorker(env);
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
    const worker = await makeWorker(env);
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
    const worker = await makeWorker(env);
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
    const worker = await makeWorker(env);
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
    const worker = await makeWorker(env);
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
