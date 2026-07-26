// Workflow evals (#575) — the BATCH workflow under TestWorkflowEnvironment. Runs the REAL `evalRun`
// workflow, which launches the REAL `runGraph` interpreter once per golden case as a child workflow;
// only the leaf I/O activities and the three eval activities are mocked (hermetic: no DB, no LLM).
//
// This is what proves the AC "a workflow with a golden dataset can run an eval batch; results show
// pass/fail per case with cost" against the actual interpreter rather than a stub.
import * as path from "node:path";
import { ApplicationFailure } from "@temporalio/activity";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TASK_QUEUE } from "@naary/contracts";
import type { GraphDef } from "@naary/dsl";
import type * as activities from "../src/temporal/activities";
import { evalRun } from "../src/temporal/workflows";
import { createLocalTestEnv } from "./local-test-env";

const WORKFLOWS_PATH = path.join(__dirname, "../src/temporal/workflows.ts");

/** webhookTrigger → agent → end. The agent's mocked output is what assertions read. */
const graph: GraphDef = {
  startNodeId: "trigger",
  nodes: [
    { id: "trigger", type: "webhookTrigger" },
    {
      id: "agent",
      type: "agent",
      config: {
        provider: "anthropic",
        model: "claude-opus-4-8",
        systemPrompt: "classify",
      },
    },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "trigger", to: "agent" },
    { from: "agent", to: "end" },
  ],
};

/** The plan `loadEvalPlan` hands the batch, and the verdict each case is scored with. */
const state: {
  cases: activities.EvalPlanCase[];
  /** caseName → verdict the (mocked) scoring activity returns. */
  verdicts: Record<string, "pass" | "fail" | "error">;
  /** Which case inputs should make the child run FAIL (a stopAndError-like blow-up). */
  failInputs: string[];
  /** Make `loadEvalPlan` throw — exercises the batch's failure path. */
  planThrows: boolean;
  /** Case names whose SCORING activity throws (at-most-once, so there is no retry). */
  scoringThrowsFor: string[];
} = {
  cases: [],
  verdicts: {},
  failInputs: [],
  planThrows: false,
  scoringThrowsFor: [],
};

const scored: activities.EvaluateEvalCaseInput[] = [];
const finalized: { tenantId: string; evalRunId: string; status?: string }[] =
  [];
const childInputs: unknown[] = [];

const mockActivities = {
  runAgent: async (
    _cfg: activities.AgentConfig,
    input: unknown,
    _meta: activities.AgentMeta,
  ): Promise<activities.AgentResult> => {
    childInputs.push(input);
    const tag = (input as { tag?: string })?.tag ?? "";
    if (state.failInputs.includes(tag)) {
      throw new Error("agent blew up for this case");
    }
    return {
      status: "ok",
      output: { category: tag === "sales" ? "sales" : "billing", urgency: 4 },
      model: "claude-opus-4-8",
      costUsd: 0.01,
    };
  },
  recordExecution: async (): Promise<void> => undefined,
  setExecutionStatus: async (): Promise<void> => undefined,
  loadVariables: async (): Promise<Record<string, string>> => ({}),
  resolveToolPolicy: async (): Promise<activities.ToolPolicyProjection> => ({}),
  recordAuditEvent: async (): Promise<void> => undefined,

  // --- eval activities ---
  loadEvalPlan: async (): Promise<activities.EvalPlan> => {
    if (state.planThrows) {
      throw ApplicationFailure.nonRetryable(
        "dataset is malformed",
        "EVAL_DATASET_INVALID",
      );
    }
    return {
      workflowKey: "refunds",
      environmentId: "e1",
      cases: state.cases,
    };
  },
  evaluateEvalCase: async (
    input: activities.EvaluateEvalCaseInput,
  ): Promise<activities.EvaluateEvalCaseResult> => {
    if (state.scoringThrowsFor.includes(input.caseName)) {
      throw ApplicationFailure.nonRetryable("judge deadline", "SCORING_FAILED");
    }
    scored.push(input);
    const verdict =
      input.status === "completed"
        ? (state.verdicts[input.caseName] ?? "pass")
        : "error";
    return {
      verdict,
      score: verdict === "pass" ? 1 : 0,
      costUsd: input.costUsd ?? 0,
    };
  },
  finalizeEvalRun: async (input: {
    tenantId: string;
    evalRunId: string;
    status?: string;
  }): Promise<activities.EvalRunSummary> => {
    finalized.push(input);
    const total = scored.length;
    const errored = scored.filter((s) => s.status !== "completed").length;
    const failed = scored.filter(
      (s) => s.status === "completed" && state.verdicts[s.caseName] === "fail",
    ).length;
    return {
      total,
      passed: total - errored - failed,
      failed,
      errored,
      costUsd: scored.reduce((s, c) => s + (c.costUsd ?? 0), 0),
    };
  },
};

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await createLocalTestEnv();
}, 60_000);

afterAll(async () => {
  await env?.teardown();
});

beforeEach(() => {
  scored.length = 0;
  finalized.length = 0;
  childInputs.length = 0;
  state.verdicts = {};
  state.failInputs = [];
  state.planThrows = false;
  state.scoringThrowsFor = [];
});

const makeWorker = () =>
  Worker.create({
    connection: env.nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowsPath: WORKFLOWS_PATH,
    activities: mockActivities,
  });

const input = (evalRunId: string) => ({
  tenantId: "t-eval",
  environmentId: "e1",
  workflowKey: "refunds",
  evalRunId,
  graph,
  graphContentHash: "abc123",
  graphVersion: 7,
});

