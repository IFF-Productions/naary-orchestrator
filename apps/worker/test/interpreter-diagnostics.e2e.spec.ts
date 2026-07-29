// Unresolved-input diagnostics, Claude Code agent provider, and Slice 2 per-node timing + failure classification.
// Split out of interpreter.e2e.spec.ts (issue #496). Shared harness + fixtures
// live in ./interpreter-harness; this file owns its own TestWorkflowEnvironment.
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { createLocalTestEnv } from "./local-test-env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stateQuery } from "@naary/contracts";
import type { GraphDef } from "@naary/dsl";
import { runGraph } from "../src/temporal/workflows";
import {
  TASK_QUEUE,
  WORKFLOWS_PATH,
  codeAgentCalls,
  statusPushes,
  stopGraph,
  approvalTimeoutGraph,
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

describe("runGraph interpreter — unresolved-input diagnostic (ctx.__unresolved)", () => {
  it("records which source produced no output; a fully-resolved run has no __unresolved key", async () => {
    const worker = await makeWorker(env);
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

describe("runGraph interpreter — per-run debug flag (ctx.__debug)", () => {
  it("sets ctx.__debug only when the run opts in (byte-identical ctx otherwise)", async () => {
    const worker = await makeWorker(env);
    await worker.runUntil(async () => {
      const graph: GraphDef = {
        startNodeId: "trigger",
        nodes: [
          { id: "trigger", type: "webhookTrigger" },
          { id: "end", type: "end" },
        ],
        edges: [{ from: "trigger", to: "end" }],
      };
      // debug:true in the run ctx → the interpreter seeds ctx.__debug so the Run Detail can show
      // its debug view without any new state-query/API field.
      const on = await env.client.workflow.start(runGraph, {
        args: [graph, {}, { tenantId: "t-dbg", debug: true }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-debug-on",
      });
      expect((await on.result()).status).toBe("completed");
      expect((await on.query(stateQuery)).ctx.__debug).toBe(true);

      // A normal run never carries __debug — its ctx stays byte-identical to pre-feature.
      const off = await env.client.workflow.start(runGraph, {
        args: [graph, {}, { tenantId: "t-dbg" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-debug-off",
      });
      expect((await off.result()).status).toBe("completed");
      expect((await off.query(stateQuery)).ctx.__debug).toBeUndefined();
    });
  });

  /**
   * Resume-from-failed-node must keep debug on: that is the moment someone turned it on FOR.
   * #924 shipped `if (runCtx.debug && !resume)` and flagged the gap itself.
   *
   * Both halves are asserted because only one of them was actually broken:
   *   (a) the snapshot ctx is the primary carrier — the failed run's ctx is stored verbatim, so
   *       `resume.ctx` brings `__debug` back in on its own (this passed before the fix too);
   *   (b) a resume whose runCtx opted in but whose snapshot ctx has no `__debug` — the half the
   *       `!resume` guard dropped on the floor.
   * The recorded history is then replayed against this code: the flag is plain ctx state, so it
   * must issue no command (CLAUDE.md Tier-1 rule 2).
   */
  it("a RESUME keeps debug — carried in the snapshot ctx, re-seeded from runCtx — and its history replays", async () => {
    const graph: GraphDef = {
      startNodeId: "trigger",
      nodes: [
        { id: "trigger", type: "webhookTrigger" },
        { id: "mid", type: "set", config: { fields: { ok: true } } },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "trigger", to: "mid" },
        { from: "mid", to: "end" },
      ],
    };
    /** The API's arg 4, seeded at the node that died. */
    const resumeState = (ctx: Record<string, unknown>) => ({
      ctx,
      startNodeId: "mid",
      costUsd: 0,
      stepCount: 0,
      reseedVars: true,
    });

    const worker = await makeWorker(env);
    const history = await worker.runUntil(async () => {
      // (a) carried: the run that failed had stamped __debug, and the snapshot kept it.
      const carried = await env.client.workflow.execute(runGraph, {
        args: [
          graph,
          {},
          { tenantId: "t-dbg" },
          resumeState({ __debug: true }),
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-debug-resume-carried",
      });
      expect(carried.status).toBe("completed");
      expect(carried.ctx.__debug).toBe(true);

      // (b) re-seeded: runCtx opted in, the snapshot ctx predates the flag.
      const handle = await env.client.workflow.start(runGraph, {
        args: [
          graph,
          {},
          { tenantId: "t-dbg", debug: true },
          resumeState({ trigger: { seen: true } }),
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-debug-resume-reseeded",
      });
      const result = await handle.result();
      expect(result.status).toBe("completed");
      expect(result.ctx.__debug).toBe(true);
      return handle.fetchHistory();
    });

    // No command was issued for the flag (a plain ctx write) — the history replays against this code.
    await expect(
      Worker.runReplayHistory(
        { workflowsPath: WORKFLOWS_PATH },
        history,
        "e2e-debug-resume-reseeded",
      ),
    ).resolves.toBeUndefined();
  });
});

describe("runGraph interpreter — Claude Code as an Agent provider", () => {
  it("routes an agent with provider 'claude-code' to the codeAgent activity (prompt = instruction + input)", async () => {
    codeAgentCalls.length = 0;
    const worker = await makeWorker(env);
    await worker.runUntil(async () => {
      const graph: GraphDef = {
        startNodeId: "trigger",
        nodes: [
          { id: "trigger", type: "webhookTrigger" },
          {
            id: "agent",
            type: "agent",
            config: {
              provider: "claude-code",
              model: "claude-opus-4-8",
              systemPrompt: "Summarize the input in one line.",
            },
          },
          { id: "end", type: "end" },
        ],
        edges: [
          { from: "trigger", to: "agent" },
          { from: "agent", to: "end" },
        ],
      };
      const handle = await env.client.workflow.start(runGraph, {
        // test:true keeps codeAgent on the DEFAULT queue (the single-queue e2e has no
        // orchestrator-heavy worker) — same as the codeAgent node's own e2e path.
        args: [graph, { msg: "hello world" }, { tenantId: "t-cc", test: true }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-agent-claude-code",
      });
      expect((await handle.result()).status).toBe("completed");
      const final = await handle.query(stateQuery);

      // The codeAgent activity ran (NOT runAgent), with the agent's instruction as the PRIMARY
      // `-p` prompt and the upstream input appended — never runAgent's system/user split.
      expect(codeAgentCalls).toHaveLength(1);
      expect(codeAgentCalls[0].tool).toBe("claude");
      expect(codeAgentCalls[0].prompt).toContain(
        "Summarize the input in one line.",
      );
      expect(codeAgentCalls[0].prompt).toContain("hello world");

      // Output is normalized to the AGENT shape so downstream `agent.output.text` keeps working.
      const out = final.ctx.agent as {
        output: { text: string };
        model: string;
        costUsd: number;
      };
      expect(out.output.text).toBe("PLAN: summarize the input");
      expect(out.model).toBe("claude-opus-4-8");
      expect(out.costUsd).toBe(0.02);
    });
  });
});

describe("runGraph interpreter — Slice 2: per-node timing + failure classification", () => {
  // webhook → agent → set → end: one trigger, one activity node, one pure node —
  // enough to prove all three get a timing entry.
  const timingGraph: GraphDef = {
    startNodeId: "wh",
    nodes: [
      { id: "wh", type: "webhookTrigger" },
      {
        id: "act",
        type: "agent",
        config: {
          provider: "anthropic",
          model: "claude-opus-4-8",
          systemPrompt: "classify",
        },
      },
      {
        id: "fmt",
        type: "set",
        config: {
          fieldBindings: { cat: { from: "act", path: "output.category" } },
        },
      },
      { id: "end", type: "end" },
    ],
    edges: [
      { from: "wh", to: "act" },
      { from: "act", to: "fmt" },
      { from: "fmt", to: "end" },
    ],
  };

  it("stamps per-node start/finish (workflow time) into ctx.__nodeTimes for pure AND activity nodes — and the history replays", async () => {
    const worker = await makeWorker(env);
    const history = await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [timingGraph, { message: "hi" }, { tenantId: "t-timing" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-node-times",
      });
      const result = await handle.result();
      expect(result.status).toBe("completed");

      const times = result.ctx.__nodeTimes as Record<
        string,
        { s: number; f: number; n?: number; totalMs?: number }
      >;
      expect(times).toBeDefined();
      // Every executed node has a window (trigger, activity, pure, end).
      for (const id of ["wh", "act", "fmt", "end"]) {
        expect(times[id], `missing timing for ${id}`).toBeDefined();
        expect(typeof times[id].s).toBe("number");
        expect(typeof times[id].f).toBe("number");
        expect(times[id].f).toBeGreaterThanOrEqual(times[id].s);
        // Single pass → no loop aggregates (map stays small).
        expect(times[id].n).toBeUndefined();
      }
      // The activity node's window spans its activity round-trip; the pure node
      // runs within the same workflow task, so act must not FINISH before it starts
      // and windows must be ordered along the chain.
      expect(times.act.s).toBeGreaterThanOrEqual(times.wh.f);
      expect(times.fmt.s).toBeGreaterThanOrEqual(times.act.f);
      return handle.fetchHistory();
    });
    // No new command was issued for the stamping (plain ctx writes reading
    // sandbox workflow time) — the recorded history replays against this code.
    await expect(
      Worker.runReplayHistory(
        { workflowsPath: WORKFLOWS_PATH },
        history,
        "e2e-node-times",
      ),
    ).resolves.toBeUndefined();
  });

  it("a re-executed node (items region) aggregates n/totalMs — last window wins, map stays bounded", async () => {
    const worker = await makeWorker(env);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [
          itemsGraph(),
          { items: [{ n: 1 }, { n: 2 }, { n: 3 }] },
          { tenantId: "t-timing-items" },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-node-times-items",
      });
      const result = await handle.result();
      expect(result.status).toBe("completed");
      const times = result.ctx.__nodeTimes as Record<
        string,
        { s: number; f: number; n?: number; totalMs?: number }
      >;
      // The region's `map` node ran once per item → aggregated pass count.
      expect(times.map.n).toBe(3);
      expect(typeof times.map.totalMs).toBe("number");
      expect(times.map.totalMs).toBeGreaterThanOrEqual(0);
    });
  });

  it("a THROWN failure pushes status 'failed' + the classified failureKind (QUOTA → rate_limit) to the read-model", async () => {
    const worker = await makeWorker(env);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [timingGraph, { message: "hi" }, { tenantId: "t-quota-fail" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-fail-quota",
      });
      // The QUOTA ApplicationFailure rides in WorkflowFailedError.cause; the
      // top-level message is the generic wrapper (same as the stopAndError test).
      await expect(handle.result()).rejects.toThrow(
        /workflow execution failed/i,
      );
    });
    const push = statusPushes.find((p) => p.workflowId === "e2e-fail-quota");
    expect(push).toMatchObject({ status: "failed", failureKind: "rate_limit" });
  });

  it("a THROWN failure stamps the FAILED node + the nodes that already ran (#525)", async () => {
    // start → pre (set, runs + writes ctx.pre) → agent (throws for t-quota-fail) → end.
    // The agent dies BEFORE writing its output, so the run-detail UI can't tell from ctx
    // that it failed here — the interpreter must stamp it.
    const failNodeGraph: GraphDef = {
      startNodeId: "s",
      nodes: [
        { id: "s", type: "start" },
        { id: "pre", type: "set", config: { fields: { ok: true } } },
        {
          id: "agent",
          type: "agent",
          config: { provider: "anthropic", model: "claude-opus-4-8" },
        },
        { id: "e", type: "end" },
      ],
      edges: [
        { from: "s", to: "pre" },
        { from: "pre", to: "agent" },
        { from: "agent", to: "e" },
      ],
    };
    const worker = await makeWorker(env);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [failNodeGraph, { hi: 1 }, { tenantId: "t-quota-fail" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-fail-node",
      });
      await expect(handle.result()).rejects.toThrow(
        /workflow execution failed/i,
      );
    });
    const push = statusPushes.find((p) => p.workflowId === "e2e-fail-node");
    // The node the run died on — the agent, NOT the last node that completed (pre).
    expect(push?.failedNodeId).toBe("agent");
    // The nodes that had already run (wrote ctx) — pre ran; the agent didn't finish.
    expect(push?.executedNodeIds).toContain("pre");
    expect(push?.executedNodeIds).not.toContain("agent");
  });

  it("attributes a fan-out failure to the THROWING branch's node, not a racing sibling (#525)", async () => {
    // s fans out to two concurrent branches: `boom` (agent, throws for t-quota-fail) and
    // `sib` (a pure set that runs + writes ctx). Both branches run under one Promise.all and
    // each sets the SHARED currentNodeId — so currentNodeId alone can't be trusted. The
    // failedNodeId captured AT the throwing node must be `boom`, never `sib`.
    const fanOutGraph: GraphDef = {
      startNodeId: "s",
      nodes: [
        { id: "s", type: "start" },
        { id: "sib", type: "set", config: { fields: { ran: true } } },
        {
          id: "boom",
          type: "agent",
          config: { provider: "anthropic", model: "claude-opus-4-8" },
        },
        { id: "e1", type: "end" },
        { id: "e2", type: "end" },
      ],
      edges: [
        { from: "s", to: "sib" },
        { from: "s", to: "boom" },
        { from: "sib", to: "e1" },
        { from: "boom", to: "e2" },
      ],
    };
    const worker = await makeWorker(env);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [fanOutGraph, { hi: 1 }, { tenantId: "t-quota-fail" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-fail-fanout",
      });
      await expect(handle.result()).rejects.toThrow(
        /workflow execution failed/i,
      );
    });
    const push = statusPushes.find((p) => p.workflowId === "e2e-fail-fanout");
    // The EXACT throwing node — the sibling `sib` must never be mis-attributed as the failure.
    expect(push?.failedNodeId).toBe("boom");
  });

  it("does NOT attribute an onError:'continue' node's swallowed error as the failure (#525)", async () => {
    // `soft` throws but is onError:"continue" → the run swallows it (ctx.soft={error}) and goes
    // on to `hard`, which throws and FAILS the run. The failure is `hard`, never the earlier
    // soft-failed node (first-writer-wins must not latch onto a non-fatal continue error).
    const continueGraph: GraphDef = {
      startNodeId: "s",
      nodes: [
        { id: "s", type: "start" },
        {
          id: "soft",
          type: "agent",
          config: { provider: "anthropic", model: "claude-opus-4-8" },
          onError: "continue",
        },
        {
          id: "hard",
          type: "agent",
          config: { provider: "anthropic", model: "claude-opus-4-8" },
        },
        { id: "e", type: "end" },
      ],
      edges: [
        { from: "s", to: "soft" },
        { from: "soft", to: "hard" },
        { from: "hard", to: "e" },
      ],
    };
    const worker = await makeWorker(env);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [continueGraph, { hi: 1 }, { tenantId: "t-quota-fail" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-fail-continue",
      });
      await expect(handle.result()).rejects.toThrow(
        /workflow execution failed/i,
      );
    });
    const push = statusPushes.find((p) => p.workflowId === "e2e-fail-continue");
    expect(push?.failedNodeId).toBe("hard");
    expect(push?.failedNodeId).not.toBe("soft");
  });

  it("stopAndError → failureKind 'error'; a returned terminal (rejected) carries NO explicit kind (the activity derives it from status)", async () => {
    const stopGraph: GraphDef = {
      startNodeId: "s",
      nodes: [
        { id: "s", type: "start" },
        {
          id: "boom",
          type: "stopAndError",
          config: { message: "deliberate stop" },
        },
        { id: "e", type: "end" },
      ],
      edges: [
        { from: "s", to: "boom" },
        { from: "boom", to: "e" },
      ],
    };
    const worker = await makeWorker(env);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [stopGraph, {}, { tenantId: "t-stop-kind" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-fail-stop",
      });
      await expect(handle.result()).rejects.toThrow(
        /workflow execution failed/i,
      );

      // Returned-terminal path: an approval auto-reject ends via syncStatus with
      // status only — the failureKind derivation happens IN the activity.
      const rejHandle = await env.client.workflow.start(runGraph, {
        args: [approvalTimeoutGraph, {}, { tenantId: "t-rej-kind" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-fail-rejected",
      });
      const rej = await rejHandle.result();
      expect(rej.status).toBe("rejected");
    });
    expect(
      statusPushes.find((p) => p.workflowId === "e2e-fail-stop"),
    ).toMatchObject({ status: "failed", failureKind: "error" });
    const rejPushes = statusPushes.filter(
      (p) => p.workflowId === "e2e-fail-rejected",
    );
    const rejPush = rejPushes[rejPushes.length - 1];
    expect(rejPush).toMatchObject({ status: "rejected" });
    expect(rejPush?.failureKind).toBeUndefined();
  });

  it("testNode metering: a test-mode run records __nodeTimes + real __costUsd, and never touches the Runs read-model", async () => {
    const testGraph: GraphDef = {
      startNodeId: "act",
      nodes: [
        {
          id: "act",
          type: "agent",
          config: {
            provider: "anthropic",
            model: "claude-opus-4-8",
            systemPrompt: "test one node",
          },
        },
        { id: "__snx_end", type: "end" },
      ],
      edges: [{ from: "act", to: "__snx_end" }],
    };
    const before = statusPushes.length;
    const worker = await makeWorker(env);
    await worker.runUntil(async () => {
      const result = await env.client.workflow.execute(runGraph, {
        args: [
          testGraph,
          {},
          {
            tenantId: "t-single-test",
            test: true,
            seededCtx: { __input: { message: "probe" } },
          },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-testnode-meter",
      });
      expect(result.status).toBe("completed");
      const times = result.ctx.__nodeTimes as Record<
        string,
        { s: number; f: number }
      >;
      // The API's testNode surface reads exactly these: the node's own window →
      // durationMs, and the run's metered spend → costUsd (fail-safe billed by
      // the activity — the mock returns the ledgered cost like the real one).
      expect(times.act).toBeDefined();
      expect(times.act.f).toBeGreaterThanOrEqual(times.act.s);
      expect(result.ctx.__costUsd).toBe(0.01);
    });
    // test-mode: no Execution read-model writes at all.
    expect(statusPushes.length).toBe(before);
  });
});
