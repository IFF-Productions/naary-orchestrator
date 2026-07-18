import * as path from "node:path";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { createLocalTestEnv } from "./local-test-env";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TASK_QUEUE, stateQuery } from "@naary/contracts";
import type { GraphDef } from "@naary/dsl";
import { MemoryObjectStore, __setObjectStore } from "@naary/storage";
import { disconnectPrisma, getPrisma } from "@naary/db";
import * as activities from "../src/temporal/activities";
import { runGraph } from "../src/temporal/workflows";

/**
 * REAL flow integration: the vectorUpsert + vectorQuery NODES run through the real Temporal
 * interpreter and the real pgvector adapter (raw SQL in rag.ts) against a THROWAWAY pgvector Postgres
 * (testcontainers) — no mocked DB. A graph embeds + stores chunks, then a top-k similarity query reads
 * the nearest one back. Mirrors sql-node.integration.spec.ts.
 *
 * Two seams are relaxed (everything else is real):
 *  - __ragDeps.{getKey,embedOne,embedManyTexts} → a DETERMINISTIC bag-of-words embedding (1536-dim,
 *    non-zero — cosine `<=>` is undefined for a zero vector), so there is no OpenAI call and the
 *    nearest-neighbour ordering is reproducible. The pgvector write/read PATH stays REAL.
 *  - __agentDeps.recordUsage → no-op: recordEmbedUsage would otherwise hit a UsageEvent table that
 *    doesn't exist in this bare pgvector container.
 *
 * Docker-gated, so it lives OUT of the default `pnpm test` (see vitest.integration.config.ts) —
 * run with `pnpm test:integration`.
 */

// Temporal's own bundler (not vitest) processes this path, so it must be a real absolute path.
const WORKFLOWS_PATH = path.join(__dirname, "../src/temporal/workflows.ts");
const EMBED_DIM = 1536; // must match the migration's vector(1536)

/** Deterministic, reproducible embedding: bag-of-words over a 1536-dim space. Each word bumps one
 *  dimension, so texts sharing words are cosine-near and disjoint texts are orthogonal. Always
 *  non-zero (empty → dim 0 = 1) since pgvector's cosine distance is undefined for a zero vector. */
function embedText(text: string): number[] {
  const vec = new Array<number>(EMBED_DIM).fill(0);
  const words =
    String(text)
      .toLowerCase()
      .match(/[a-z0-9]+/g) ?? [];
  for (const w of words) {
    let h = 0;
    for (let i = 0; i < w.length; i++) h = (h * 31 + w.charCodeAt(i)) >>> 0;
    vec[h % EMBED_DIM] += 1;
  }
  if (words.length === 0) vec[0] = 1;
  return vec;
}

let env: TestWorkflowEnvironment;
let container: Awaited<ReturnType<PostgreSqlContainer["start"]>>;
// The process-wide Prisma singleton reads DATABASE_URL at FIRST call — capture the prior value so
// teardown can restore it, and reset the singleton so an earlier spec's pool can't be reused here.
let priorDatabaseUrl: string | undefined;

beforeAll(async () => {
  // pgvector image ships the `vector` extension the migration needs.
  container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  priorDatabaseUrl = process.env.DATABASE_URL;
  // If any earlier spec in this process initialized Prisma (against another URL), close that pool
  // BEFORE repointing DATABASE_URL — the next getPrisma() then binds to the container cleanly.
  await disconnectPrisma();
  process.env.DATABASE_URL = container.getConnectionUri();
  env = await createLocalTestEnv();

  // Claim-check offload store the RAG activities touch (in-memory here).
  __setObjectStore(new MemoryObjectStore());

  // Bootstrap the pgvector extension + VectorChunk table (the two schema objects rag.ts writes/reads).
  const prisma = getPrisma();
  await prisma.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS vector`);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE "VectorChunk" (
      "id" TEXT NOT NULL,
      "tenantId" TEXT NOT NULL,
      "collection" TEXT NOT NULL,
      "chunkText" TEXT NOT NULL,
      "embedding" vector(${EMBED_DIM}) NOT NULL,
      "metadata" JSONB,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "VectorChunk_pkey" PRIMARY KEY ("id")
    )`);

  // Relax ONLY the embedding + credential/usage seams; the pgvector write/query path stays real.
  activities.__ragDeps.getKey = async () => "test-key";
  activities.__ragDeps.embedManyTexts = async (_key, values) => ({
    embeddings: values.map(embedText),
    tokens: values.length,
  });
  activities.__ragDeps.embedOne = async (_key, value) => ({
    embedding: embedText(value),
    tokens: 1,
  });
  activities.__agentDeps.recordUsage = (async () => undefined) as never; // no UsageEvent table in this bare container
}, 180_000);

afterAll(async () => {
  await env?.teardown();
  // Close the container-backed pool BEFORE stopping the container, then restore the process
  // env so later specs in this process see the original DATABASE_URL and a fresh singleton.
  await disconnectPrisma().catch(() => undefined);
  if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = priorDatabaseUrl;
  await container?.stop();
});

/** Register the REAL activities; stub only the app-DB bookkeeping ones (no app DB here). */
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

// webhook → vectorUpsert(store trigger.chunks) → vectorQuery(top-3 of trigger.query) → end.
function ragFlow(): GraphDef {
  return {
    startNodeId: "trigger",
    nodes: [
      { id: "trigger", type: "webhookTrigger" },
      {
        id: "store",
        type: "vectorUpsert",
        config: { collection: "docs", from: "trigger", path: "chunks" },
      },
      {
        id: "search",
        type: "vectorQuery",
        config: { collection: "docs", from: "trigger", path: "query", topK: 3 },
      },
      { id: "end", type: "end" },
    ],
    edges: [
      { from: "trigger", to: "store" },
      { from: "store", to: "search" },
      { from: "search", to: "end" },
    ],
  };
}

describe("RAG nodes — real pgvector flow (testcontainers)", () => {
  it("upserts embedded chunks then returns the nearest by cosine similarity, end to end", async () => {
    const worker = await makeWorker();
    await worker.runUntil(async () => {
      const chunks = [
        "apple pie recipe with cinnamon",
        "car engine repair manual",
        "python programming language guide",
      ];
      const handle = await env.client.workflow.start(runGraph, {
        args: [
          ragFlow(),
          // query shares two words with chunk 0 only → chunk 0 is unambiguously nearest
          { chunks, query: "apple pie dessert" },
          { tenantId: "t-rag-int" },
        ],
        taskQueue: TASK_QUEUE,
        workflowId: "e2e-rag-integration",
      });
      expect((await handle.result()).status).toBe("completed");

      const final = await handle.query(stateQuery);
      // vectorUpsert stored all three chunks (proves the real pgvector INSERT path ran)
      expect(final.ctx.store).toEqual({ upserted: 3 });

      const search = final.ctx.search as {
        matches: { chunkText: string; score: number }[];
      };
      // real top-k came back non-empty (proves the query hit the container, not an empty stub)
      expect(search.matches.length).toBeGreaterThan(0);
      // the nearest chunk is the apple-pie one (shared words → highest cosine similarity)
      expect(search.matches[0].chunkText).toBe(
        "apple pie recipe with cinnamon",
      );
      // similarity is bounded (1 - cosine distance); the top match beats the disjoint chunks
      expect(search.matches[0].score).toBeGreaterThan(0);
      if (search.matches.length > 1) {
        expect(search.matches[0].score).toBeGreaterThan(
          search.matches[1].score,
        );
      }
    });
  });
});