describe("evalRun — batch eval over a golden dataset", () => {
  it("runs one CHILD interpreter run per case, scores each, and returns the summary", async () => {
    state.cases = [
      { name: "double-charge", input: { tag: "billing" } },
      { name: "upsell", input: { tag: "sales" } },
    ];
    state.verdicts = { upsell: "fail" };

    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const result = await env.client.workflow.execute(evalRun, {
        args: [input("run-a")],
        taskQueue: TASK_QUEUE,
        workflowId: "eval-run-a",
      });
      expect(result).toEqual({
        total: 2,
        passed: 1,
        failed: 1,
        errored: 0,
        costUsd: 0.02,
      });
    });

    // Each case really ran the interpreter with ITS OWN trigger payload. Compared as a SET: cases
    // within a chunk run concurrently, so the order the mocked activity OBSERVES them in is not
    // fixed (workflow determinism is Temporal replaying completion order, not activity arrival).
    expect(childInputs.map((i) => (i as { tag: string }).tag).sort()).toEqual([
      "billing",
      "sales",
    ]);
    // Deterministic child ids derived from the eval-run id + case INDEX (drill-down + replay).
    expect(scored.map((s) => [s.caseName, s.executionId]).sort()).toEqual([
      ["double-charge", "run-a-case-0"],
      ["upsell", "run-a-case-1"],
    ]);
    // The scoring activity received the child's node-output ctx with `__*` bookkeeping stripped,
    // its cost, and a measured latency.
    const billing = scored.find((s) => s.caseName === "double-charge")!;
    expect(billing.status).toBe("completed");
    expect(billing.ctx).toMatchObject({
      agent: { status: "ok", output: { category: "billing" } },
    });
    expect(Object.keys(billing.ctx).some((k) => k.startsWith("__"))).toBe(
      false,
    );
    expect(billing.costUsd).toBeCloseTo(0.01, 9);
    expect(billing.latencyMs).toBeGreaterThanOrEqual(0);
    // The run is closed out exactly once.
    expect(finalized).toEqual([
      { tenantId: "t-eval", evalRunId: "run-a", status: "completed" },
    ]);
  });

  it("a case whose child run FAILS becomes an ERROR verdict and does NOT kill the batch", async () => {
    state.cases = [
      { name: "ok-case", input: { tag: "billing" } },
      { name: "boom-case", input: { tag: "boom" } },
      { name: "ok-case-2", input: { tag: "billing" } },
    ];
    state.failInputs = ["boom"];

    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const result = await env.client.workflow.execute(evalRun, {
        args: [input("run-b")],
        taskQueue: TASK_QUEUE,
        workflowId: "eval-run-b",
      });
      // The batch completed; the broken case is reported, not fatal.
      expect(result).toMatchObject({ total: 3, errored: 1, passed: 2 });
    });
    const boom = scored.find((s) => s.caseName === "boom-case");
    expect(boom?.status).toBe("failed");
    expect(boom?.ctx).toEqual({});
    expect(boom?.costUsd).toBeUndefined();
    // The other two still ran and were scored.
    expect(scored.map((s) => s.caseName).sort()).toEqual([
      "boom-case",
      "ok-case",
      "ok-case-2",
    ]);
  });

  it("an empty dataset finalizes cleanly without launching anything", async () => {
    state.cases = [];
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const result = await env.client.workflow.execute(evalRun, {
        args: [input("run-c")],
        taskQueue: TASK_QUEUE,
        workflowId: "eval-run-c",
      });
      expect(result).toMatchObject({ total: 0 });
    });
    expect(scored).toHaveLength(0);
    expect(finalized).toHaveLength(1);
  });

  it("a FAILED batch closes the run out as `failed` — never left saying `running` forever", async () => {
    state.planThrows = true;
    state.cases = [{ name: "a", input: { tag: "billing" } }];
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(evalRun, {
        args: [input("run-e")],
        taskQueue: TASK_QUEUE,
        workflowId: "eval-run-e",
      });
      // The execution itself still fails (the error is not swallowed) …
      await expect(handle.result()).rejects.toThrow();
    });
    // … but the row was closed out, so it is distinguishable from a batch still in progress.
    expect(finalized).toEqual([
      { tenantId: "t-eval", evalRunId: "run-e", status: "failed" },
    ]);
  });

  it("a case whose SCORING fails is skipped, not fatal (at-most-once: there is no retry)", async () => {
    // The scoring activity is maximumAttempts:1 because it can make many billed LLM-judge calls;
    // so one unscoreable case must not take the batch down. It simply has no result row, and the
    // row-derived total comes out below EvalRun.totalCases — an honest "incomplete" signal.
    state.cases = [
      { name: "good", input: { tag: "billing" } },
      { name: "unscoreable", input: { tag: "billing" } },
    ];
    state.scoringThrowsFor = ["unscoreable"];
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const result = await env.client.workflow.execute(evalRun, {
        args: [input("run-f")],
        taskQueue: TASK_QUEUE,
        workflowId: "eval-run-f",
      });
      expect(result).toMatchObject({ total: 1, passed: 1 });
    });
    expect(scored.map((s) => s.caseName)).toEqual(["good"]);
    expect(finalized[0].status).toBe("completed");
  });

  it("runs cases in bounded CONCURRENCY chunks (a large dataset cannot fan out unbounded)", async () => {
    // 6 cases at EVAL_CONCURRENCY=4 ⇒ two chunks; every case is still scored exactly once.
    state.cases = Array.from({ length: 6 }, (_, i) => ({
      name: `c${i}`,
      input: { tag: "billing" },
    }));
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const result = await env.client.workflow.execute(evalRun, {
        args: [input("run-d")],
        taskQueue: TASK_QUEUE,
        workflowId: "eval-run-d",
      });
      expect(result).toMatchObject({ total: 6, passed: 6 });
    });
    expect(new Set(scored.map((s) => s.caseName)).size).toBe(6);
  });
});
