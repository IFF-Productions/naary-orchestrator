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
 * LIVE end-to-end for the codeAgent node (headless Claude Code, `claude -p`) through the REAL
 * interpreter and the REAL `claude` binary — READ-ONLY / plan mode (Slice 1). Proves the node
 * actually shells out to the coding CLI, gets a real plan back, and bills a real, non-zero cost.
 *
 *   start → codeAgent(tool: claude, mode: read) → end
 *
 * SKIPPED unless CLAUDE_CODE_TEST_TOKEN is set (and the `claude` CLI is on PATH), so a normal
 * checkout / CI runs nothing here. The token may be EITHER a Claude Code subscription OAuth token
 * (`sk-ant-oat…`, billed to the subscription) OR a plain Anthropic API key (`sk-ant-api…`); the
 * driver auto-routes it to CLAUDE_CODE_OAUTH_TOKEN vs ANTHROPIC_API_KEY by prefix.
 *
 *   export CLAUDE_CODE_TEST_TOKEN=sk-ant-oat...   # or an sk-ant-api... key
 *   pnpm test:live   # (or: vitest run --config vitest.live.config.ts code-agent.live)
 *
 * What's REAL vs seamed: the interpreter, the subprocess exec, and the CLI call all run for real.
 * Only the credential source + usage sink are swapped (getCredentials → the env token; getDefaultEnvId
 * / recordUsage stubbed so the real CLI call isn't gated on DB/billing wiring). We still assert a
 * real, non-zero cost (Tier-1 §6: a code-agent call is never silently free).
 *
 * Read-only means NO writes and NO repo — the CLI runs in-worker in plan mode with a Read/Grep/Glob
 * toolset (no Bash), so this test creates no external side effects and needs no cleanup.
 */

const WORKFLOWS_PATH = path.join(__dirname, "../src/temporal/workflows.ts");

const CC_TOKEN = process.env.CLAUDE_CODE_TEST_TOKEN;
const LIVE = Boolean(CC_TOKEN);

let env: TestWorkflowEnvironment;

describe.skipIf(!LIVE)("LIVE codeAgent — real `claude -p` (read-only)", () => {
  beforeAll(async () => {
    env = await createLocalTestEnv();
    __setObjectStore(new MemoryObjectStore());

    // Credential seam ONLY: hand the activity the real Claude Code token; neutralize the billing
    // sinks so the real subprocess isn't gated on DB/budget wiring (cost is still asserted below).
    activities.__codeAgentDeps.getCredentials = (() => ({
      getDecryptedKey: async () => CC_TOKEN as string,
    })) as never;
    activities.__codeAgentDeps.getDefaultEnvId = (async () =>
      "env-live") as never;
    activities.__codeAgentDeps.recordUsage = (async () => undefined) as never;
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

  it("runs the coding CLI in plan mode and returns a real plan + non-zero cost", async () => {
    const graph: GraphDef = {
      startNodeId: "start",
      nodes: [
        { id: "start", type: "start" },
        {
          id: "code",
          type: "codeAgent",
          config: {
            tool: "claude",
            mode: "read",
            // A pure-reasoning prompt: no file access needed, so plan mode returns quickly and
            // deterministically enough to assert on structure (not exact wording).
            prompt:
              "In one short sentence, explain what the JavaScript Array.prototype.map method does. Do not use any tools.",
            // Keep the subprocess bounded so a hung CLI fails the test instead of the suite timeout.
            timeoutMs: 120_000,
          },
        },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "start", to: "code" },
        { from: "code", to: "end" },
      ],
    };

    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [graph, { instruction: "explain" }, { tenantId: "t-live-cc" }],
        taskQueue: TASK_QUEUE,
        workflowId: "live-code-agent-read",
      });
      const result = await handle.result();
      expect(result.status).toBe("completed");

      const final = await handle.query(stateQuery);
      const out = final.ctx.code as {
        output: { result: string; tool: string };
        costUsd: number;
      };

      // The CLI ran and returned a real, non-empty plan/summary.
      expect(out.output.tool).toBe("claude");
      expect(typeof out.output.result).toBe("string");
      expect(out.output.result.length).toBeGreaterThan(0);
      // Tier-1 §6 billing fail-safe: a code-agent call is never silently free.
      expect(out.costUsd).toBeGreaterThan(0);
    });
  });
});
