/**
 * Durability proof suite — FAULT INJECTION (issue #577), plus the continueAsNew-boundary
 * guarantees added by issue #681.
 *
 * The existing e2e specs prove the HAPPY durable paths (pause → signal → resume, durable timers,
 * history replay). What they do not do is take the worker away mid-run. Every scenario here removes
 * the worker (or crosses a continueAsNew boundary) at a point where a non-durable engine would lose
 * state, and then asserts the run still finishes with the right answer and the right BILL.
 *
 * HONEST SCOPE — what "worker killed" means here. TestWorkflowEnvironment runs the worker in this OS
 * process, so a scenario shuts the worker down (`worker.runUntil` resolves → the worker stops polling
 * and drops its in-memory workflow state) and then starts a SECOND worker that must rebuild the run
 * purely by replaying history from the server. That is exactly the recovery path a SIGKILL/redeploy
 * takes, but it is NOT an OS-level kill: no signal handling, no partially-flushed sockets, and the
 * server is in-process rather than a separate cluster. The multi-process kill is covered by the manual
 * runbook, not by this suite.
 *
 * Every scenario also re-runs its history through `Worker.runReplayHistory` — the authoritative
 * determinism guard (CLAUDE.md Tier-1 rule 2).
 *
 * Scenario → guarantee → evidence is tabulated in docs/DURABILITY-PROOF.md; keep the test names in
 * sync with that table.
 */
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approvalSignal,
  resumeSignal,
  stateQuery,
  webhookResponseQuery,
} from "@naary/contracts";
import type { GraphDef } from "@naary/dsl";
import {
  MemoryObjectStore,
  __setObjectStore,
  isClaimCheck,
  resolveClaimChecks,
} from "@naary/storage";
import { runGraph } from "../src/temporal/workflows";
import { createLocalTestEnv } from "./local-test-env";
import {
  TASK_QUEUE,
  WORKFLOWS_PATH,
  agentCalls,
  harnessState,
  makeWorker,
  statusPushes,
  waitFor,
} from "./interpreter-harness";

let env: TestWorkflowEnvironment;
/** The claim-check store the offloadCtxEntry activity writes to (shared, in-process). */
let store: MemoryObjectStore;

beforeAll(async () => {
  env = await createLocalTestEnv();
  store = new MemoryObjectStore();
  __setObjectStore(store);
}, 60_000);

afterAll(async () => {
  await env?.teardown();
  __setObjectStore(undefined);
});

/** How many times the (mocked) agent activity actually EXECUTED for a tenant — the billing probe:
 *  a replayed activity is read from history and must not run (or charge) a second time. */
function agentRuns(tenantId: string): number {
  return agentCalls.filter((c) => c.tenantId === tenantId).length;
}

/** Terminal read-model pushes for a run (what the Runs list / ledger row would show). */
function pushesFor(workflowId: string) {
  return statusPushes.filter((p) => p.workflowId === workflowId);
}

/** Exactly what `WorkflowHandle.fetchHistory()` resolves to, so a segment can be handed straight to
 *  `Worker.runReplayHistory` without a cast. */
type WorkflowClient = TestWorkflowEnvironment["client"]["workflow"];
type History = Awaited<
  ReturnType<ReturnType<WorkflowClient["getHandle"]>["fetchHistory"]>
>;
/** One decoded history event — the proto shapes below are read via `as unknown as` narrow views. */
type Ev = NonNullable<History["events"]>[number];

/**
 * The runId this segment continued as new INTO, or undefined if it did not continue.
 * (Decoded protobuf messages carry absent fields as `null`, not `undefined` — hence the loose check.)
 */
function nextRunId(history: History): string | undefined {
  for (const e of history.events ?? []) {
    const can = (
      e as unknown as {
        workflowExecutionContinuedAsNewEventAttributes?: {
          newExecutionRunId?: string | null;
        } | null;
      }
    ).workflowExecutionContinuedAsNewEventAttributes;
    if (can?.newExecutionRunId) return can.newExecutionRunId;
  }
  return undefined;
}

