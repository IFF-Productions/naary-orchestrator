// Items model — splitOut regions run once per item and loopEnd collects per-item outputs.
// Split out of interpreter.e2e.spec.ts (issue #496). Shared harness + fixtures
// live in ./interpreter-harness; this file owns its own TestWorkflowEnvironment.
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { createLocalTestEnv } from "./local-test-env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stateQuery } from "@naary/contracts";
import type { GraphDef } from "@naary/dsl";
import {
  getObjectStore,
  isClaimCheck,
  maybeOffload,
  resolveClaimChecks,
} from "@naary/storage";
import { runGraph } from "../src/temporal/workflows";
import { ITEM_CLAIM_CHECK_THRESHOLD } from "../src/temporal/activities/items";
import {
  TASK_QUEUE,
  mapNodeCalls,
  itemsGraph,
  makeWorker,
} from "./interpreter-harness";

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await createLocalTestEnv();
}, 60_000);

afterAll(async () => {
  await env?.teardown();
});

describe("runGraph interpreter — items model (splitOut region)", () => {
  it("runs the region once per item; loopEnd collects the per-item outputs (proves current-item)", async () => {
    const worker = await makeWorker(env);
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

  it("#477: fans out AFTER the loop — both loopEnd successors run, each fed the collected array", async () => {
    // start → sp(items) → map{doubled ← sp.n} → loopEnd(collects map) ──┬─→ branchA{picked ← le[0]}
    //                                                                    └─→ branchB{picked ← le[2]}
    // Proves loopEnd fan-out (gated by wf.patched("loop-fanout-v1")): the walk fans out over
    // loopEnd's two successors and each sees `ctx.le` (the per-item collected array), not just the first.
    const fanoutGraph: GraphDef = {
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
        {
          id: "branchA",
          type: "set",
          config: { fieldBindings: { picked: { from: "le", path: "[0]" } } },
        },
        {
          id: "branchB",
          type: "set",
          config: { fieldBindings: { picked: { from: "le", path: "[2]" } } },
        },
      ],
      edges: [
        { from: "start", to: "sp" },
        { from: "sp", to: "map" },
        { from: "map", to: "le" },
        { from: "le", to: "branchA" },
        { from: "le", to: "branchB" },
      ],
    };
    const worker = await makeWorker(env);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [
          fanoutGraph,
          { items: [{ n: 1 }, { n: 2 }, { n: 3 }] },
          { tenantId: "t-loop-fanout" },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-loop-fanout",
      });
      expect((await handle.result()).status).toBe("completed");
      const final = await handle.query(stateQuery);
      // loopEnd collected all three iterations …
      expect(final.ctx.le).toEqual([
        { doubled: 1 },
        { doubled: 2 },
        { doubled: 3 },
      ]);
      // … and BOTH downstream branches ran, each reading the collected array (not just branchA).
      expect(final.ctx.branchA).toEqual({ picked: { doubled: 1 } });
      expect(final.ctx.branchB).toEqual({ picked: { doubled: 3 } });
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
    const worker = await makeWorker(env);
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
    const worker = await makeWorker(env);
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
    const worker = await makeWorker(env);
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
    const worker = await makeWorker(env);
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
    const worker = await makeWorker(env);
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
    const worker = await makeWorker(env);
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
    const worker = await makeWorker(env);
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
    const worker = await makeWorker(env);
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
    const worker = await makeWorker(env);
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
    const worker = await makeWorker(env);
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
    const worker = await makeWorker(env);
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
    const worker = await makeWorker(env);
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
    const worker = await makeWorker(env);
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

  // ── Items claim-check offload (#479) ──────────────────────────────────────────────────────────
  // The harness registers the REAL expandItems activity (its only I/O is the in-memory object
  // store), so these run the actual workflow → activity → object-store path end to end.

  it("#479: a splitOut over a CLAIM-CHECKED source expands via the activity (was: silent 0 items)", async () => {
    const store = getObjectStore();
    // Exactly the shape an offloaded httpRequest leaves in ctx: `body` is a reference and the
    // splitOut path descends INTO it. Pre-#479 the workflow's getByPath returned undefined here and
    // the region mapped zero times — a silent wrong answer, no error anywhere.
    const bodyRef = await maybeOffload(
      { items: [{ n: 1 }, { n: 2 }, { n: 3 }] },
      store,
      { keyPrefix: "e2e", thresholdBytes: 0 }, // force the reference
    );
    const graph: GraphDef = {
      ...itemsGraph(),
      nodes: itemsGraph().nodes.map((n) =>
        n.id === "sp"
          ? {
              ...n,
              config: { from: "__input", path: "body.items" },
            }
          : n,
      ),
    };
    const worker = await makeWorker(env);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [graph, { body: bodyRef }, { tenantId: "t-items-cc" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-items-claimcheck",
      });
      expect((await handle.result()).status).toBe("completed");
      const final = await handle.query(stateQuery);
      // All three items were iterated, each region pass reading its own current item.
      expect(final.ctx.le).toEqual([
        { doubled: 1 },
        { doubled: 2 },
        { doubled: 3 },
      ]);
    });
  });

  it("#479: an INLINE array is left alone even when a SIBLING field is a reference", async () => {
    // Guard against the obvious over-reach: `containsClaimCheckRef` scans the whole node output, and a
    // node can offload one field while another holds a perfectly readable array (codeAgent's
    // `{diff: ref, trace: ref, …}` is the shipped example). Routing that through expandItems would
    // re-represent the array as per-element references and break a pure region node's `{{ sp.n }}`.
    // The `!Array.isArray(direct)` condition keeps this byte-identical to pre-#479.
    const store = getObjectStore();
    const unrelatedRef = await maybeOffload({ big: "blob" }, store, {
      keyPrefix: "e2e",
      thresholdBytes: 0,
    });
    const worker = await makeWorker(env);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [
          itemsGraph(), // splits `__input.items`
          { items: [{ n: 4 }, { n: 5 }], trace: unrelatedRef },
          { tenantId: "t-items-sibling" },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-items-sibling-ref",
      });
      expect((await handle.result()).status).toBe("completed");
      const final = await handle.query(stateQuery);
      // The pure region node still read real item values (it would see undefined off a reference).
      expect(final.ctx.le).toEqual([{ doubled: 4 }, { doubled: 5 }]);
    });
  });

  it("#479: an oversized ITEM rides as a reference, not a blob (A3 batch sees the ref)", async () => {
    const store = getObjectStore();
    // Two items well over the per-item offload threshold. Pre-#479 both would have had to ride in
    // Temporal history verbatim; now each becomes a small reference the activity boundary resolves.
    const big = "x".repeat(ITEM_CLAIM_CHECK_THRESHOLD + 1);
    const sourceRef = await maybeOffload(
      {
        items: [
          { big, i: 0 },
          { big, i: 1 },
        ],
      },
      store,
      { keyPrefix: "e2e", thresholdBytes: 0 },
    );
    // An `agent` region node makes this an A3 node-major region → ONE batched mapNode, whose echoed
    // `on` field lets us see exactly what the interpreter passed per item.
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
    const worker = await makeWorker(env);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [graph, sourceRef, { tenantId: "t-items-bigitem" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-items-bigitem",
      });
      expect((await handle.result()).status).toBe("completed");
      const collected = (await handle.query(stateQuery)).ctx.le as {
        ran: string;
        on: unknown;
      }[];
      expect(collected).toHaveLength(2);
      // THE assertion: what crossed the workflow boundary is a REFERENCE, not the payload…
      for (const out of collected) expect(isClaimCheck(out.on)).toBe(true);
      // …and it resolves back to the real item (what every activity does on entry).
      expect(await resolveClaimChecks(collected[0].on, store)).toEqual({
        big,
        i: 0,
      });
    });
  });

  it("a missing/undefined split source is treated as empty (no error)", async () => {
    const worker = await makeWorker(env);
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
    const worker = await makeWorker(env);
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
