// Can a FAILED workflow still answer `stateQuery`?
//
// The run detail's recovery for a Temporal-level failure depends entirely on this. That branch
// has no returned `{status,ctx}` — the workflow threw — so it re-reads the ctx by QUERYING the
// closed workflow, which makes Temporal replay its history and answer from the rebuilt state.
//
// The API-side test for that mocks `handle.query`, so it proves the wiring and nothing about
// whether Temporal will actually hand the ctx back. And this is genuinely open: replay of a
// failed run reaches the throw, and whether the SDK answers from the state built BEFORE it or
// propagates the failure as a query error decides whether the fix does anything in production.
//
// Existing code queries a CLOSED workflow already, but only ones that RETURNED. A failed one is
// the untested case, and it is the only case the recovery targets. So: against a real Temporal.
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { createLocalTestEnv } from "./local-test-env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stateQuery } from "@naary/contracts";
import { runGraph } from "../src/temporal/workflows";
import { TASK_QUEUE, throwGraph, makeWorker } from "./interpreter-harness";

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await createLocalTestEnv();
}, 120_000);

afterAll(async () => {
  await env?.teardown();
});

describe("querying a run that FAILED at the Temporal level", () => {
  it("answers stateQuery with the ctx the run had built when it threw", async () => {
    const worker = await makeWorker(env);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [
          throwGraph,
          { ticket: "NAARY-42" },
          { tenantId: "t-closed", environmentId: "e-closed" },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-closed-run-query",
      });
      await expect(handle.result()).rejects.toThrow(); // the run FAILS

      // …and is now closed. This is the call the run detail makes.
      const s = await handle.query(stateQuery);

      // The ctx survives the failure: the trigger node ran and published its output before
      // `stopAndError` threw, so the run detail can show that step's output instead of
      // "No output was recorded for this step".
      expect(s.ctx).toBeTypeOf("object");
      expect(s.ctx.trigger).toEqual({ ticket: "NAARY-42" });
      expect(s.ctx.__input).toEqual({ ticket: "NAARY-42" });
    });
  }, 60_000);

  it("reports node timings for the steps that finished before the failure", async () => {
    // `nodeTimesFrom(s.ctx)` feeds the per-step DURATION column, which shows `—` today. A node
    // that never finished has no `f` stamp, so this checks the map is usable rather than
    // half-populated in a way that would render a wrong duration.
    const worker = await makeWorker(env);
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [
          throwGraph,
          { ticket: "NAARY-7" },
          { tenantId: "t-closed", environmentId: "e-closed" },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-closed-run-query-times",
      });
      await expect(handle.result()).rejects.toThrow();

      const s = await handle.query(stateQuery);
      const times = (
        s.ctx as {
          __nodeTimes?: Record<string, { s?: number; f?: number }>;
        }
      ).__nodeTimes;
      // The map survives the failure, so the DURATION column has something real to show. The
      // trigger node ran to completion before `stopAndError` threw, so it carries BOTH stamps.
      expect(times).toBeDefined();
      expect(typeof times?.trigger?.s).toBe("number");
      expect(typeof times?.trigger?.f).toBe("number");
      // Every entry must be a well-formed pair. A node still in flight when the run died has no
      // `f` and must simply be ABSENT rather than half-stamped — a start with no finish would
      // render as a duration that never elapsed.
      for (const [nodeId, t] of Object.entries(times ?? {})) {
        expect(typeof t.s, `${nodeId}.s`).toBe("number");
        if (t.f !== undefined) {
          expect(t.f, `${nodeId}.f`).toBeGreaterThanOrEqual(t.s as number);
        }
      }
    });
  }, 60_000);
});
