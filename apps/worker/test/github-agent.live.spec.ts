import * as path from "node:path";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TASK_QUEUE, stateQuery } from "@naary/contracts";
import type { GraphDef } from "@naary/dsl";
import { MemoryObjectStore, __setObjectStore } from "@naary/storage";
import * as activities from "../src/temporal/activities";
import { runGraph } from "../src/temporal/workflows";
import { createLocalTestEnv } from "./local-test-env";

/**
 * LIVE end-to-end: a REAL multi-node workflow through the REAL Temporal interpreter against the
 * REAL GitHub API and the REAL Anthropic API. Proves the composed path the product actually sells —
 *
 *   start → integration(github.create_issue) → agent(Claude triage) → integration(github.comment_issue)
 *
 * i.e. "a GitHub node opens an issue, an agent triages it, a GitHub node comments the verdict."
 *
 * SKIPPED unless all three env vars are set, so a normal checkout / CI runs nothing here:
 *   GITHUB_TEST_TOKEN  a PAT (or fine-grained token) with issues:write on the test repo
 *   GITHUB_TEST_REPO   "owner/repo" of a THROWAWAY repo you own (this test opens + closes issues in it)
 *   ANTHROPIC_TEST_KEY a real Anthropic API key (this test makes ONE small paid Haiku call)
 *
 * Run: export the three vars, then `pnpm test:live` (or `vitest run --config vitest.live.config.ts
 * github-agent.live`).
 *
 * What's REAL vs seamed: the interpreter, both integration activities, the real `safeFetch` egress
 * guard (api.github.com is public → it passes untouched), and the real Anthropic model call all run
 * for real. Only two seams are swapped, and ONLY to supply credentials without a seeded encrypted DB
 * connection (the decrypt path is unit-tested elsewhere):
 *   - __httpDeps.resolveAuthHeader → returns `Bearer <GITHUB_TEST_TOKEN>` (the connection's token).
 *   - __agentDeps.getCredentials → hands the agent activity the ANTHROPIC_TEST_KEY.
 * Billing sinks (getBudget/recordUsage/getDefaultEnvId) are stubbed so the REAL model call isn't
 * gated on billing wiring — but we still assert the agent reported a real, non-zero cost.
 *
 * Cleanup: the created issue is CLOSED in `finally` (GitHub has no delete-issue API) via a direct
 * authenticated PATCH, whether the workflow passed or failed.
 */

const WORKFLOWS_PATH = path.join(__dirname, "../src/temporal/workflows.ts");

const GH_TOKEN = process.env.GITHUB_TEST_TOKEN;
const GH_REPO = process.env.GITHUB_TEST_REPO; // "owner/repo"
const ANTHROPIC_KEY = process.env.ANTHROPIC_TEST_KEY;
const LIVE = Boolean(GH_TOKEN && GH_REPO && ANTHROPIC_KEY);

const [OWNER, REPO] = (GH_REPO ?? "/").split("/");

// Every issue this suite opens carries this exact title, so cleanup can find and close its own
// leaks by title — even ones from an EARLIER run that failed downstream (e.g. the agent 401'd)
// before the issue number could be captured. Kept identical across runs on purpose.
const ISSUE_TITLE = `naary-e2e live test (${`${OWNER}-${REPO}`.replace(/[^a-z0-9-]/gi, "-")})`;

const GH_HEADERS = {
  Authorization: `Bearer ${GH_TOKEN}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};

let env: TestWorkflowEnvironment;

/** Directly close an issue (no catalog action exists for it). Best-effort. */
async function closeIssue(issueNumber: number): Promise<void> {
  try {
    await fetch(
      `https://api.github.com/repos/${OWNER}/${REPO}/issues/${issueNumber}`,
      {
        method: "PATCH",
        headers: { ...GH_HEADERS, "content-type": "application/json" },
        body: JSON.stringify({ state: "closed" }),
      },
    );
  } catch {
    // Cleanup is best-effort — a leaked open issue in a throwaway repo is not a test failure.
  }
}

/**
 * Close EVERY still-open issue this suite opened, matched by its exact marker title. Self-healing:
 * recovers this run's issue even when the workflow failed after create_issue (so we never leak),
 * and sweeps up any leak from a prior failed run. GitHub has no delete-issue API, so "closed" is
 * the terminal state we can reach.
 */
async function sweepTestIssues(): Promise<void> {
  if (!LIVE) return;
  try {
    const res = await fetch(
      `https://api.github.com/repos/${OWNER}/${REPO}/issues?state=open&per_page=100`,
      { headers: GH_HEADERS },
    );
    if (!res.ok) return;
    const issues = (await res.json()) as {
      number: number;
      title: string;
      pull_request?: unknown;
    }[];
    for (const iss of issues) {
      // Skip PRs (the issues endpoint returns them too) and non-marker issues.
      if (!iss.pull_request && iss.title === ISSUE_TITLE) {
        await closeIssue(iss.number);
      }
    }
  } catch {
    // best-effort
  }
}

