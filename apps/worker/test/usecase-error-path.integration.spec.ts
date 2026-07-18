import * as path from "node:path";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
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
 * FAILURE SEMANTICS against a REAL database, end to end through the real interpreter: a sqlExec that
 * runs bad SQL against a real Postgres actually fails (real pg error, real activity retries), and the
 * interpreter handles it two ways —
 *   1. `onError: "continue"` catches it → `ctx.<node> = { error }` → the flow keeps going and a later
 *      real write + read still succeed;
 *   2. the default (`stop`) → the whole run fails.
 * This proves error handling works with a genuine backing-service failure, not a mocked throw.
 *
 * Real Postgres (testcontainers); only the SSRF host-guard seam is relaxed. Activities retry a bounded
 * 3× (proxies.ts) but the time-skipping test env fast-forwards the backoff, so this stays quick.
 * Docker-gated: `pnpm test:integration`.
 */

const WORKFLOWS_PATH = path.join(__dirname, "../src/temporal/workflows.ts");

let env: TestWorkflowEnvironment;
let container: Awaited<ReturnType<PostgreSqlContainer["start"]>>;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  env = await createLocalTestEnv();
  __setObjectStore(new MemoryObjectStore());

  activities.__sqlDeps.resolveDbConnection = async () => ({
    engine: "postgres",
    dsn: container.getConnectionUri(),
  });
  activities.__sqlDeps.assertHostPublic = async () => undefined;
}, 180_000);

afterAll(async () => {
  await env?.teardown();
  await container?.stop();
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

const exec = (id: string, sql: string, onError?: "continue") => ({
  id,
  type: "sqlExec" as const,
  config: { connectionId: "c", sql, params: [] },
  ...(onError ? { onError } : {}),
});

describe("error path: a REAL SQL failure, handled by the interpreter", () => {
  it("onError:'continue' catches a real pg error → records {error} → the flow keeps going", async () => {
    const graph: GraphDef = {
      startNodeId: "start",
      nodes: [
        { id: "start", type: "start" },
        exec("create", "create table ok_rows (id int)"),
        // Real failure: the relation doesn't exist. Bounded 3× activity retry, then onError catches.
        exec("bad", "insert into no_such_table (id) values (1)", "continue"),
        exec("good", "insert into ok_rows (id) values (42)"),
        {
          id: "q",
          type: "sqlQuery",
          config: {
            connectionId: "c",
            sql: "select id from ok_rows",
            params: [],
          },
        },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "start", to: "create" },
        { from: "create", to: "bad" },
        { from: "bad", to: "good" },
        { from: "good", to: "q" },
        { from: "q", to: "end" },
      ],
    };

    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [graph, {}, { tenantId: "t-err-continue" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-err-continue",
      });
      // The run COMPLETES despite the failed insert (onError:continue).
      expect((await handle.result()).status).toBe("completed");

      const final = await handle.query(stateQuery);
      // The failed node recorded a real pg error, not a thrown run. The message is SANITIZED to the
      // pg SQLSTATE (42P01 = undefined_table) — the genuine failure, without leaking the query/table.
      const bad = final.ctx.bad as { error?: string };
      expect(typeof bad.error).toBe("string");
      expect(bad.error).toMatch(/42P01|SQL write failed/i);
      // The flow kept going: the valid write + read still happened.
      expect(final.ctx.good).toEqual({ rowsAffected: 1 });
      expect(final.ctx.q).toEqual({ rows: [{ id: 42 }], rowCount: 1 });
    });
  });

  it("the default (stop) → a real pg error fails the whole run", async () => {
    const graph: GraphDef = {
      startNodeId: "start",
      nodes: [
        { id: "start", type: "start" },
        exec("create", "create table s_rows (id int)"),
        exec("bad", "insert into still_missing (id) values (1)"), // onError defaults to "stop"
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "start", to: "create" },
        { from: "create", to: "bad" },
        { from: "bad", to: "end" },
      ],
    };

    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [graph, {}, { tenantId: "t-err-stop" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-err-stop",
      });
      // No onError → the failed activity propagates and the workflow fails (result rejects).
      await expect(handle.result()).rejects.toThrow();
    });
  });
});
