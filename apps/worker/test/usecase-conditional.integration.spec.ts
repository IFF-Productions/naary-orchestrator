import { type Server, createServer } from "node:http";
import { type AddressInfo } from "node:net";
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
 * A CONDITIONAL multi-service use case, end to end through the real interpreter: call a real HTTP API,
 * then BRANCH on its real status code to take one of two REAL Postgres write paths, then read back.
 * This joins the two things per-node integration + routing tests cover separately — real services AND
 * conditional/multi-path routing — into one flow: the branch a run takes is decided by a genuine HTTP
 * response and proven by which real row landed in Postgres.
 *
 * Real Postgres (testcontainers) + real in-process HTTP server; only the SSRF host-guard seams are
 * relaxed (unit-tested elsewhere). A >=400 response is NOT an activity failure — httpRequest returns
 * `{status,...}` and the graph branches on `http.status` — so this stays deterministic and fast.
 * Docker-gated: `pnpm test:integration`.
 */

const WORKFLOWS_PATH = path.join(__dirname, "../src/temporal/workflows.ts");

let env: TestWorkflowEnvironment;
let container: Awaited<ReturnType<PostgreSqlContainer["start"]>>;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  // Real HTTP API: /ok → 200 (a record to persist); /down → 503 (the failure branch).
  server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/ok") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: 1, tier: "gold" }));
      return;
    }
    if (req.method === "GET" && req.url === "/down") {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unavailable" }));
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

  activities.__sqlDeps.resolveDbConnection = async () => ({
    engine: "postgres",
    dsn: container.getConnectionUri(),
  });
  activities.__sqlDeps.assertHostPublic = async () => undefined;
  activities.__httpDeps.assertEgressAllowed = (async (u: string) =>
    new URL(u)) as never;
  activities.__httpDeps.fetch = ((url: string | URL, init?: RequestInit) =>
    globalThis.fetch(String(url), init as RequestInit)) as never;
}, 180_000);

afterAll(async () => {
  await env?.teardown();
  await container?.stop();
  // Resolve even if `server` was never assigned (a beforeAll failure before listen) — otherwise
  // `server?.close(...)` is skipped and the Promise never settles, turning a setup failure into a hang.
  await new Promise<void>((resolve) =>
    server ? server.close(() => resolve()) : resolve(),
  );
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

/**
 * start → http(GET `path`) → create `table` → branch on the REAL http.status:
 *   status < 400 → insert 'ok'  ·  status >= 400 → insert 'down'  → select → end.
 * Each run uses its own table so the two branches assert in isolation against one container.
 */
function conditionalGraph(pathName: string, table: string): GraphDef {
  return {
    startNodeId: "start",
    nodes: [
      { id: "start", type: "start" },
      {
        id: "http",
        type: "httpRequest",
        config: { method: "GET", url: `${baseUrl}${pathName}` },
      },
      {
        id: "create",
        type: "sqlExec",
        config: {
          connectionId: "c",
          sql: `create table ${table} (outcome text)`,
          params: [],
        },
      },
      {
        id: "insOk",
        type: "sqlExec",
        config: {
          connectionId: "c",
          sql: `insert into ${table} (outcome) values ('ok')`,
          params: [],
        },
      },
      {
        id: "insDown",
        type: "sqlExec",
        config: {
          connectionId: "c",
          sql: `insert into ${table} (outcome) values ('down')`,
          params: [],
        },
      },
      {
        id: "q",
        type: "sqlQuery",
        config: {
          connectionId: "c",
          sql: `select outcome from ${table}`,
          params: [],
        },
      },
      { id: "end", type: "end" },
    ],
    edges: [
      { from: "start", to: "http" },
      { from: "http", to: "create" },
      // The branch: which insert runs is decided by the REAL HTTP status.
      {
        from: "create",
        to: "insOk",
        condition: { path: "http.status", op: "lt", value: 400 },
      },
      {
        from: "create",
        to: "insDown",
        condition: { path: "http.status", op: "gte", value: 400 },
      },
      { from: "insOk", to: "q" },
      { from: "insDown", to: "q" },
      { from: "q", to: "end" },
    ],
  };
}

describe("use case: branch on a REAL HTTP status → REAL Postgres write path", () => {
  it("2xx takes the success branch → writes 'ok' (and never the failure branch)", async () => {
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [
          conditionalGraph("/ok", "cond_ok"),
          {},
          { tenantId: "t-cond-ok" },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-cond-ok",
      });
      expect((await handle.result()).status).toBe("completed");
      const final = await handle.query(stateQuery);
      expect((final.ctx.http as { status: number }).status).toBe(200);
      expect(final.ctx.insOk).toEqual({ rowsAffected: 1 });
      expect(final.ctx.insDown).toBeUndefined(); // failure branch never ran
      expect(final.ctx.q).toEqual({
        rows: [{ outcome: "ok" }],
        rowCount: 1,
      });
    });
  });

  it("a 503 takes the failure branch → writes 'down' (and never the success branch)", async () => {
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [
          conditionalGraph("/down", "cond_down"),
          {},
          { tenantId: "t-cond-down" },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-cond-down",
      });
      expect((await handle.result()).status).toBe("completed");
      const final = await handle.query(stateQuery);
      expect((final.ctx.http as { status: number }).status).toBe(503);
      expect(final.ctx.insDown).toEqual({ rowsAffected: 1 });
      expect(final.ctx.insOk).toBeUndefined(); // success branch never ran
      expect(final.ctx.q).toEqual({
        rows: [{ outcome: "down" }],
        rowCount: 1,
      });
    });
  });
});
