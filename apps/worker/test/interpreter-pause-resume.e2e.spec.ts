// Durable pause to signal to resume (human approval + budget pause-not-fail).
// Split out of interpreter.e2e.spec.ts (issue #496). Shared harness + fixtures
// live in ./interpreter-harness; this file owns its own TestWorkflowEnvironment.
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { createLocalTestEnv } from "./local-test-env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approvalSignal,
  budgetResumeSignal,
  stateQuery,
} from "@naary/contracts";
import { sampleGraph } from "@naary/dsl";
import type { GraphDef } from "@naary/dsl";
import { runGraph } from "../src/temporal/workflows";
import {
  TASK_QUEUE,
  WORKFLOWS_PATH,
  agentCalls,
  statusPushes,
  refreshBudgetCalls,
  notifyCalls,
  prepareApprovalCalls,
  harnessState,
  approvalTimeoutGraph,
  waitFor,
  makeWorker,
} from "./interpreter-harness";

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await createLocalTestEnv();
}, 60_000);

afterAll(async () => {
  await env?.teardown();
});

describe("runGraph interpreter — durable pause → signal → resume", () => {
  it("pauses at humanApproval, then resumes to completed on approval", async () => {
    const worker = await makeWorker(env);
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
    const worker = await makeWorker(env);
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

  it("Slice 1: a ROUTED gate snapshots contextFields/approvers/SLA into ctx.__approval at pause, and clears it on decision", async () => {
    // webhookTrigger → humanApproval(with Slice-1 fields) → end. The contextFields
    // expressions reference the trigger's output — resolvable only from the run ctx
    // AT PAUSE TIME, in the activity.
    const routedGraph: GraphDef = {
      startNodeId: "trigger",
      nodes: [
        { id: "trigger", type: "webhookTrigger" },
        {
          id: "appr",
          type: "humanApproval",
          config: {
            title: "Approve the deal?",
            slaHours: 48,
            approvers: {
              emails: ["sam@acme.io"],
              groupIds: ["g-finance"],
            },
            contextFields: {
              Company: "{{ trigger.company }}",
              Amount: "{{ trigger.amount }}",
            },
          },
        },
        { id: "e", type: "end" },
      ],
      edges: [
        { from: "trigger", to: "appr" },
        { from: "appr", to: "e" },
      ],
    };
    const worker = await makeWorker(env);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [
          routedGraph,
          { company: "Acme", amount: 1200 },
          { tenantId: "t-routed" },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-approve-routed",
      });
      await waitFor(
        async () =>
          (await handle.query(stateQuery)).status === "awaiting_approval",
      );
      const paused = await handle.query(stateQuery);
      // The awaiting record the API reads (inbox rows / decide enforcement / public
      // prompt) rides the ctx under the reserved __approval key.
      expect(paused.ctx.__approval).toMatchObject({
        nodeId: "appr",
        pausedAt: "2026-01-01T00:00:00.000Z",
        slaHours: 48,
        contextFields: { Company: "Acme", Amount: "1200" },
        approvers: {
          emails: ["sam@acme.io"],
          groups: [{ id: "g-finance", name: "g-finance-name" }],
        },
      });
      // The activity got the PAUSE-TIME ctx snapshot with reserved __ keys stripped
      // (no __input — same contract as the code node's snapshot) + the tenant.
      const call = prepareApprovalCalls.find((c) => c.tenantId === "t-routed");
      expect(call).toBeTruthy();
      expect(call?.nodeId).toBe("appr");
      expect(call?.ctx.trigger).toEqual({ company: "Acme", amount: 1200 });
      expect("__input" in (call?.ctx ?? {})).toBe(false);

      await handle.signal(approvalSignal, { approved: true });
      const result = await handle.result();
      expect(result.status).toBe("completed");
      // Decision recorded as usual; the awaiting record is CLEARED once decided.
      expect(result.ctx.appr).toEqual({ approved: true, comment: null });
      expect(result.ctx.__approval).toBeUndefined();
    });
  });

  it("Slice 1: reminder + escalation timers fire the notification ACTIVITY (durable timers), then the gate still resolves — and the history REPLAYS", async () => {
    // Tiny hour offsets (env is createLocal — real time): reminders at ~0.7s/​~1.4s,
    // escalation at ~2.2s. No timeoutHours — after the schedule the gate waits forever.
    const reminderGraph: GraphDef = {
      startNodeId: "s",
      nodes: [
        { id: "s", type: "start" },
        {
          id: "appr",
          type: "humanApproval",
          config: {
            title: "Remind me",
            remindAfterHours: [0.0002, 0.0004],
            escalateAfterHours: 0.0006,
            escalateTo: "@ops-oncall",
          },
        },
        { id: "e", type: "end" },
      ],
      edges: [
        { from: "s", to: "appr" },
        { from: "appr", to: "e" },
      ],
    };
    const worker = await makeWorker(env);
    const history = await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [reminderGraph, {}, { tenantId: "t-remind" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-approve-remind",
      });
      // Both reminders AND the escalation fire while nobody decides.
      await waitFor(async () =>
        notifyCalls.some(
          (n) => n.tenantId === "t-remind" && n.flavor === "escalation",
        ),
      );
      const mine = notifyCalls.filter((n) => n.tenantId === "t-remind");
      // Initial pause notification first (no flavor), then reminder #1, #2, escalation.
      expect(mine.map((n) => n.flavor ?? "initial")).toEqual([
        "initial",
        "reminder",
        "reminder",
        "escalation",
      ]);
      expect(mine.every((n) => n.kind === "approval_pending")).toBe(true);
      expect(mine[1]).toMatchObject({ reminderIndex: 1, title: "Remind me" });
      expect(mine[2]).toMatchObject({ reminderIndex: 2 });
      expect(mine[3]).toMatchObject({ escalateTo: "@ops-oncall" });

      // The gate is still decidable after the whole schedule elapsed.
      await handle.signal(approvalSignal, { approved: true });
      const result = await handle.result();
      expect(result.status).toBe("completed");
      return handle.fetchHistory();
    });
    // The segmented timer loop replays deterministically (schedule is a pure
    // derivation of the config snapshot — the authoritative determinism guard).
    await expect(
      Worker.runReplayHistory(
        { workflowsPath: WORKFLOWS_PATH },
        history,
        "e2e-approve-remind",
      ),
    ).resolves.toBeUndefined();
  });

  it("Slice 1 invariant: an OLD-STYLE gate (no new fields) emits NO new commands — no prepareApproval, no timers — and its history replays", async () => {
    const plainGraph: GraphDef = {
      startNodeId: "s",
      nodes: [
        { id: "s", type: "start" },
        { id: "appr", type: "humanApproval", config: { title: "Plain" } },
        { id: "e", type: "end" },
      ],
      edges: [
        { from: "s", to: "appr" },
        { from: "appr", to: "e" },
      ],
    };
    const worker = await makeWorker(env);
    const history = await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [plainGraph, {}, { tenantId: "t-plain-gate" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-approve-plain",
      });
      await waitFor(
        async () =>
          (await handle.query(stateQuery)).status === "awaiting_approval",
      );
      // No awaiting snapshot for an un-routed gate (the exact pre-existing path).
      expect((await handle.query(stateQuery)).ctx.__approval).toBeUndefined();
      await handle.signal(approvalSignal, { approved: true });
      expect((await handle.result()).status).toBe("completed");
      return handle.fetchHistory();
    });
    expect(
      prepareApprovalCalls.some((c) => c.tenantId === "t-plain-gate"),
    ).toBe(false);
    // The durable record agrees: no prepareApproval activity, no timer commands.
    const events = (history.events ?? []) as {
      activityTaskScheduledEventAttributes?: {
        activityType?: { name?: string };
      };
      timerStartedEventAttributes?: unknown;
    }[];
    expect(
      events.some(
        (e) =>
          e.activityTaskScheduledEventAttributes?.activityType?.name ===
          "prepareApproval",
      ),
    ).toBe(false);
    expect(events.some((e) => e.timerStartedEventAttributes)).toBe(false);
    // And it replays against the NEW interpreter code — the replay-safety invariant.
    await expect(
      Worker.runReplayHistory(
        { workflowsPath: WORKFLOWS_PATH },
        history,
        "e2e-approve-plain",
      ),
    ).resolves.toBeUndefined();
  });

  it("resolves to rejected when approval is denied", async () => {
    const worker = await makeWorker(env);
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
    const worker = await makeWorker(env);
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
});

