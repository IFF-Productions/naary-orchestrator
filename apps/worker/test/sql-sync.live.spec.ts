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
 * LIVE end-to-end for a REAL user workflow: a scheduled job that PERSISTS to and READS BACK from a
 * real Postgres database.
 *
 *   scheduleTrigger → sqlExec(create table) → sqlExec(insert a row) → sqlQuery(read it back) → end
 *
 * Proves the real DB path end-to-end: the write node commits a row and the read node (a real
 * READ-ONLY transaction) sees it — against YOUR database, over a real connection.
 *
 * SKIPPED unless POSTGRES_TEST_DSN is set. Use a THROWAWAY database — the test creates the table
 * `naary_e2e_sync` and DROPs it in cleanup. The DSN host must be PUBLIC: the activity's real SSRF
 * host-guard runs (a managed host like Neon passes; for a purely-local DB, point at 127.0.0.1 is
 * rejected by design — use a reachable host).
 *
 * Run: export POSTGRES_TEST_DSN, then `pnpm test:live` (or `... sql-sync.live`).
 *
 * REAL vs seamed: the interpreter, both SQL activities, the adapter's transaction semantics, and
 * the SSRF host-guard all run. Only the connection→DSN resolution is injected (__sqlDeps
 * .resolveDbConnection → the env DSN) so we need no seeded connection row.
 */

const WORKFLOWS_PATH = path.join(__dirname, "../src/temporal/workflows.ts");
const TABLE = "naary_e2e_sync";

const DSN = process.env.POSTGRES_TEST_DSN;
const LIVE = Boolean(DSN);

let env: TestWorkflowEnvironment;

describe.skipIf(!LIVE)(
  "LIVE sqlExec/sqlQuery — real Postgres round-trip",
  () => {
    beforeAll(async () => {
      env = await createLocalTestEnv();
      __setObjectStore(new MemoryObjectStore());

      // Connection→DSN seam only: both SQL activities run for real against this DSN. assertHostPublic
      // stays REAL (proves a public managed host passes the SSRF guard).
      activities.__sqlDeps.resolveDbConnection = (async () => ({
        engine: "postgres",
        dsn: DSN as string,
      })) as never;
    }, 120_000);

    afterAll(async () => {
      // The table is dropped by the final in-graph sqlExec node (see `dropTbl`), so nothing lingers
      // in the user's DB on a successful run — no external pg client needed here.
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

    it("commits a row via sqlExec and reads it back via sqlQuery", async () => {
      // A unique id per run keeps the insert idempotent-clean (no PK collision across re-runs) —
      // generated OUTSIDE the workflow (deterministic in-workflow) and passed as the run input.
      const rowId = Number(process.hrtime.bigint() % 1_000_000_000n);
      const note = "synced by naary-e2e";

      const graph: GraphDef = {
        startNodeId: "tick",
        nodes: [
          { id: "tick", type: "scheduleTrigger", config: {} as never },
          {
            id: "createTbl",
            type: "sqlExec",
            config: {
              connectionId: "pg-live",
              sql: `CREATE TABLE IF NOT EXISTS ${TABLE} (id BIGINT PRIMARY KEY, note TEXT, created_at TIMESTAMPTZ DEFAULT now())`,
              params: [],
            } as never,
          },
          {
            id: "insert",
            type: "sqlExec",
            config: {
              connectionId: "pg-live",
              sql: `INSERT INTO ${TABLE} (id, note) VALUES ($1, $2)`,
              // paramBindings fill positional params from upstream outputs (never the SQL text):
              // $1 ← tick.id, $2 ← tick.note (tick = the scheduleTrigger passthrough of the input).
              params: [0, ""],
              paramBindings: {
                "0": { from: "tick", path: "id" },
                "1": { from: "tick", path: "note" },
              },
            } as never,
          },
          {
            id: "readback",
            type: "sqlQuery",
            config: {
              connectionId: "pg-live",
              sql: `SELECT id, note FROM ${TABLE} WHERE id = $1`,
              params: [0],
              paramBindings: { "0": { from: "tick", path: "id" } },
            } as never,
          },
          {
            // Cleanup runs inside the workflow (before the assertions below), so the throwaway
            // table never lingers regardless of how the assertions go.
            id: "dropTbl",
            type: "sqlExec",
            config: {
              connectionId: "pg-live",
              sql: `DROP TABLE IF EXISTS ${TABLE}`,
              params: [],
            } as never,
          },
          { id: "end", type: "end" },
        ],
        edges: [
          { from: "tick", to: "createTbl" },
          { from: "createTbl", to: "insert" },
          { from: "insert", to: "readback" },
          { from: "readback", to: "dropTbl" },
          { from: "dropTbl", to: "end" },
        ],
      };

      const worker = await makeWorker();
      await worker.runUntil(async () => {
        const handle = await env.client.workflow.start(runGraph, {
          args: [graph, { id: rowId, note }, { tenantId: "t-live-sql" }],
          taskQueue: TASK_QUEUE,
          workflowId: `live-sql-sync-${rowId}`,
        });
        const result = await handle.result();
        expect(result.status).toBe("completed");

        const final = await handle.query(stateQuery);

        // The write committed exactly one row...
        const inserted = final.ctx.insert as { rowsAffected: number };
        expect(inserted.rowsAffected).toBe(1);

        // ...and the read-only query saw it come back with the right payload.
        const read = final.ctx.readback as {
          rowCount: number;
          rows: { id: number | string; note: string }[];
        };
        expect(read.rowCount).toBe(1);
        expect(String(read.rows[0].id)).toBe(String(rowId));
        expect(read.rows[0].note).toBe(note);
      });
    });
  },
);
