import * as path from "node:path";
import { getInstallationToken } from "@naary/connections";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TASK_QUEUE, stateQuery } from "@naary/contracts";
import {
  type GraphDef,
  pickConnectionTestAction,
  planIntegrationCall,
} from "@naary/dsl";
import { MemoryObjectStore, __setObjectStore } from "@naary/storage";
import * as activities from "../src/temporal/activities";
import { runGraph } from "../src/temporal/workflows";
import { createLocalTestEnv } from "./local-test-env";

/**
 * LIVE end-to-end for the GitHub-App auth path (distinct from the PAT path proven in
 * github-agent.live). A GitHub App "bot" opens and comments on an issue:
 *
 *   webhookTrigger → integration(github.create_issue) → integration(github.comment_issue) → end
 *
 * The point is the CREDENTIAL path: instead of a static PAT, every call authenticates with a
 * freshly-minted INSTALLATION token — the real flow signs an RS256 App JWT, exchanges it at
 * POST /app/installations/{id}/access_tokens, and uses the returned short-lived token. A 201 back
 * from GitHub is proof the whole mint→use chain worked.
 *
 * SKIPPED unless all are set (use a THROWAWAY repo the App is installed on):
 *   GITHUB_APP_ID               the App's id
 *   GITHUB_APP_PRIVATE_KEY      the App's PEM (real newlines or \n-escaped)
 *   GITHUB_APP_INSTALLATION_ID  the installation id on the test repo
 *   GITHUB_TEST_REPO            "owner/repo" the App is installed on
 *
 * Run: export those, then `pnpm test:live` (or `... github-app.live`).
 *
 * REAL vs seamed: the interpreter, both integration activities, the real egress guard, AND the real
 * App-JWT → installation-token mint (@naary/connections getInstallationToken, which reads the App
 * config from env) all run. Only __httpDeps.resolveAuthHeader is swapped — to inject that minted
 * token as the Authorization header (the exact thing the github_app connection auth-mode does),
 * so we need no seeded connection row. Issues are closed in the cleanup sweep.
 */

const WORKFLOWS_PATH = path.join(__dirname, "../src/temporal/workflows.ts");

const APP_ID = process.env.GITHUB_APP_ID;
const APP_KEY = process.env.GITHUB_APP_PRIVATE_KEY;
const INSTALL_ID = process.env.GITHUB_APP_INSTALLATION_ID;
const GH_REPO = process.env.GITHUB_TEST_REPO;
const LIVE = Boolean(APP_ID && APP_KEY && INSTALL_ID && GH_REPO);

const [OWNER, REPO] = (GH_REPO ?? "/").split("/");
const ISSUE_TITLE = `naary-e2e GitHub App test (${`${OWNER}-${REPO}`.replace(
  /[^a-z0-9-]/gi,
  "-",
)})`;

let env: TestWorkflowEnvironment;

/** Mint an installation token (cached) — used by the auth seam AND cleanup. */
async function appToken(): Promise<string> {
  return getInstallationToken(INSTALL_ID as string);
}

/** Close every still-open marker issue (this run's + any prior-run leak), authed as the App. */
async function sweepTestIssues(): Promise<void> {
  if (!LIVE) return;
  try {
    const token = await appToken();
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    const res = await fetch(
      `https://api.github.com/repos/${OWNER}/${REPO}/issues?state=open&per_page=100`,
      { headers },
    );
    if (!res.ok) return;
    const issues = (await res.json()) as {
      number: number;
      title: string;
      pull_request?: unknown;
    }[];
    for (const iss of issues) {
      if (!iss.pull_request && iss.title === ISSUE_TITLE) {
        await fetch(
          `https://api.github.com/repos/${OWNER}/${REPO}/issues/${iss.number}`,
          {
            method: "PATCH",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({ state: "closed" }),
          },
        );
      }
    }
  } catch {
    // best-effort
  }
}

