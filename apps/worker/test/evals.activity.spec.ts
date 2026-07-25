// Workflow evals (#575) — the eval ACTIVITY: assertion scoring, the LLM-judge path (billed through
// runAgent), run aggregation, and the PRIVACY guarantee on what reaches Postgres.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture the prisma calls the activity makes; each test fixes the dataset body it reads back.
const evalRunFindFirst = vi.fn();
const caseUpsert = vi.fn();
const caseFindMany = vi.fn();
const runUpdateMany = vi.fn();
vi.mock("@naary/db", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  getPrisma: () => ({
    evalRun: { findFirst: evalRunFindFirst, updateMany: runUpdateMany },
    evalCaseResult: { upsert: caseUpsert, findMany: caseFindMany },
  }),
}));

const logRecords: unknown[] = [];
vi.mock("@naary/logging", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  const cap =
    (level: string) =>
    (...args: unknown[]) => {
      logRecords.push({ level, args });
    };
  const logger = {
    info: cap("info"),
    warn: cap("warn"),
    error: cap("error"),
    debug: cap("debug"),
    child: () => logger,
  };
  return { ...real, createLogger: () => logger };
});

import {
  __evalDeps,
  evaluateEvalCase,
  EVAL_JUDGE_NODE_TYPE,
  finalizeEvalRun,
  loadEvalPlan,
} from "../src/temporal/activities";

const BASE = {
  tenantId: "t1",
  environmentId: "e1",
  evalRunId: "run-1",
  caseName: "double-charge",
  executionId: "eval-run-1-case-0",
  status: "completed",
  costUsd: 0.01,
  latencyMs: 1234,
};

/** The child-run ctx an eval case produced. */
const CTX = {
  agent: { status: "ok", output: { category: "billing", urgency: 4 } },
};

function seedDataset(body: unknown) {
  evalRunFindFirst.mockResolvedValue({
    id: "run-1",
    tenantId: "t1",
    workflowKey: "refunds",
    environmentId: "e1",
    dataset: { body },
  });
}

const runAgent = vi.fn();

beforeEach(() => {
  logRecords.length = 0;
  evalRunFindFirst.mockReset();
  caseUpsert.mockReset().mockResolvedValue({});
  caseFindMany.mockReset().mockResolvedValue([]);
  runUpdateMany.mockReset().mockResolvedValue({ count: 1 });
  runAgent.mockReset();
  __evalDeps.runAgent = runAgent as never;
});

afterEach(() => vi.clearAllMocks());

/** What the activity actually handed prisma for the result row. */
const persisted = () => caseUpsert.mock.calls[0][0].create;

describe("loadEvalPlan", () => {
  it("returns the case list in dataset order", async () => {
    seedDataset({
      cases: [
        { name: "a", input: { x: 1 } },
        { name: "b", input: { x: 2 } },
      ],
    });
    await expect(
      loadEvalPlan({ tenantId: "t1", evalRunId: "run-1" }),
    ).resolves.toEqual({
      workflowKey: "refunds",
      environmentId: "e1",
      cases: [
        { name: "a", input: { x: 1 } },
        { name: "b", input: { x: 2 } },
      ],
    });
  });

  it("a MALFORMED stored dataset is non-retryable (only an author can fix it)", async () => {
    seedDataset({ cases: "nope" });
    await expect(
      loadEvalPlan({ tenantId: "t1", evalRunId: "run-1" }),
    ).rejects.toMatchObject({
      type: "EVAL_DATASET_INVALID",
      nonRetryable: true,
    });
  });

  it("an unknown run is non-retryable", async () => {
    evalRunFindFirst.mockResolvedValue(null);
    await expect(
      loadEvalPlan({ tenantId: "t1", evalRunId: "nope" }),
    ).rejects.toMatchObject({ type: "EVAL_RUN_NOT_FOUND" });
  });
});

