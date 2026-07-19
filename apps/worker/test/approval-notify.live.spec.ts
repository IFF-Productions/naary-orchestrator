import * as path from "node:path";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TASK_QUEUE, approvalSignal, stateQuery } from "@naary/contracts";
import type { GraphDef } from "@naary/dsl";
import { MemoryObjectStore, __setObjectStore } from "@naary/storage";
import type { NotificationChannelRow } from "../src/temporal/activities/notifications";
import * as activities from "../src/temporal/activities";
import { runGraph } from "../src/temporal/workflows";
import { createLocalTestEnv } from "./local-test-env";

/**
 * LIVE end-to-end for a REAL user workflow: human-in-the-loop expense approval that PAGES a real
 * Slack and/or Microsoft Teams channel.
 *
 *   formTrigger(expense) → humanApproval → end
 *
 * When the run hits the approval node it POSTs a REAL Slack Block Kit message / Teams Adaptive Card
 * (Approve / Reject / View-run buttons) to your webhook, then pauses on a Signal until a decision
 * arrives — exactly the durable HITL pause the product sells. We approve via the signal and assert
 * the run resumes AND that each configured webhook returned a real 2xx.
 *
 * SKIPPED unless at least one of SLACK_TEST_WEBHOOK_URL / TEAMS_TEST_WEBHOOK_URL is set — use a
 * THROWAWAY test channel (a webhook post can't be un-sent). Run: export the webhook(s), then
 * `pnpm test:live` (or `... approval-notify.live`).
 *
 * REAL vs seamed: the interpreter, the Signal + condition() pause, the real notification payload
 * builder, the real safeFetch egress guard, and the real POST all run. Only the channel LIST is
 * injected (__notifyDeps.readChannels → the env webhooks) so we need no seeded DB; __notifyDeps.fetch
 * stays real, wrapped only to record the response status for the assertion.
 */

const WORKFLOWS_PATH = path.join(__dirname, "../src/temporal/workflows.ts");

const SLACK_URL = process.env.SLACK_TEST_WEBHOOK_URL;
const TEAMS_URL = process.env.TEAMS_TEST_WEBHOOK_URL;
const LIVE = Boolean(SLACK_URL || TEAMS_URL);

let env: TestWorkflowEnvironment;
const posts: { type: string; status: number }[] = [];
const savedEnv: Record<string, string | undefined> = {};

describe.skipIf(!LIVE)("LIVE humanApproval → real Slack/Teams page", () => {
  beforeAll(async () => {
    // Approval deep-links are HMAC-signed over ENCRYPTION_KEY and built against APP_BASE_URL — set
    // both so the Block Kit / Adaptive Card buttons carry real (if non-routable) URLs.
    for (const k of ["ENCRYPTION_KEY", "APP_BASE_URL"])
      savedEnv[k] = process.env[k];
    process.env.ENCRYPTION_KEY ||= "0".repeat(64);
    process.env.APP_BASE_URL ||= "https://app.naary-e2e.test";

    env = await createLocalTestEnv();
    __setObjectStore(new MemoryObjectStore());

    const channels: NotificationChannelRow[] = [];
    if (SLACK_URL)
      channels.push({
        type: "slack",
        webhookUrl: SLACK_URL,
        onApprovalPending: true,
        onRunFailed: true,
      });
    if (TEAMS_URL)
      channels.push({
        type: "teams",
        webhookUrl: TEAMS_URL,
        onApprovalPending: true,
        onRunFailed: true,
      });

    // Channel-list seam only: return the env webhooks instead of reading the DB.
    activities.__notifyDeps.readChannels = (async () => channels) as never;
    // Keep the REAL guarded fetch — just record each response status for the assertion.
    const realFetch = activities.__notifyDeps.fetch;
    activities.__notifyDeps.fetch = (async (
      url: string,
      init?: RequestInit,
    ) => {
      const res = await realFetch(url, init);
      const type = url === TEAMS_URL ? "teams" : "slack";
      posts.push({ type, status: (res as Response).status });
      return res;
    }) as never;
  }, 120_000);

  afterAll(async () => {
    await env?.teardown();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function makeWorker(): Promise<Worker> {
    return Worker.create({
      connection: env.nativeConnection,
      taskQueue: TASK_QUEUE,
      workflowsPath: WORKFLOWS_PATH,
      activities: {
        ...activities,
        recordExecution: async () => undefined,
        setExecutionStatus: async () => undefined,
        loadVariables: async () => ({}),
      },
    });
  }

  it("pages the channel(s) on pause and resumes when approved", async () => {
    const graph: GraphDef = {
      startNodeId: "expense",
      nodes: [
        { id: "expense", type: "formTrigger", config: {} as never },
        {
          id: "approve",
          type: "humanApproval",
          config: {
            title: "Expense approval — $420 travel (naary-e2e)",
          } as never,
        },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "expense", to: "approve" },
        { from: "approve", to: "end" },
      ],
    };

    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [
          graph,
          { amount: 420, category: "travel", requestedBy: "dana" },
          { tenantId: "t-live-approve" },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "live-approval-notify",
      });

      // The signal is durable + buffered: the node still POSTs the page when reached, then the
      // condition() sees the decision and resumes — no flaky polling on the pause window.
      await handle.signal(approvalSignal, {
        approved: true,
        comment: "Approved (naary-e2e live test).",
      });

      const result = await handle.result();
      expect(result.status).toBe("completed");

      const final = await handle.query(stateQuery);
      const decision = final.ctx.approve as { approved: boolean };
      expect(decision.approved).toBe(true);

      // Each configured channel received a real POST that the webhook accepted (2xx).
      if (SLACK_URL) {
        const slack = posts.find((p) => p.type === "slack");
        expect(slack, "expected a Slack POST").toBeDefined();
        expect(slack!.status).toBeGreaterThanOrEqual(200);
        expect(slack!.status).toBeLessThan(300);
      }
      if (TEAMS_URL) {
        const teams = posts.find((p) => p.type === "teams");
        expect(teams, "expected a Teams POST").toBeDefined();
        expect(teams!.status).toBeGreaterThanOrEqual(200);
        expect(teams!.status).toBeLessThan(300);
      }
    });
  });
});
