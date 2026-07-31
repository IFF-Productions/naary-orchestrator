// `healRun` against a REAL Temporal — the half that unit tests cannot reach.
//
// The reason this feature is a workflow rather than a job is the WAIT: hold a proposal for days
// while a human decides, survive restarts, and expire cleanly if nobody acts. None of that is
// observable by calling functions; it needs a real server and a real timer.
//
// TIME-SKIPPING, deliberately. The proposal TTL is seven days — a wall-clock test could never
// assert the expiry, so the one behaviour most likely to rot silently would be the one behaviour
// untested. The skipping env fast-forwards the timer instead.
import path from "node:path";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { healDecisionSignal } from "@naary/contracts";
import { healRun, type HealRunInput } from "../src/heal/heal-workflow";

// An explicit .ts path, like the worker's harness uses: `require.resolve` cannot find the
// extensionless module under vitest, and the bundler needs the source file anyway.
const WORKFLOWS_PATH = path.join(__dirname, "../src/heal/heal-workflows.ts");

const TASK_QUEUE = "heal-test";

let env: TestWorkflowEnvironment;

const diagnoseAndPropose = vi.fn();
const notifyProposal = vi.fn();
const expireProposal = vi.fn();

const INPUT: HealRunInput = {
  runId: "exec-1",
  tenantId: "t-1",
  environmentId: "env-1",
  workflowKey: "pagerduty-triage",
  failedNodeId: "pagerduty",
  failureKind: "error",
  failureMessage: "Missing required header 'From'",
};

async function makeWorker(): Promise<Worker> {
  return Worker.create({
    connection: env.nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowsPath: WORKFLOWS_PATH,
    activities: { diagnoseAndPropose, notifyProposal, expireProposal },
  });
}

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
}, 120_000);

afterAll(async () => {
  await env?.teardown();
});

beforeEach(() => {
  diagnoseAndPropose.mockReset().mockResolvedValue({ id: "p-1" });
  notifyProposal.mockReset().mockResolvedValue(undefined);
  expireProposal.mockReset().mockResolvedValue(undefined);
});

describe("healRun", () => {
  it("proposes, notifies, and then WAITS — it does not finish on its own", async () => {
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(healRun, {
        args: [INPUT],
        taskQueue: TASK_QUEUE,
        workflowId: "heal-waits",
      });

      // Give it room to reach the wait. Under time-skipping this is instant.
      await env.sleep("1 minute");

      expect(diagnoseAndPropose).toHaveBeenCalledTimes(1);
      expect(notifyProposal).toHaveBeenCalledWith({ proposalId: "p-1" });
      // Still running: nobody has decided, and the TTL has not elapsed. This is the state the
      // whole feature exists to hold, and the one a job/cron design could not.
      const desc = await handle.describe();
      expect(desc.status.name).toBe("RUNNING");
      expect(expireProposal).not.toHaveBeenCalled();

      await handle.signal(healDecisionSignal, { approved: true, by: "ops" });
      await handle.result();
      // A DECIDED proposal is not expired — the API already recorded the outcome, and marking it
      // expired afterwards would overwrite a real decision with "nobody acted".
      expect(expireProposal).not.toHaveBeenCalled();
    });
  }, 120_000);

  it("expires the proposal when nobody acts within the TTL", async () => {
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(healRun, {
        args: [INPUT],
        taskQueue: TASK_QUEUE,
        workflowId: "heal-expires",
      });
      // Past the 7-day TTL. Only reachable with a skipping clock.
      await handle.result();
      expect(expireProposal).toHaveBeenCalledWith({ proposalId: "p-1" });
    });
  }, 120_000);

  it("does nothing further when there was nothing to propose", async () => {
    // The dedupe path: an open proposal already exists for this failure signature, so a workflow
    // failing every 5 minutes produces one proposal rather than 288. It must not notify, and must
    // not park for a week holding a proposal it never created.
    diagnoseAndPropose.mockResolvedValue(null);
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      await env.client.workflow.execute(healRun, {
        args: [INPUT],
        taskQueue: TASK_QUEUE,
        workflowId: "heal-deduped",
      });
      expect(notifyProposal).not.toHaveBeenCalled();
      expect(expireProposal).not.toHaveBeenCalled();
    });
  }, 120_000);

  it("still waits when NOTIFYING fails — the proposal stands on its own", async () => {
    // A proposal nobody was told about is still in the inbox. Discarding it because Slack was
    // down would throw away a generated fix the tenant already paid for.
    notifyProposal.mockRejectedValue(new Error("slack is down"));
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(healRun, {
        args: [INPUT],
        taskQueue: TASK_QUEUE,
        workflowId: "heal-notify-fails",
      });
      await handle.result();
      // It reached the wait and timed out normally, rather than dying at the notify.
      expect(expireProposal).toHaveBeenCalledWith({ proposalId: "p-1" });
    });
  }, 120_000);

  it("a REJECTED decision also closes it without expiring", async () => {
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(healRun, {
        args: [INPUT],
        taskQueue: TASK_QUEUE,
        workflowId: "heal-rejected",
      });
      await env.sleep("1 minute");
      await handle.signal(healDecisionSignal, { approved: false, by: "ops" });
      await handle.result();
      expect(expireProposal).not.toHaveBeenCalled();
    });
  }, 120_000);
});