describe("evaluateEvalCase — deterministic assertions", () => {
  it("PASSES a case whose assertions all hold, and persists cost + latency", async () => {
    seedDataset({
      assertions: [
        {
          kind: "jsonPathEquals",
          label: "cat",
          path: "agent.output.category",
          value: "billing",
        },
      ],
      cases: [
        {
          name: "double-charge",
          input: {},
          assertions: [
            {
              kind: "numericTolerance",
              label: "urgency",
              path: "agent.output.urgency",
              expected: 4,
            },
          ],
        },
      ],
    });
    const r = await evaluateEvalCase({ ...BASE, ctx: CTX });
    expect(r).toEqual({ verdict: "pass", score: 1, costUsd: 0.01 });
    const row = persisted();
    expect(row.verdict).toBe("pass");
    expect(row.latencyMs).toBe(1234);
    expect(Number(row.costUsd)).toBeCloseTo(0.01, 9);
    expect(row.assertions).toEqual([
      { label: "cat", kind: "jsonPathEquals", passed: true, score: 1 },
      { label: "urgency", kind: "numericTolerance", passed: true, score: 1 },
    ]);
  });

  it("FAILS a case with a wrong value, and records the mean score", async () => {
    seedDataset({
      cases: [
        {
          name: "double-charge",
          input: {},
          assertions: [
            {
              kind: "jsonPathEquals",
              label: "cat",
              path: "agent.output.category",
              value: "sales",
            },
            {
              kind: "jsonPathEquals",
              label: "u",
              path: "agent.output.urgency",
              value: 4,
            },
          ],
        },
      ],
    });
    const r = await evaluateEvalCase({ ...BASE, ctx: CTX });
    expect(r.verdict).toBe("fail");
    expect(r.score).toBe(0.5);
  });

  it("a case whose child run did NOT complete is an ERROR, never a fail", async () => {
    seedDataset({ cases: [{ name: "double-charge", input: {} }] });
    const r = await evaluateEvalCase({
      ...BASE,
      status: "failed",
      ctx: {},
      costUsd: 0,
    });
    expect(r.verdict).toBe("error");
    expect(persisted().assertions).toEqual([
      {
        label: "run:failed",
        kind: "jsonPathEquals",
        passed: false,
        score: 0,
        error: "missing-path",
      },
    ]);
  });

  it("a case with NO assertions passes (it proved the graph runs end to end)", async () => {
    seedDataset({ cases: [{ name: "double-charge", input: {} }] });
    await expect(
      evaluateEvalCase({ ...BASE, ctx: CTX }),
    ).resolves.toMatchObject({ verdict: "pass", score: 1 });
  });

  it("upserts on (evalRunId, caseName) so a retry rewrites rather than duplicates", async () => {
    seedDataset({ cases: [{ name: "double-charge", input: {} }] });
    await evaluateEvalCase({ ...BASE, ctx: CTX });
    expect(caseUpsert.mock.calls[0][0].where).toEqual({
      evalRunId_caseName: { evalRunId: "run-1", caseName: "double-charge" },
    });
  });

  it("a case removed from the dataset since the batch started is non-retryable", async () => {
    seedDataset({ cases: [{ name: "other", input: {} }] });
    await expect(evaluateEvalCase({ ...BASE, ctx: CTX })).rejects.toMatchObject(
      { type: "EVAL_CASE_NOT_FOUND" },
    );
  });
});

describe("evaluateEvalCase — LLM judge (#575 AC3: billed through the existing ledger path)", () => {
  const judgeDataset = {
    cases: [
      {
        name: "double-charge",
        input: {},
        assertions: [
          { kind: "llmJudge", label: "tone", criteria: "Is the reply polite?" },
        ],
      },
    ],
  };

  it("calls runAgent (the real reservation/ledger path), tags the ledger row distinctly, and folds judge cost in", async () => {
    seedDataset(judgeDataset);
    runAgent.mockResolvedValue({
      status: "ok",
      output: { score: 0.9, pass: true, reason: "courteous" },
      model: "claude-opus-4-8",
      costUsd: 0.004,
    });
    const r = await evaluateEvalCase({ ...BASE, ctx: CTX });
    expect(r.verdict).toBe("pass");
    // Judge spend is ADDED to the case's own run cost.
    expect(r.costUsd).toBeCloseTo(0.014, 9);
    expect(runAgent).toHaveBeenCalledOnce();
    const [cfg, input, meta] = runAgent.mock.calls[0];
    expect(cfg.outputSchema.required).toEqual(["score", "pass", "reason"]);
    expect(cfg.temperature).toBe(0);
    expect(input).toEqual({ criteria: "Is the reply polite?", output: CTX });
    // Ledger identity: attributable to the eval run, uniquely keyed per assertion INDEX so two
    // judges in one case cannot collapse into a single billed row (recordUsage upserts).
    expect(meta).toEqual({
      tenantId: "t1",
      environmentId: "e1",
      executionId: "run-1",
      nodeId: "eval-judge:double-charge:0",
      ledgerNodeType: EVAL_JUDGE_NODE_TYPE,
    });
  });

  it("two judge assertions in one case get DISTINCT ledger nodeIds", async () => {
    seedDataset({
      cases: [
        {
          name: "double-charge",
          input: {},
          assertions: [
            { kind: "llmJudge", criteria: "a" },
            { kind: "llmJudge", criteria: "b" },
          ],
        },
      ],
    });
    runAgent.mockResolvedValue({
      status: "ok",
      output: { score: 1, pass: true, reason: "r" },
      model: "m",
      costUsd: 0.001,
    });
    await evaluateEvalCase({ ...BASE, ctx: CTX });
    expect(runAgent.mock.calls.map((c) => c[2].nodeId)).toEqual([
      "eval-judge:double-charge:0",
      "eval-judge:double-charge:1",
    ]);
  });

  it("honours the threshold", async () => {
    seedDataset({
      cases: [
        {
          name: "double-charge",
          input: {},
          assertions: [
            { kind: "llmJudge", label: "tone", criteria: "c", threshold: 0.95 },
          ],
        },
      ],
    });
    runAgent.mockResolvedValue({
      status: "ok",
      output: { score: 0.9, pass: true, reason: "r" },
      model: "m",
      costUsd: 0,
    });
    const r = await evaluateEvalCase({ ...BASE, ctx: CTX });
    expect(r.verdict).toBe("fail");
    expect(persisted().assertions[0]).toEqual({
      label: "tone",
      kind: "llmJudge",
      passed: false,
      score: 0.9,
    });
  });

  it("a judge that CANNOT run is an assertion error (not a quality regression) and costs nothing", async () => {
    seedDataset(judgeDataset);
    runAgent.mockRejectedValue(new Error("Invalid provider credentials"));
    const r = await evaluateEvalCase({ ...BASE, ctx: CTX });
    expect(r.verdict).toBe("error");
    expect(r.costUsd).toBe(0.01); // the case's own cost only
    expect(persisted().assertions[0]).toMatchObject({
      kind: "llmJudge",
      passed: false,
      error: "judge-unavailable",
    });
  });
});