/**
 * Every SEGMENT of a run, walked along the continueAsNew chain from the first run id.
 *
 * A handle's `fetchHistory()` resolves to the LATEST run, so it cannot see what the earlier segments
 * did — and for these tests the interesting commands (the offload, the patch markers, the boundary
 * itself) live in the FIRST segment. `segments.length > 1` is also the only honest proof that a
 * boundary was really crossed.
 */
async function fetchSegments(
  client: TestWorkflowEnvironment["client"],
  workflowId: string,
  firstRunId: string,
): Promise<History[]> {
  const segments: History[] = [];
  let runId: string | undefined = firstRunId;
  while (runId !== undefined) {
    const history: History = await client.workflow
      .getHandle(workflowId, runId)
      .fetchHistory();
    segments.push(history);
    runId = nextRunId(history);
  }
  return segments;
}

/** Replay EVERY segment of a run against the current interpreter — the determinism guard. */
async function replayAll(segments: History[]): Promise<void> {
  for (const history of segments) {
    await Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history);
  }
}

/**
 * The `wf.patched()` ids a history actually recorded (decoded from its `core_patch` markers). This is
 * how the specs assert the #681 gates are reached ONLY on the paths that need them — a marker in an
 * ordinary run's history would mean the common path changed shape, the one thing that could break an
 * in-flight run's replay.
 */
function patchIds(segments: History[]): string[] {
  const ids: string[] = [];
  for (const e of segments.flatMap((h): Ev[] => h.events ?? [])) {
    const attrs = (
      e as unknown as {
        markerRecordedEventAttributes?: {
          markerName?: string;
          details?: Record<
            string,
            { payloads?: { data?: string | Uint8Array }[] }
          > | null;
        } | null;
      }
    ).markerRecordedEventAttributes;
    if (attrs?.markerName !== "core_patch") continue;
    // The SDK records the patch under a `patch-data` detail whose payload is
    // `{"id":"<patch id>","deprecated":false}` (JSON, base64 in the fetched history).
    for (const entry of Object.values(attrs.details ?? {})) {
      for (const p of entry.payloads ?? []) {
        if (p.data === undefined) continue;
        const raw =
          typeof p.data === "string"
            ? Buffer.from(p.data, "base64").toString("utf8")
            : Buffer.from(p.data).toString("utf8");
        try {
          const parsed = JSON.parse(raw) as { id?: unknown };
          if (typeof parsed.id === "string") ids.push(parsed.id);
        } catch {
          /* not a patch payload */
        }
      }
    }
  }
  return ids;
}

/** Activity type names scheduled across a run's segments — also used to assert an ABSENCE. */
function scheduledActivities(segments: History[]): string[] {
  return segments
    .flatMap((h): Ev[] => h.events ?? [])
    .map(
      (e) =>
        (
          e as unknown as {
            activityTaskScheduledEventAttributes?: {
              activityType?: { name?: string };
            };
          }
        ).activityTaskScheduledEventAttributes?.activityType?.name,
    )
    .filter((n): n is string => typeof n === "string");
}

/** start → agent(cost 0.01) → humanApproval → end. The agent runs BEFORE the pause, so the
 *  worker-kill lands after a billed activity completed. */
const approveAfterAgentGraph: GraphDef = {
  startNodeId: "s",
  nodes: [
    { id: "s", type: "start" },
    {
      id: "agent",
      type: "agent",
      config: {
        provider: "anthropic",
        model: "claude-opus-4-8",
        systemPrompt: "classify",
      },
    },
    { id: "appr", type: "humanApproval", config: { title: "Ship it?" } },
    { id: "e", type: "end" },
  ],
  edges: [
    { from: "s", to: "agent" },
    { from: "agent", to: "appr" },
    { from: "appr", to: "e" },
  ],
};

