import * as path from "node:path";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import nodemailer from "nodemailer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TASK_QUEUE, stateQuery } from "@naary/contracts";
import type { GraphDef } from "@naary/dsl";
import { MemoryObjectStore, __setObjectStore } from "@naary/storage";
import * as activities from "../src/temporal/activities";
import { runGraph } from "../src/temporal/workflows";
import { createLocalTestEnv } from "./local-test-env";

/**
 * LIVE end-to-end for a REAL user workflow: a contact-form auto-responder.
 *
 *   formTrigger(intake) → agent(draft a reply) → sendEmail(SMTP) → end
 *
 * A form submission comes in, a real Claude agent drafts a personalized reply, and the sendEmail
 * node delivers it over a REAL SMTP transport. No user SMTP creds needed: we provision an Ethereal
 * (https://ethereal.email) TEST account on the fly — a real SMTP server that ACCEPTS + stores mail
 * in a web inbox instead of delivering it, so nothing is actually emailed to anyone. The SMTP host
 * (smtp.ethereal.email) is public, so the activity's real SSRF host-guard passes it untouched.
 *
 * SKIPPED unless ANTHROPIC_TEST_KEY is set (the agent makes one small paid call) AND Ethereal is
 * reachable. Run: export ANTHROPIC_TEST_KEY, then `pnpm test:live` (or `... form-email.live`).
 *
 * REAL vs seamed: the interpreter, the agent's Claude call, the nodemailer transport, the SMTP
 * round-trip, and the SSRF guard all run for real. Only credentials are injected: __emailDeps
 * .resolveSmtpUri → the Ethereal test URI (the "smtp connection"), and __agentDeps.getCredentials
 * → ANTHROPIC_TEST_KEY (billing sinks stubbed; cost still asserted > 0).
 */

const WORKFLOWS_PATH = path.join(__dirname, "../src/temporal/workflows.ts");

const ANTHROPIC_KEY = process.env.ANTHROPIC_TEST_KEY;
const LIVE = Boolean(ANTHROPIC_KEY);

let env: TestWorkflowEnvironment;
let smtpUri: string | undefined;

describe.skipIf(!LIVE)(
  "LIVE form → agent → SMTP (real interpreter, real SMTP)",
  () => {
    beforeAll(async () => {
      // Real Ethereal SMTP account — a genuine server that captures mail in a web inbox.
      const acct = await nodemailer.createTestAccount();
      smtpUri = `smtp://${encodeURIComponent(acct.user)}:${encodeURIComponent(
        acct.pass,
      )}@${acct.smtp.host}:${acct.smtp.port}`;

      env = await createLocalTestEnv();
      __setObjectStore(new MemoryObjectStore());

      // SMTP credential seam: hand the activity the Ethereal URI in place of a stored smtp connection.
      // assertHostPublic + createTransport stay REAL (Ethereal is a public host, real transport).
      activities.__emailDeps.resolveSmtpUri = (async () =>
        smtpUri as string) as never;

      // Anthropic credential seam (as in the other live specs).
      activities.__agentDeps.getCredentials = (() => ({
        getDecryptedKey: async () => ANTHROPIC_KEY as string,
      })) as never;
      activities.__agentDeps.getDefaultEnvId = (async () =>
        "env-live") as never;
      activities.__agentDeps.getBudget = (async () => null) as never;
      activities.__agentDeps.recordUsage = (async () => undefined) as never;
    }, 120_000);

    afterAll(async () => {
      await env?.teardown();
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

    it("drafts a reply to a form submission and delivers it over real SMTP", async () => {
      const graph: GraphDef = {
        startNodeId: "intake",
        nodes: [
          // A hosted contact-form submission: its fields ARE the run input.
          { id: "intake", type: "formTrigger", config: {} as never },
          {
            id: "draft",
            type: "agent",
            config: {
              provider: "anthropic",
              model: "claude-haiku-4-5",
              systemPrompt:
                "Write a short, friendly one-paragraph reply to this contact-form message. " +
                'Name: "{{ intake.name }}". Message: "{{ intake.message }}". ' +
                "Put the reply text in the `reply` field.",
              // Constrain the agent to a reply string so downstream config can thread it.
              outputSchema: {
                type: "object",
                properties: { reply: { type: "string" } },
                required: ["reply"],
                additionalProperties: false,
              },
            },
          },
          {
            id: "send",
            type: "sendEmail",
            config: {
              connectionId: "smtp-live",
              from: "support@naary-e2e.test",
              to: "{{ intake.email }}",
              subject: "Re: your message to naary support",
              text: "{{ draft.output.reply }}",
            },
          },
          { id: "end", type: "end" },
        ],
        edges: [
          { from: "intake", to: "draft" },
          { from: "draft", to: "send" },
          { from: "send", to: "end" },
        ],
      };

      // Simulate the form submission.
      const submission = {
        name: "Dana Rivera",
        email: "dana.rivera@example.com",
        message:
          "Hi — I was double-charged on my last invoice. Can someone take a look?",
      };

      const worker = await makeWorker();
      await worker.runUntil(async () => {
        const handle = await env.client.workflow.start(runGraph, {
          args: [graph, submission, { tenantId: "t-live-mail" }],
          taskQueue: TASK_QUEUE,
          workflowId: "live-form-email",
        });
        const result = await handle.result();
        expect(result.status).toBe("completed");

        const final = await handle.query(stateQuery);

        // The agent produced a real, non-empty reply at a real, non-zero cost.
        const draft = final.ctx.draft as {
          output: { reply: string };
          costUsd: number;
        };
        expect(typeof draft.output.reply).toBe("string");
        expect(draft.output.reply.length).toBeGreaterThan(0);
        expect(draft.costUsd).toBeGreaterThan(0);

        // The SMTP server really accepted the message: the interpreter exposes the transport's
        // messageId on the node output (proof the send round-tripped to Ethereal).
        const send = final.ctx.send as { messageId: string };
        expect(typeof send.messageId).toBe("string");
        expect(send.messageId.length).toBeGreaterThan(0);
      });
    });
  },
);