describe.skipIf(!LIVE)(
  "LIVE GitHub App — installation-token mint → create/comment",
  () => {
    beforeAll(async () => {
      env = await createLocalTestEnv();
      __setObjectStore(new MemoryObjectStore());

      // Auth seam only: every integration call gets a freshly-minted App installation token. The mint
      // itself (RS256 JWT → access_tokens exchange) is the REAL @naary/connections path, reading the
      // GITHUB_APP_* env config. Egress + the integration activities are untouched.
      activities.__httpDeps.resolveAuthHeader = (async () => ({
        Authorization: `Bearer ${await appToken()}`,
      })) as never;
    }, 120_000);

    afterAll(async () => {
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
          recordExecution: async () => undefined,
          setExecutionStatus: async () => undefined,
          loadVariables: async () => ({}),
        },
      });
    }

    it("opens an issue authed as the GitHub App installation token", async () => {
      // create_issue alone proves the whole auth chain (App JWT → installation-token mint →
      // authenticated write). We deliberately DON'T also comment: that would couple the test to the
      // App installation's exact per-resource permission set (issue-comment write), which is the
      // operator's config, not the auth mechanism under test. (A comment attempt with a
      // create-but-not-comment installation returns 403 "Resource not accessible by integration".)
      const graph: GraphDef = {
        startNodeId: "hook",
        nodes: [
          { id: "hook", type: "webhookTrigger", config: {} as never },
          {
            id: "createIssue",
            type: "integration",
            config: {
              provider: "github",
              action: "create_issue",
              connectionId: "gh-app-live",
              fields: {
                owner: OWNER,
                repo: REPO,
                title: ISSUE_TITLE,
                body: "Opened by a GitHub App installation token (naary end-to-end test). Safe to close.",
              },
            },
          },
          { id: "end", type: "end" },
        ],
        edges: [
          { from: "hook", to: "createIssue" },
          { from: "createIssue", to: "end" },
        ],
      };

      const worker = await makeWorker();
      await worker.runUntil(async () => {
        const handle = await env.client.workflow.start(runGraph, {
          args: [graph, { event: "e2e" }, { tenantId: "t-live-gh-app" }],
          taskQueue: TASK_QUEUE,
          workflowId: `live-github-app-${OWNER}-${REPO}`.replace(
            /[^a-zA-Z0-9-]/g,
            "-",
          ),
        });
        const result = await handle.result();
        expect(result.status).toBe("completed");

        const final = await handle.query(stateQuery);
        // A 201 back proves the App-JWT → installation-token mint → authenticated write all worked.
        const created = final.ctx.createIssue as {
          httpStatus: number;
          body: { number: number };
        };
        expect(created.httpStatus).toBe(201);
        expect(typeof created.body.number).toBe("number");
      });
    });
  },
);

/**
 * LIVE proof for the #835 credential probe, and specifically for why `probe.authModes` exists.
 *
 * The dry run's third layer asks GitHub "is this token alive?" without running anything. Which
 * endpoint is safe to ask depends on the CONNECTION KIND, and the two are mutually exclusive:
 *
 *   PAT / OAuth token          → GET /user                     200 … /installation/repositories 403
 *   App installation token     → GET /installation/repositories 200 … /user                     403
 *
 * Probing an App connection with `/user` would therefore report a perfectly good connection as
 * broken — the one outcome worse than reporting nothing at all. This asserts BOTH directions
 * against the real api.github.com, so the day GitHub changes its mind we hear it from a test rather
 * than from a user whose working connection went red.
 *
 * Read-only: two GETs, no writes, nothing to clean up. Needs the App vars above plus
 * GITHUB_TEST_TOKEN for the PAT half.
 */
const PAT = process.env.GITHUB_TEST_TOKEN;

describe.skipIf(!LIVE || !PAT)(
  "LIVE GitHub — the credential probe is the right endpoint per auth mode (#835)",
  () => {
    /** The catalog's probe for this auth mode, issued exactly as the connection test issues it. */
    async function probeStatus(
      authMode: string,
      token: string,
    ): Promise<{ action: string; status: number }> {
      const probe = pickConnectionTestAction("github", { authMode });
      if (probe.kind !== "read")
        throw new Error(`github/${authMode} has no probe: ${probe.reason}`);
      const plan = planIntegrationCall({
        provider: "github",
        action: probe.action,
        fields: {},
        baseUrl: "https://api.github.com",
        authHeaders: { Authorization: `Bearer ${token}` },
        authMode,
      });
      const res = await fetch(plan.url, {
        method: plan.method,
        headers: plan.headers,
      });
      return { action: probe.action, status: res.status };
    }

    it("a PAT connection is probed with GET /user, and 200s", async () => {
      const out = await probeStatus("pat", PAT as string);
      expect(out.action).toBe("get_authenticated_user");
      expect(out.status).toBe(200);
    }, 30_000);

    it("a GitHub App connection is probed with GET /installation/repositories, and 200s", async () => {
      const out = await probeStatus("github_app", await appToken());
      expect(out.action).toBe("list_installation_repositories");
      expect(out.status).toBe(200);
    }, 60_000);

    it("and the endpoints really are exclusive — each rejects the other's token", async () => {
      // The load-bearing half: if `/user` ever started answering an installation token, the
      // authModes split would be dead weight nobody would notice. If it keeps 4xx-ing, a single
      // shared probe would keep being wrong, which is why this is asserted rather than assumed.
      const headers = {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      };
      const appRes = await fetch("https://api.github.com/user", {
        headers: { ...headers, Authorization: `Bearer ${await appToken()}` },
      });
      expect(appRes.status).toBeGreaterThanOrEqual(400);

      const patRes = await fetch(
        "https://api.github.com/installation/repositories",
        { headers: { ...headers, Authorization: `Bearer ${PAT as string}` } },
      );
      expect(patRes.status).toBeGreaterThanOrEqual(400);
    }, 60_000);
  },
);