describe("runGraph interpreter — budget pause-not-fail (Slice 3)", () => {
  // start → agent → end. The agent mock throws BUDGET_PAUSE while
  // pauseAgentFailures > 0 (the live-read monthly-cap policy is "pause").
  const pauseGraph: GraphDef = {
    startNodeId: "s",
    nodes: [
      { id: "s", type: "start" },
      {
        id: "act",
        type: "agent",
        config: {
          provider: "anthropic",
          model: "claude-opus-4-8",
          systemPrompt: "x",
        },
      },
      { id: "e", type: "end" },
    ],
    edges: [
      { from: "s", to: "act" },
      { from: "act", to: "e" },
    ],
  };

  it("monthly-cap BUDGET_PAUSE parks the run; budgetResume RETRIES the node and the run completes — and the history replays", async () => {
    harnessState.pauseAgentFailures = 1; // first reservation refused under policy "pause"
    harnessState.refreshBudgetResult = {
      perExecutionCapUsd: 5,
      maxStepsPerRun: 50,
      onBudgetExceeded: "pause",
    };
    refreshBudgetCalls.length = 0;
    const worker = await makeWorker(env);
    const history = await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [pauseGraph, {}, { tenantId: "t-pause-monthly" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-budget-pause",
      });
      await waitFor(
        async () =>
          (await handle.query(stateQuery)).status === "awaiting_budget",
      );
      // The pause reached the Runs read-model (where PUT-resume enumerates from).
      // AWAITED, not asserted inline: `pauseOnBudget` sets `state.status` and only THEN
      // awaits `syncStatus()`, which is an ACTIVITY — so the state query above goes true
      // strictly before the push lands. Asserting it immediately was a race the test only
      // ever won because the workflow bundle was big enough to slow the worker down; #926
      // halved the bundle and it started failing ~2 runs in 3.
      const parked1 = () =>
        statusPushes.some(
          (p) =>
            p.workflowId === "e2e-budget-pause" &&
            p.status === "awaiting_budget",
        );
      await waitFor(async () => parked1());
      expect(parked1()).toBe(true);
      // Live spend rides the state query while parked (Slice 3 item 4).
      const parked = await handle.query(stateQuery);
      expect(parked.spentUsd).toBe(0); // the refused call never billed
      await handle.signal(budgetResumeSignal, { tenantId: "t-pause-monthly" });
      const result = await handle.result();
      expect(result.status).toBe("completed");
      expect(result.ctx.act).toMatchObject({ status: "ok" }); // the node RETRIED
      return handle.fetchHistory();
    });
    // On resume the workflow re-read the caps in-activity (never in workflow code).
    expect(
      refreshBudgetCalls.some((c) => c.tenantId === "t-pause-monthly"),
    ).toBe(true);
    // The pause path (patched marker + condition + activities) replays deterministically.
    await expect(
      Worker.runReplayHistory(
        { workflowsPath: WORKFLOWS_PATH },
        history,
        "e2e-budget-pause",
      ),
    ).resolves.toBeUndefined();
  });

  it("per-run cap under policy 'pause': parks instead of budget_exceeded; a resume with a RAISED cap completes — and replays", async () => {
    harnessState.pauseAgentFailures = 0;
    harnessState.refreshBudgetResult = {
      perExecutionCapUsd: 5, // the "PUT raised the cap" the resume re-reads
      maxStepsPerRun: 50,
      onBudgetExceeded: "pause",
    };
    const worker = await makeWorker(env);
    const history = await worker.runUntil(async () => {
      // agent costs 0.01; cap 0.005 trips at the node AFTER the agent — but the
      // snapshotted policy "pause" parks the run instead of the old terminal.
      const handle = await env.client.workflow.start(runGraph, {
        args: [
          pauseGraph,
          {},
          {
            tenantId: "t-pause-cap",
            perExecutionCapUsd: 0.005,
            maxStepsPerRun: 50,
            onBudgetExceeded: "pause",
          },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-budget-pause-cap",
      });
      await waitFor(
        async () =>
          (await handle.query(stateQuery)).status === "awaiting_budget",
      );
      // The meter shows the REAL figures while parked: spend + the run's own cap.
      const parked = await handle.query(stateQuery);
      expect(parked.spentUsd).toBe(0.01);
      expect(parked.perExecutionCapUsd).toBe(0.005);
      await handle.signal(budgetResumeSignal, { tenantId: "t-pause-cap" });
      const result = await handle.result();
      expect(result.status).toBe("completed"); // raised cap → the run finished
      return handle.fetchHistory();
    });
    await expect(
      Worker.runReplayHistory(
        { workflowsPath: WORKFLOWS_PATH },
        history,
        "e2e-budget-pause-cap",
      ),
    ).resolves.toBeUndefined();
  });

  it("still over after resume: the run re-parks (each cycle consumes its own Signal), then completes after a real raise", async () => {
    harnessState.pauseAgentFailures = 0;
    harnessState.refreshBudgetResult = {
      perExecutionCapUsd: 0.005, // resume does NOT clear the cap yet
      maxStepsPerRun: 50,
      onBudgetExceeded: "pause",
    };
    const worker = await makeWorker(env);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [
          pauseGraph,
          {},
          {
            tenantId: "t-pause-repark",
            perExecutionCapUsd: 0.005,
            maxStepsPerRun: 50,
            onBudgetExceeded: "pause",
          },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-budget-repark",
      });
      await waitFor(
        async () =>
          (await handle.query(stateQuery)).status === "awaiting_budget",
      );
      // First resume: the re-read cap is UNCHANGED → the run parks AGAIN. Await the
      // SECOND awaiting_budget read-model push (the first park pushed once already) —
      // querying the status alone could race the signal and see the FIRST park.
      const parks = () =>
        statusPushes.filter(
          (p) =>
            p.workflowId === "e2e-budget-repark" &&
            p.status === "awaiting_budget",
        ).length;
      // Same await-then-assert as above: the query flips on `state.status`, the push is an
      // activity that lands after it. `>= 1` to wait, `=== 1` to assert it parked exactly once.
      await waitFor(async () => parks() >= 1);
      expect(parks()).toBe(1);
      await handle.signal(budgetResumeSignal, { tenantId: "t-pause-repark" });
      await waitFor(async () => parks() >= 2);
      // Now the cap really rises; the next Signal completes the run.
      harnessState.refreshBudgetResult = {
        perExecutionCapUsd: 5,
        maxStepsPerRun: 50,
        onBudgetExceeded: "pause",
      };
      await handle.signal(budgetResumeSignal, { tenantId: "t-pause-repark" });
      expect((await handle.result()).status).toBe("completed");
    });
  });

  it("ONE budgetResume Signal wakes ALL parked parallel branches (monotonic counter, not a flag)", async () => {
    // start fans out to two agents; BOTH reservations refuse under "pause".
    const parallelGraph: GraphDef = {
      startNodeId: "s",
      nodes: [
        { id: "s", type: "start" },
        {
          id: "a1",
          type: "agent",
          config: {
            provider: "anthropic",
            model: "claude-opus-4-8",
            systemPrompt: "x",
          },
        },
        {
          id: "a2",
          type: "agent",
          config: {
            provider: "anthropic",
            model: "claude-opus-4-8",
            systemPrompt: "y",
          },
        },
        { id: "e", type: "end" },
      ],
      edges: [
        { from: "s", to: "a1" },
        { from: "s", to: "a2" },
        { from: "a1", to: "e" },
        { from: "a2", to: "e" },
      ],
    };
    harnessState.pauseAgentFailures = 2; // one refusal per branch
    harnessState.refreshBudgetResult = {
      perExecutionCapUsd: 5,
      maxStepsPerRun: 50,
      onBudgetExceeded: "pause",
    };
    const worker = await makeWorker(env);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [parallelGraph, {}, { tenantId: "t-pause-parallel" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-budget-pause-parallel",
      });
      await waitFor(
        async () =>
          (await handle.query(stateQuery)).status === "awaiting_budget",
      );
      await handle.signal(budgetResumeSignal, { tenantId: "t-pause-parallel" });
      const result = await handle.result();
      expect(result.status).toBe("completed");
      expect(result.ctx.a1).toMatchObject({ status: "ok" });
      expect(result.ctx.a2).toMatchObject({ status: "ok" });
    });
  });

  it("Slice 3 invariant: a NON-pause run keeps the exact legacy terminal (budget_exceeded, no pause commands) and its history REPLAYS", async () => {
    harnessState.pauseAgentFailures = 0;
    refreshBudgetCalls.length = 0;
    const worker = await makeWorker(env);
    const history = await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [
          pauseGraph,
          {},
          // No onBudgetExceeded in the snapshot — the pre-Slice-3 shape.
          {
            tenantId: "t-legacy-cap",
            perExecutionCapUsd: 0.005,
            maxStepsPerRun: 50,
          },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-budget-legacy",
      });
      const result = await handle.result();
      expect(result.status).toBe("budget_exceeded");
      return handle.fetchHistory();
    });
    // No pause machinery ran: no budget re-read, no budgetResume wait.
    expect(refreshBudgetCalls.length).toBe(0);
    const events = (history.events ?? []) as {
      activityTaskScheduledEventAttributes?: {
        activityType?: { name?: string };
      };
    }[];
    expect(
      events.some(
        (e) =>
          e.activityTaskScheduledEventAttributes?.activityType?.name ===
          "refreshBudget",
      ),
    ).toBe(false);
    // The "old history" case: recorded WITHOUT the pause path/marker, replayed
    // against the NEW interpreter — byte-identical commands, no nondeterminism.
    await expect(
      Worker.runReplayHistory(
        { workflowsPath: WORKFLOWS_PATH },
        history,
        "e2e-budget-legacy",
      ),
    ).resolves.toBeUndefined();
  });
});
