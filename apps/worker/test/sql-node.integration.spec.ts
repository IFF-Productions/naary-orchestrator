import * as path from "node:path";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { createLocalTestEnv } from "./local-test-env";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TASK_QUEUE, stateQuery } from "@naary/contracts";
import type { GraphDef } from "@naary/dsl";
import { MemoryObjectStore, __setObjectStore } from "@naary/storage";
import * as activities from "../src/temporal/activities";
import { runGraph } from "../src/temporal/workflows";

/**
 * REAL flow integration: the sqlExec + sqlQuery NODES run through the real Temporal interpreter and
 * the real @naary/sql Postgres adapter against a THROWAWAY Postgres (testcontainers) — no mocked DB.
 * This is the "test the flows against real services" harness: a graph writes and reads real rows.
 *
 * Two seams are relaxed to point the real activities at the container (everything else is real):
 *  - __sqlDeps.resolveDbConnection → the container's DSN (instead of a tenant's stored connection).
 *  - __sqlDeps.assertHostPublic    → no-op: the container is on 127.0.0.1, which the SSRF guard
 *    (rightly) blocks in prod. The guard itself is unit-tested in sql.activity.spec; here we're
 *    proving the query PATH, so we bypass just the host check. getAdapter stays REAL (real queries).
 *
 * Docker-gated, so it lives OUT of the default `pnpm test` (see vitest.integration.config.ts) —
 * run with `pnpm test:integration`.
 */

// Temporal's own bundler (not vitest) processes this path, so it must be a real absolute path.
const WORKFLOWS_PATH = path.join(__dirname, "../src/temporal/workflows.ts");

let env: TestWorkflowEnvironment;
let container: Awaited<ReturnType<PostgreSqlContainer["start"]>>;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  env = await createLocalTestEnv();

  // Claim-check offload store the SQL activities touch for large results (in-memory here).
  __setObjectStore(new MemoryObjectStore());

  // Point the real SQL activities at the container; bypass ONLY the host-public guard.
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

/**
 * Register the REAL activities, but stub the bookkeeping ones that hit the app's Prisma DB
 * (recordExecution / setExecutionStatus / loadVariables) — the run doesn't need them and there's no
 * app DB here. The sqlExec / sqlQuery node activities are the real thing.
 */
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

// start → exec(create) → exec(insert) → query(select) → end. connectionId is a placeholder
// (resolveDbConnection is overridden to the container), params carry the bound insert values.
function sqlFlow(): GraphDef {
  return {
    startNodeId: "start",
    nodes: [
      { id: "start", type: "start" },
      {
        id: "create",
        type: "sqlExec",
        config: {
          connectionId: "c",
          sql: "create table users (id int primary key, email text)",
          params: [],
        },
      },
      {
        id: "insert",
        type: "sqlExec",
        config: {
          connectionId: "c",
          sql: "insert into users (id, email) values ($1, $2), ($3, $4)",
          params: [7, "a@b.co", 8, "c@d.co"],
        },
      },
      {
        id: "q",
        type: "sqlQuery",
        config: {
          connectionId: "c",
          sql: "select id, email from users order by id",
          params: [],
        },
      },
      { id: "end", type: "end" },
    ],
    edges: [
      { from: "start", to: "create" },
      { from: "create", to: "insert" },
      { from: "insert", to: "q" },
      { from: "q", to: "end" },
    ],
  };
}

describe("SQL nodes — real flow against a real Postgres (testcontainers)", () => {
  it("writes rows via sqlExec and reads them back via sqlQuery, end to end", async () => {
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [sqlFlow(), {}, { tenantId: "t-sql-int" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-sql-integration",
      });
      expect((await handle.result()).status).toBe("completed");

      const final = await handle.query(stateQuery);
      // sqlExec output: rows affected by the 2-row insert.
      expect(final.ctx.insert).toEqual({ rowsAffected: 2 });
      // sqlQuery output: the REAL rows the DB returned, in id order.
      expect(final.ctx.q).toEqual({
        rows: [
          { id: 7, email: "a@b.co" },
          { id: 8, email: "c@d.co" },
        ],
        rowCount: 2,
      });
    });
  });
});