describe.skipIf(!LIVE)(
  "LIVE github → agent → github (real interpreter, real APIs)",
  () => {
    beforeAll(async () => {
      env = await createLocalTestEnv();
      __setObjectStore(new MemoryObjectStore());

      // --- Credential seams (the ONLY thing swapped) ---
      // GitHub: hand every integration call this repo's real token as the Authorization header.
      // Egress stays REAL — api.github.com is public and passes the SSRF guard untouched.
      activities.__httpDeps.resolveAuthHeader = (async () => ({
        Authorization: `Bearer ${GH_TOKEN}`,
      })) as never;

      // Anthropic: give the agent activity the real BYOK key; neutralize the billing sinks so the
      // real model call isn't gated on budget/usage wiring (we still assert a real cost below).
      activities.__agentDeps.getCredentials = (() => ({
        getDecryptedKey: async () => ANTHROPIC_KEY as string,
      })) as never;
      activities.__agentDeps.getDefaultEnvId = (async () =>
        "env-live") as never;
      activities.__agentDeps.getBudget = (async () => null) as never;
      activities.__agentDeps.recordUsage = (async () => undefined) as never;
    }, 120_000);

    afterAll(async () => {
      // Sweep any still-open marker issue (this run's, plus any prior-run leak) before teardown.
      await sweepTestIssues();
      await env?.teardown();
    });

    function makeWorker(): Promise<Worker> {
      return Worker.create({
        connection: env.nativeConnection,
        taskQueue: TASK_QUEUE,
        workflowsPath: WORKFLOWS_PATH,
        activities: {
          ...activities,
          // The control-plane sinks aren't under test here.
          recordExecution: async () => undefined,
          setExecutionStatus: async () => undefined,
          loadVariables: async () => ({}),
        },
      });
    }

    it("opens an issue, an agent triages it, and a second node comments the verdict", async () => {
      const title = ISSUE_TITLE;
      const graph: GraphDef = {
        startNodeId: "start",
        nodes: [
          { id: "start", type: "start" },
          {
            id: "createIssue",
            type: "integration",
            config: {
              provider: "github",
              action: "create_issue",
              connectionId: "gh-live",
              fields: {
                owner: OWNER,
                repo: REPO,
                title,
                body: "Automated end-to-end test issue. The customer reports the export button on the billing page returns a 500 error. Safe to close.",
              },
            },
          },
          {
            id: "triage",
            type: "agent",
            config: {
              provider: "anthropic",
              // Cheapest current model — one tiny structured call.
              model: "claude-haiku-4-5-20251001",
              systemPrompt:
                "You are a support triage bot. Categorize the following GitHub issue and rate its " +
                'urgency from 1 (trivial) to 5 (critical). Issue title: "{{ createIssue.body.title }}". ' +
                'Issue body: "{{ createIssue.body.body }}". Respond ONLY with the structured output.',
            },
          },
          {
            id: "comment",
            type: "integration",
            config: {
              provider: "github",
              action: "comment_issue",
              connectionId: "gh-live",
              fields: {
                owner: OWNER,
                repo: REPO,
                issueNumber: "{{ createIssue.body.number }}",
                body: "🤖 naary automated triage — category: **{{ triage.output.category }}**, urgency: **{{ triage.output.urgency }}**/5. (end-to-end test comment)",
              },
            },
          },
          { id: "end", type: "end" },
        ],
        edges: [
          { from: "start", to: "createIssue" },
          { from: "createIssue", to: "triage" },
          { from: "triage", to: "comment" },
          { from: "comment", to: "end" },
        ],
      };

      let issueNumber: number | undefined;
      const worker = await makeWorker();
      try {
        await worker.runUntil(async () => {
          const handle = await env.client.workflow.start(runGraph, {
            args: [graph, { instruction: "triage" }, { tenantId: "t-live-gh" }],
            taskQueue: TASK_QUEUE,
            workflowId: `live-github-agent-${OWNER}-${REPO}`.replace(
              /[^a-zA-Z0-9-]/g,
              "-",
            ),
          });
          const result = await handle.result();
          expect(result.status).toBe("completed");

          const final = await handle.query(stateQuery);

          // 1) The GitHub node really opened an issue.
          const created = final.ctx.createIssue as {
            httpStatus: number;
            body: { number: number; html_url: string; title: string };
          };
          expect(created.httpStatus).toBe(201);
          expect(typeof created.body.number).toBe("number");
          expect(created.body.html_url).toContain(`${OWNER}/${REPO}`);
          issueNumber = created.body.number;

          // 2) The REAL Claude agent produced structured output and a real, non-zero cost.
          const triage = final.ctx.triage as {
            output: { category: unknown; urgency: unknown };
            model: string;
            costUsd: number;
          };
          expect(typeof triage.output.category).toBe("string");
          expect(typeof triage.output.urgency).toBe("number");
          expect(triage.costUsd).toBeGreaterThan(0); // billing fail-safe: never free
          expect(triage.model).toContain("haiku");

          // 3) The second GitHub node really commented the agent's verdict onto the issue.
          const comment = final.ctx.comment as { httpStatus: number };
          expect(comment.httpStatus).toBe(201);
        });
      } finally {
        if (issueNumber !== undefined) await closeIssue(issueNumber);
      }
    });
  },
);