describe("chaos: worker loss around a durable human approval", () => {
  it("worker KILLED mid-humanApproval wait, signal delivered with NO worker running, second worker resumes to completed", async () => {
    const workflowId = "chaos-kill-approval";
    const tenantId = "t-chaos-kill";
    const worker1 = await makeWorker(env);
    const handle = await env.client.workflow.start(runGraph, {
      args: [approveAfterAgentGraph, { message: "x" }, { tenantId }],
      taskQueue: TASK_QUEUE,
      workflowId,
    });

    // Worker 1 drives the run to the durable pause, then STOPS (all in-memory run state gone).
    await worker1.runUntil(
      waitFor(
        async () =>
          (await handle.query(stateQuery)).status === "awaiting_approval",
      ),
    );
    expect(agentRuns(tenantId)).toBe(1);

    // The decision arrives while ZERO workers exist: Temporal — not the worker — holds it. A
    // queue/worker-memory design loses this signal; a durable-execution engine buffers it.
    await handle.signal(approvalSignal, {
      approved: true,
      comment: "approved while the fleet was down",
    });

    // A FRESH worker rebuilds the run from history alone and finishes it.
    const worker2 = await makeWorker(env);
    const result = await worker2.runUntil(handle.result());
    expect(result.status).toBe("completed");
    expect(result.ctx.appr).toEqual({
      approved: true,
      comment: "approved while the fleet was down",
    });

    // BILLING (Tier-1 rule 6): the agent activity completed before the kill, so its result came from
    // history on replay — it must not have run, or charged, twice. Exactly one charge, non-zero.
    expect(agentRuns(tenantId)).toBe(1);
    const pushes = pushesFor(workflowId);
    const terminal = pushes[pushes.length - 1];
    expect(terminal?.status).toBe("completed");
    expect(terminal?.costUsd).toBe(0.01);

    const history = await handle.fetchHistory();
    await expect(
      Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history),
    ).resolves.toBeUndefined();
  });

  it("crash AFTER a billed activity completed but BEFORE the run finished: replay re-reads the result, so no double-charge and no zero-charge", async () => {
    // Same fault, isolated on the billing invariant: kill the worker in the window between the agent
    // activity's completion and the run's terminal read-model write, twice over.
    const workflowId = "chaos-billing-window";
    const tenantId = "t-chaos-billing";
    const handle = await env.client.workflow.start(runGraph, {
      args: [approveAfterAgentGraph, { message: "x" }, { tenantId }],
      taskQueue: TASK_QUEUE,
      workflowId,
    });

    // Kill #1: as soon as the billed activity has completed (the run is parked just past it).
    const worker1 = await makeWorker(env);
    await worker1.runUntil(
      waitFor(
        async () =>
          agentRuns(tenantId) === 1 &&
          (await handle.query(stateQuery)).status === "awaiting_approval",
      ),
    );
    // Kill #2: a second worker picks the run up, replays, and is taken away again before any
    // decision — proving the replay itself never re-executes the billed activity.
    const worker2 = await makeWorker(env);
    await worker2.runUntil(
      waitFor(
        async () =>
          (await handle.query(stateQuery)).status === "awaiting_approval",
      ),
    );
    expect(agentRuns(tenantId)).toBe(1);

    await handle.signal(approvalSignal, { approved: true });
    const worker3 = await makeWorker(env);
    const result = await worker3.runUntil(handle.result());

    expect(result.status).toBe("completed");
    // The invariant: one execution, one charge — never two (double-charge), never 0 (silently free).
    expect(agentRuns(tenantId)).toBe(1);
    expect(result.ctx.agent).toMatchObject({ status: "ok" });
    const costs = pushesFor(workflowId).map((p) => p.costUsd);
    expect(costs[costs.length - 1]).toBe(0.01);
    expect(costs.every((c) => c === 0.01 || c === 0)).toBe(true); // never 0.02
  });
});

