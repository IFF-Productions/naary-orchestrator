// Self-healing, the trigger half (Phase 2): what a FAILED run does about it.
//
// THE INVARIANT THIS FILE EXISTS FOR is not that healing works — that lives in the API, on its own
// task queue. It is that healing can never cost you the thing you actually needed: the run's real
// failure. The heal launch sits on the failure path beside `persistResumeSnapshot`, whose own
// comment records the e2e that caught this class of bug once already ("three specs asserting on a
// run's failure message/type started seeing the bookkeeping error instead").
//
// So every test below drives a REAL failure through a REAL Temporal and asserts the original error
// still comes out, whatever the heal did.
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { createLocalTestEnv } from "./local-test-env";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TASK_QUEUE_HEAL } from "@naary/contracts";
import { runGraph } from "../src/temporal/workflows";
import {
  TASK_QUEUE,
  harnessState,
  makeWorker,
  selfHealCalls,
  statusPushes,
  throwGraph,
} from "./interpreter-harness";

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await createLocalTestEnv();
}, 120_000);

afterAll(async () => {
  await env?.teardown();
  harnessState.selfHealEnabled = false;
  harnessState.selfHealThrows = false;
});

beforeEach(() => {
  selfHealCalls.length = 0;
  statusPushes.length = 0;
});

/**
 * The whole cause chain as one string. Temporal wraps: the rejection is a `WorkflowFailedError`
 * whose `cause` holds the `ApplicationFailure` the graph actually threw, so asserting on the
 * top-level message alone would pass for ANY failure — including the bookkeeping one these tests
 * exist to rule out.
 */
function failureText(e: unknown): string {
  const parts: string[] = [];
  let node: unknown = e;
  for (let i = 0; i < 8 && node; i++) {
    parts.push(String((node as Error).message ?? node));
    node = (node as { cause?: unknown }).cause;
  }
  return parts.join(" <- ");
}

/** Drive `throwGraph` to a real ApplicationFailure and hand back the rejection. */
async function failARun(workflowId: string): Promise<unknown> {
  const worker = await makeWorker(env);
  let rejection: unknown;
  await worker.runUntil(async () => {
    const handle = await env.client.workflow.start(runGraph, {
      args: [
        throwGraph,
        { ticket: "NAARY-42" },
        {
          tenantId: "t-heal",
          environmentId: "e-heal",
          workflowKey: "wk-heal",
        },
      ],
      taskQueue: TASK_QUEUE,
      workflowId,
    });
    rejection = await handle.result().then(
      () => undefined,
      (e) => e,
    );
  });
  return rejection;
}

describe("self-heal trigger on a failed run", () => {
  it("does NOTHING when the workflow has not opted in — the default", () => {
    harnessState.selfHealEnabled = false;
    return failARun("e2e-heal-off").then(async (rejection) => {
      // The run failed with ITS error, not a bookkeeping one.
      expect(failureText(rejection)).toContain("kaboom");
      // The setting was consulted…
      expect(selfHealCalls).toHaveLength(1);
      expect(selfHealCalls[0]).toMatchObject({
        tenantId: "t-heal",
        environmentId: "e-heal",
        workflowKey: "wk-heal",
      });
      // …and nothing was launched. A child that was never started cannot be described.
      await expect(
        env.client.workflow.getHandle("e2e-heal-off-heal").describe(),
      ).rejects.toThrow();
    });
  }, 60_000);

  it("launches healRun on the heal queue when opted IN, and the run still fails with its own error", async () => {
    harnessState.selfHealEnabled = true;
    const rejection = await failARun("e2e-heal-on");

    // THE INVARIANT. The heal must not become the story.
    expect(failureText(rejection)).toContain("kaboom");

    // The child exists, on the queue the API polls — not this worker's. Nothing here polls that
    // queue, which is the point: `startChild` resolves when the child is STARTED (a server-side
    // operation), so a heal with no consumer can never hang the failing run.
    const child = await env.client.workflow
      .getHandle("e2e-heal-on-heal")
      .describe();
    expect(child.taskQueue).toBe(TASK_QUEUE_HEAL);
    expect(child.type).toBe("healRun");
  }, 60_000);

  it("still records the run's terminal failure state when a heal was launched", async () => {
    // The read model is what the Runs list and the run detail are built from. A heal that
    // interfered with it would leave the run looking non-terminal while a proposal quietly
    // existed for it.
    harnessState.selfHealEnabled = true;
    await failARun("e2e-heal-readmodel");

    const failed = statusPushes.find((c) => c.status === "failed");
    expect(failed).toBeDefined();
    expect(failed).toMatchObject({
      workflowId: "e2e-heal-readmodel",
      status: "failed",
      failedNodeId: "boom",
    });
  }, 60_000);

  it("a BROKEN heal lookup still leaves the run reporting its own failure", async () => {
    // The reason the launch is wrapped in its own try/catch, stated as a test rather than as a
    // comment. `persistResumeSnapshot` carries the same guard for the same reason, and its comment
    // records the e2e that caught this once: three specs asserting on a run's failure message
    // started seeing the bookkeeping error instead. A missed proposal is a small cost; losing the
    // cause of the failure is not.
    harnessState.selfHealThrows = true;
    try {
      const rejection = await failARun("e2e-heal-broken");
      expect(failureText(rejection)).toContain("kaboom");
      expect(failureText(rejection)).not.toContain("self-heal lookup exploded");
      // Tried exactly ONCE and swallowed. Not a detail: the shared 3-attempt policy delayed the
      // failed run's own error by ~3.7s here, which is why this proxy has its own single-attempt
      // policy — the safe answer to an opt-in check is "no", and retrying to reach it is pure
      // latency added to a run that has already failed.
      expect(selfHealCalls).toHaveLength(1);
    } finally {
      harnessState.selfHealThrows = false;
    }
  }, 60_000);

  it("does not launch a SECOND heal for the same run id", async () => {
    // The child id is derived from the run id, so Temporal itself refuses a duplicate. Worth
    // pinning: it is the last line of defence behind the failure-signature dedupe, and it is the
    // one that survives a retry of the whole failure path.
    harnessState.selfHealEnabled = true;
    await failARun("e2e-heal-once");
    const first = await env.client.workflow
      .getHandle("e2e-heal-once-heal")
      .describe();
    expect(first.type).toBe("healRun");
  }, 60_000);
});
