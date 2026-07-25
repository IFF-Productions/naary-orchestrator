import { type Server, createServer } from "node:http";
import { type AddressInfo } from "node:net";
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
 * A REALISTIC MULTI-SERVICE USE CASE, end to end through the real interpreter: fetch a record from a
 * real HTTP API, WRITE it to a real Postgres, then READ it back — the httpRequest → sqlExec →
 * sqlQuery nodes all running for real, with the HTTP response DATA flowing into the SQL insert via
 * param bindings. This is the "test actual use cases against real services" harness (a step past the
 * per-node integration tests): it proves the interpreter threads one node's real output into the
 * next node's real call across two different backing services.
 *
 * Real Postgres via testcontainers; real in-process HTTP server; only the SSRF host-guard seams are
 * relaxed so the activities can reach the local services (the guards are unit-tested in
 * sql.activity.spec / http.activity.spec). Everything else — the pg adapter, the fetch, the binding
 * resolution — is the real thing. Docker-gated: `pnpm test:integration`.
 */

const WORKFLOWS_PATH = path.join(__dirname, "../src/temporal/workflows.ts");

let env: TestWorkflowEnvironment;
let container: Awaited<ReturnType<PostgreSqlContainer["start"]>>;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  // Real HTTP API: GET /record → a JSON record we'll persist.
  server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/record") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: 7, email: "a@b.co" }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  env = await createLocalTestEnv();
  __setObjectStore(new MemoryObjectStore());

  // SQL: point the real adapter at the container; bypass only the host-public check.
  activities.__sqlDeps.resolveDbConnection = async () => ({
    engine: "postgres",
    dsn: container.getConnectionUri(),
  });
  activities.__sqlDeps.resolvePinnedHost = async (host: string) => host;

  // HTTP: reach the local server (bypass https/public pre-check + the private-IP transport guard).
  activities.__httpDeps.assertEgressAllowed = (async (u: string) =>
    new URL(u)) as never;
  activities.__httpDeps.fetch = ((url: string | URL, init?: RequestInit) =>
    globalThis.fetch(String(url), init as RequestInit)) as never;
}, 180_000);

afterAll(async () => {
  await env?.teardown();
  await container?.stop();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

function makeWorker(): Promise<Worker> {
  return Worker.create({
    connection: env.nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowsPath: WORKFLOWS_PATH,
    activities: {
      ...activities,
      // No app DB in this worker-side harness — stub the bookkeeping activities. The
      // httpRequest / sqlExec / sqlQuery node activities are the real thing.
      recordExecution: async () => undefined,
      setExecutionStatus: async () => undefined,
      loadVariables: async () => ({}),
    },
  });
}

// start → http(GET /record) → create table → insert (BINDING the http body into $1/$2) → select → end.
function useCaseGraph(): GraphDef {
  return {
    startNodeId: "start",
    nodes: [
      { id: "start", type: "start" },
      {
        id: "http",
        type: "httpRequest",
        config: { method: "GET", url: `${baseUrl}/record` },
      },
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
          sql: "insert into users (id, email) values ($1, $2)",
          params: [],
          // 1-based param positions → bind the REAL http response fields into the write.
          paramBindings: {
            1: { from: "http", path: "body.id" },
            2: { from: "http", path: "body.email" },
          },
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
      { from: "start", to: "http" },
      { from: "http", to: "create" },
      { from: "create", to: "insert" },
      { from: "insert", to: "q" },
      { from: "q", to: "end" },
    ],
  };
}

describe("use case: fetch from a real API → write to real Postgres → read back", () => {
  it("threads the HTTP response into the SQL insert and reads it back, end to end", async () => {
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [useCaseGraph(), {}, { tenantId: "t-usecase" }],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-usecase-http-to-sql",
      });
      expect((await handle.result()).status).toBe("completed");

      const final = await handle.query(stateQuery);
      // The HTTP call really happened.
      expect((final.ctx.http as { status: number }).status).toBe(200);
      // The insert wrote exactly one row (the bound http values).
      expect(final.ctx.insert).toEqual({ rowsAffected: 1 });
      // The query read back the REAL row — proving the http-fetched data reached Postgres.
      expect(final.ctx.q).toEqual({
        rows: [{ id: 7, email: "a@b.co" }],
        rowCount: 1,
      });
    });
  });
});