describe("chaos: continueAsNew boundary (#681)", () => {
  it("a wait-webhook RESUME signal pending at the boundary is CARRIED across continueAsNew, not dropped", async () => {
    // start → appr(hold point) → s1 → wait(mode:webhook) → end, forced to continueAsNew every 2
    // steps. The resume Signal is delivered while the run is provably PARKED at the approval gate —
    // so it sits un-consumed in engine state when the boundary is reached. Before #681 the snapshot
    // dropped it and the run then waited at the webhook gate forever (this test would time out).
    const graph: GraphDef = {
      startNodeId: "s",
      nodes: [
        { id: "s", type: "start" },
        { id: "appr", type: "humanApproval", config: { title: "hold" } },
        { id: "mid", type: "set", config: { fields: { k: 1 } } },
        { id: "w", type: "wait", config: { mode: "webhook" } },
        { id: "e", type: "end" },
      ],
      edges: [
        { from: "s", to: "appr" },
        { from: "appr", to: "mid" },
        { from: "mid", to: "w" },
        { from: "w", to: "e" },
      ],
    };
    const workflowId = "chaos-can-resume-signal";
    const worker = await makeWorker(env);
    const segments = await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [
          graph,
          {},
          {
            tenantId: "t-can-resume",
            maxStepsPerRun: 50,
            continueAsNewAfterSteps: 2,
          },
        ],
        taskQueue: TASK_QUEUE,
        workflowId,
      });
      await waitFor(
        async () =>
          (await handle.query(stateQuery)).status === "awaiting_approval",
      );
      // Parked: nothing can consume a resumeSignal yet, so this one is guaranteed to be PENDING
      // when the walk hits the next continueAsNew boundary.
      await handle.signal(resumeSignal, { payload: { from: "stripe" } });
      await handle.signal(approvalSignal, { approved: true });
      const result = await handle.result();
      expect(result.status).toBe("completed");
      // The gate consumed the carried signal (and its payload), rather than waiting forever.
      expect(result.ctx.w).toEqual({
        resumed: true,
        timedOut: false,
        payload: { from: "stripe" },
      });
      return fetchSegments(env.client, workflowId, handle.firstExecutionRunId);
    });
    // …and a boundary really was crossed in between (otherwise the carry proves nothing).
    expect(segments.length).toBeGreaterThan(1);
    await replayAll(segments);
  });

  it("an APPROVAL signal pending at the boundary no longer BLOCKS continueAsNew and survives it (patched: can-carry-signals-v1)", async () => {
    // Mirror image: park at a wait-webhook gate, deliver the APPROVAL early (nothing consumes it
    // there), then resume. The boundary is now reached WITH a pending approval — the exact case the
    // old code refused to continue on (unbounded history) — and the downstream gate must find it.
    const graph: GraphDef = {
      startNodeId: "s",
      nodes: [
        { id: "s", type: "start" },
        { id: "w", type: "wait", config: { mode: "webhook" } },
        { id: "mid", type: "set", config: { fields: { k: 1 } } },
        { id: "appr", type: "humanApproval", config: { title: "later" } },
        { id: "e", type: "end" },
      ],
      edges: [
        { from: "s", to: "w" },
        { from: "w", to: "mid" },
        { from: "mid", to: "appr" },
        { from: "appr", to: "e" },
      ],
    };
    const workflowId = "chaos-can-approval-signal";
    const worker = await makeWorker(env);
    const segments = await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [
          graph,
          {},
          {
            tenantId: "t-can-approval",
            maxStepsPerRun: 50,
            continueAsNewAfterSteps: 2,
          },
        ],
        taskQueue: TASK_QUEUE,
        workflowId,
      });
      await waitFor(
        async () =>
          (await handle.query(stateQuery)).status === "awaiting_webhook",
      );
      await handle.signal(approvalSignal, {
        approved: true,
        comment: "decided early",
      });
      await handle.signal(resumeSignal, { payload: null });
      const result = await handle.result();
      expect(result.status).toBe("completed");
      expect(result.ctx.appr).toEqual({
        approved: true,
        comment: "decided early",
      });
      return fetchSegments(env.client, workflowId, handle.firstExecutionRunId);
    });
    expect(segments.length).toBeGreaterThan(1);
    // The gate that unblocked this boundary was actually taken.
    expect(patchIds(segments)).toContain("can-carry-signals-v1");
    await replayAll(segments);
  });

  it("a respondToWebhook reply produced BEFORE the boundary is still readable after it (the ingress polls the latest run)", async () => {
    const graph: GraphDef = {
      startNodeId: "s",
      nodes: [
        { id: "s", type: "start" },
        {
          id: "reply",
          type: "respondToWebhook",
          config: { statusCode: 202, body: { queued: true } },
        },
        { id: "mid", type: "set", config: { fields: { k: 1 } } },
        { id: "e", type: "end" },
      ],
      edges: [
        { from: "s", to: "reply" },
        { from: "reply", to: "mid" },
        { from: "mid", to: "e" },
      ],
    };
    const workflowId = "chaos-can-reply";
    const worker = await makeWorker(env);
    const segments = await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [
          graph,
          {},
          {
            tenantId: "t-can-reply",
            maxStepsPerRun: 50,
            continueAsNewAfterSteps: 2,
          },
        ],
        taskQueue: TASK_QUEUE,
        workflowId,
      });
      const result = await handle.result();
      expect(result.status).toBe("completed");
      // Both surfaces the ingress/chat-session use survive the boundary.
      expect(result.reply).toEqual({ queued: true });
      expect(await handle.query(webhookResponseQuery)).toMatchObject({
        statusCode: 202,
        body: { queued: true },
      });
      return fetchSegments(env.client, workflowId, handle.firstExecutionRunId);
    });
    expect(segments.length).toBeGreaterThan(1);
    await replayAll(segments);
  });

  it("an OVERSIZED ctx is claim-checked at the boundary (patched: can-claim-check-v1) so the snapshot stays under the ~2MB payload cap", async () => {
    // Two http nodes whose bodies are ~700KB each ⇒ ctx ≈ 1.4MB, past CAN_CTX_BUDGET_BYTES. The
    // interpreter offloads the largest entries (largest-first, minimum count) via the real
    // offloadCtxEntry activity and carries REFERENCES; without that the continueAsNew payload grows
    // toward Temporal's hard cap and wedges an otherwise-healthy long run.
    const big = "x".repeat(700_000);
    const previousResponse = harnessState.httpResponse;
    harnessState.httpResponse = {
      status: "ok",
      httpStatus: 200,
      headers: {},
      body: { blob: big },
      costUsd: 0,
    };
    const graph: GraphDef = {
      startNodeId: "s",
      nodes: [
        { id: "s", type: "start" },
        {
          id: "h1",
          type: "httpRequest",
          config: { method: "GET", url: "https://api.example.com/1" },
        },
        {
          id: "h2",
          type: "httpRequest",
          config: { method: "GET", url: "https://api.example.com/2" },
        },
        { id: "tail", type: "set", config: { fields: { done: true } } },
        { id: "e", type: "end" },
      ],
      edges: [
        { from: "s", to: "h1" },
        { from: "h1", to: "h2" },
        { from: "h2", to: "tail" },
        { from: "tail", to: "e" },
      ],
    };
    const workflowId = "chaos-can-claim-check";
    try {
      const worker = await makeWorker(env);
      const segments = await worker.runUntil(async () => {
        const handle = await env.client.workflow.start(runGraph, {
          args: [
            graph,
            {},
            {
              tenantId: "t-can-offload",
              maxStepsPerRun: 50,
              continueAsNewAfterSteps: 3, // boundary lands right after h2
            },
          ],
          taskQueue: TASK_QUEUE,
          workflowId,
        });
        const result = await handle.result();
        expect(result.status).toBe("completed");

        // The visible marker names which node outputs became references (ids only, never content).
        expect(result.ctx.__offloaded).toEqual(["h1"]);
        // …and that entry IS a reference, small in the payload but still resolvable at the next
        // activity boundary (exactly the items-model contract).
        const offloaded = result.ctx.h1;
        expect(isClaimCheck(offloaded)).toBe(true);
        expect(await resolveClaimChecks(offloaded, store)).toMatchObject({
          status: 200,
          body: { blob: big },
        });
        // The offload is the MINIMUM that fits the budget: h2 stayed inline, readable in workflow
        // code (so expressions/edge conditions on the most recent output keep working).
        expect(isClaimCheck(result.ctx.h2)).toBe(false);
        return fetchSegments(
          env.client,
          workflowId,
          handle.firstExecutionRunId,
        );
      });
      expect(segments.length).toBeGreaterThan(1);
      expect(scheduledActivities(segments)).toContain("offloadCtxEntry");
      expect(patchIds(segments)).toContain("can-claim-check-v1");
      await replayAll(segments);
    } finally {
      harnessState.httpResponse = previousResponse;
    }
  });

  it("REPLAY INVARIANT: an ordinary small-ctx run crosses the boundary with NO new commands (no offloadCtxEntry, no patch marker) and its history replays", async () => {
    // The load-bearing guard for both patched() gates: the common path must be byte-identical to the
    // pre-#681 interpreter, so an in-flight run deployed onto this code cannot diverge on replay.
    const graph: GraphDef = {
      startNodeId: "s",
      nodes: [
        { id: "s", type: "start" },
        { id: "a", type: "set", config: { fields: { a: 1 } } },
        { id: "b", type: "set", config: { fields: { b: 2 } } },
        { id: "e", type: "end" },
      ],
      edges: [
        { from: "s", to: "a" },
        { from: "a", to: "b" },
        { from: "b", to: "e" },
      ],
    };
    const workflowId = "chaos-can-clean";
    const worker = await makeWorker(env);
    const segments = await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [
          graph,
          {},
          {
            tenantId: "t-can-clean",
            maxStepsPerRun: 50,
            continueAsNewAfterSteps: 2,
          },
        ],
        taskQueue: TASK_QUEUE,
        workflowId,
      });
      expect((await handle.result()).status).toBe("completed");
      return fetchSegments(env.client, workflowId, handle.firstExecutionRunId);
    });
    expect(segments.length).toBeGreaterThan(1);
    expect(scheduledActivities(segments)).not.toContain("offloadCtxEntry");
    // NEITHER #681 gate is reached on an ordinary boundary — the ctx is small and no signal is
    // pending, so both conditions short-circuit BEFORE patched() (the load-bearing operand order in
    // exec-chain.ts). A pre-#681 history therefore replays against this interpreter unchanged.
    const ids = patchIds(segments);
    expect(ids).not.toContain("can-carry-signals-v1");
    expect(ids).not.toContain("can-claim-check-v1");
    await replayAll(segments);
  });
});