/**
 * #575 privacy AC — "results stored in Postgres … store verdicts/scores, NOT prompt text".
 *
 * The distinctive strings below appear in (a) the case's run output and (b) the judge's prose
 * reason. Neither may appear anywhere in what the activity handed prisma, nor in any log line.
 */
describe("privacy — no run output and no judge prose reach Postgres", () => {
  const SECRET_OUTPUT = "Ada Lovelace was charged twice on card 4111";
  const SECRET_REASON = `The reply mentions "${SECRET_OUTPUT}" which is impolite`;

  it("neither the run output nor the judge reason is in the persisted row or the logs", async () => {
    seedDataset({
      cases: [
        {
          name: "double-charge",
          input: {},
          assertions: [
            {
              kind: "jsonPathEquals",
              label: "summary",
              path: "agent.output.summary",
              value: "something else",
            },
            { kind: "llmJudge", label: "tone", criteria: "Polite?" },
          ],
        },
      ],
    });
    runAgent.mockResolvedValue({
      status: "ok",
      output: { score: 0.2, pass: false, reason: SECRET_REASON },
      model: "m",
      costUsd: 0.002,
    });

    await evaluateEvalCase({
      ...BASE,
      ctx: { agent: { output: { summary: SECRET_OUTPUT } } },
    });

    // The FULL row the activity asked prisma to write — create and update branches both.
    const wrote = JSON.stringify(caseUpsert.mock.calls[0][0]);
    expect(wrote).not.toContain(SECRET_OUTPUT);
    expect(wrote).not.toContain("impolite");
    expect(wrote).not.toContain("Lovelace");
    expect(wrote).not.toContain("4111");
    // And the verdict was still recorded — the assertion above must not be vacuous.
    expect(persisted().verdict).toBe("fail");
    expect(persisted().assertions).toEqual([
      { label: "summary", kind: "jsonPathEquals", passed: false, score: 0 },
      { label: "tone", kind: "llmJudge", passed: false, score: 0.2 },
    ]);

    const logs = JSON.stringify(logRecords);
    expect(logRecords.length).toBeGreaterThan(0);
    expect(logs).not.toContain(SECRET_OUTPUT);
    expect(logs).not.toContain("impolite");
  });
});

describe("finalizeEvalRun", () => {
  it("aggregates FROM THE ROWS (idempotent) and closes the run out", async () => {
    caseFindMany.mockResolvedValue([
      { verdict: "pass", costUsd: "0.010000" },
      { verdict: "pass", costUsd: "0.020000" },
      { verdict: "fail", costUsd: "0.005000" },
      { verdict: "error", costUsd: null },
    ]);
    const summary = await finalizeEvalRun({
      tenantId: "t1",
      evalRunId: "run-1",
    });
    expect(summary).toMatchObject({
      total: 4,
      passed: 2,
      failed: 1,
      errored: 1,
    });
    expect(summary.costUsd).toBeCloseTo(0.035, 9); // float sum, rounded to 6dp on write
    const data = runUpdateMany.mock.calls[0][0].data;
    expect(data).toMatchObject({
      status: "completed",
      passed: 2,
      failed: 1,
      errored: 1,
    });
    expect(Number(data.costUsd)).toBeCloseTo(0.035, 9);
    expect(data.finishedAt).toBeInstanceOf(Date);
    // Scoped by tenant — an eval run id alone must never be enough.
    expect(runUpdateMany.mock.calls[0][0].where).toEqual({
      id: "run-1",
      tenantId: "t1",
    });
  });
});