/**
 * A month-long wait, proven with Temporal's TIME-SKIPPING test server: the workflow's own clock
 * advances 30 days while the test takes milliseconds. This is the only place the suite uses a
 * different environment (the rest use createLocal, see local-test-env.ts).
 */
describe("chaos: a 30-day durable wait (time-skipped)", () => {
  let skipEnv: TestWorkflowEnvironment;

  beforeAll(async () => {
    skipEnv = await TestWorkflowEnvironment.createTimeSkipping();
  }, 120_000);

  afterAll(async () => {
    await skipEnv?.teardown();
  });

  it("a 30-DAY wait node resumes and completes with the pre-wait spend intact (budget/ledger not reset)", async () => {
    const THIRTY_DAYS_S = 30 * 24 * 60 * 60;
    const graph: GraphDef = {
      startNodeId: "s",
      nodes: [
        { id: "s", type: "start" },
        {
          id: "agent",
          type: "agent",
          config: {
            provider: "anthropic",
            model: "claude-opus-4-8",
            systemPrompt: "spend before the wait",
          },
        },
        {
          id: "hold",
          type: "wait",
          config: { durationSeconds: THIRTY_DAYS_S },
        },
        { id: "e", type: "end" },
      ],
      edges: [
        { from: "s", to: "agent" },
        { from: "agent", to: "hold" },
        { from: "hold", to: "e" },
      ],
    };
    const workflowId = "chaos-30-day-wait";
    const worker = await makeWorker(skipEnv);
    const history = await worker.runUntil(async () => {
      const handle = await skipEnv.client.workflow.start(runGraph, {
        args: [graph, {}, { tenantId: "t-30-day", perExecutionCapUsd: 1 }],
        taskQueue: TASK_QUEUE,
        workflowId,
      });
      const result = await handle.result();
      expect(result.status).toBe("completed");
      // Spend accrued BEFORE the month-long pause is still the run's spend after it.
      expect(result.ctx.__costUsd).toBe(0.01);
      const pushes = pushesFor(workflowId);
    const terminal = pushes[pushes.length - 1];
      expect(terminal?.status).toBe("completed");
      expect(terminal?.costUsd).toBe(0.01);
      return handle.fetchHistory();
    });
    // Prove the wait really was 30 days of workflow time, not a scaled-down stand-in.
    const timers = (history.events ?? []).flatMap((e) => {
      const t = (
        e as {
          timerStartedEventAttributes?: {
            startToFireTimeout?: { seconds?: string | number };
          };
        }
      ).timerStartedEventAttributes;
      return t?.startToFireTimeout?.seconds === undefined
        ? []
        : [Number(t.startToFireTimeout.seconds)];
    });
    expect(timers).toContain(THIRTY_DAYS_S);
    await expect(
      Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history),
    ).resolves.toBeUndefined();
  });

  it("a 30-day approval SLA reminder fires on its durable timer, and the gate is still decidable afterwards", async () => {
    const graph: GraphDef = {
      startNodeId: "s",
      nodes: [
        { id: "s", type: "start" },
        {
          id: "appr",
          type: "humanApproval",
          // A reminder 30 days in, and no timeoutHours — so after the reminder the gate waits
          // indefinitely for a human (no further timer for the test server to skip to).
          config: { title: "Quarterly sign-off", remindAfterHours: [720] },
        },
        { id: "e", type: "end" },
      ],
      edges: [
        { from: "s", to: "appr" },
        { from: "appr", to: "e" },
      ],
    };
    const workflowId = "chaos-30-day-approval";
    const worker = await makeWorker(skipEnv);
    const history = await worker.runUntil(async () => {
      const handle = await skipEnv.client.workflow.start(runGraph, {
        args: [graph, {}, { tenantId: "t-30-day-appr" }],
        taskQueue: TASK_QUEUE,
        workflowId,
      });
      await waitFor(
        async () =>
          (await handle.query(stateQuery)).status === "awaiting_approval",
      );
      await handle.signal(approvalSignal, { approved: true, comment: "ok" });
      expect((await handle.result()).status).toBe("completed");
      return handle.fetchHistory();
    });
    const timers = (history.events ?? []).flatMap((e) => {
      const t = (
        e as {
          timerStartedEventAttributes?: {
            startToFireTimeout?: { seconds?: string | number };
          };
        }
      ).timerStartedEventAttributes;
      return t?.startToFireTimeout?.seconds === undefined
        ? []
        : [Number(t.startToFireTimeout.seconds)];
    });
    // The reminder was scheduled as a real 30-day (720h) durable timer.
    expect(timers).toContain(720 * 3600);
    await expect(
      Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history),
    ).resolves.toBeUndefined();
  });
});
