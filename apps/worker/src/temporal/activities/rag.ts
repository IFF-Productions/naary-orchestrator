// RAG nodes — pgvector vectorUpsert / vectorQuery (BYOK OpenAI embeddings).
import { randomUUID } from "node:crypto";
import { ApplicationFailure } from "@temporalio/activity";
import { getDefaultEnvironmentId, getPrisma } from "@naary/db";
import { getObjectStore, resolveClaimChecks } from "@naary/storage";
import { computeCost } from "@naary/usage";
import { activityRuns } from "../../metrics";
import { type AgentMeta, aiSdk, getCredentials, openaiSdk } from "./shared";
import { __agentDeps } from "./agent";

// ─────────────────────────────────────────────────────────────────────────────
// RAG (design docs/design/CHAT-TRIGGER-RAG.md): pgvector vectorUpsert / vectorQuery.
// ─────────────────────────────────────────────────────────────────────────────

/** Embedding model — OpenAI text-embedding-3-small (1536 dims, matching VectorChunk.embedding). */
const EMBED_MODEL = "text-embedding-3-small";
const EMBED_DIM = 1536;

/** Swappable seam for tests (embed + DB writes) — mirrors __agentDeps/__mapDeps. */
export const __ragDeps = {
  // Env-scoped creds (Slice 5): the run's env (5b, threaded from meta) selects the key; a pre-5b run
  // passes no env → fall back to the tenant default (byte-identical to pre-Slice-5).
  getKey: async (tenantId: string, environmentId?: string): Promise<string> =>
    getCredentials().getDecryptedKey(
      tenantId,
      environmentId ?? (await getDefaultEnvironmentId(tenantId)),
      "openai",
    ),
  embedOne: async (
    apiKey: string,
    value: string,
  ): Promise<{ embedding: number[]; tokens: number }> => {
    const [{ createOpenAI }, { embed }] = await Promise.all([
      openaiSdk(),
      aiSdk(),
    ]);
    const r = await embed({
      model: createOpenAI({ apiKey }).embedding(EMBED_MODEL),
      value,
    });
    return { embedding: r.embedding, tokens: r.usage?.tokens ?? 0 };
  },
  embedManyTexts: async (
    apiKey: string,
    values: string[],
  ): Promise<{ embeddings: number[][]; tokens: number }> => {
    const [{ createOpenAI }, { embedMany }] = await Promise.all([
      openaiSdk(),
      aiSdk(),
    ]);
    const r = await embedMany({
      model: createOpenAI({ apiKey }).embedding(EMBED_MODEL),
      values,
    });
    return { embeddings: r.embeddings, tokens: r.usage?.tokens ?? 0 };
  },
};

/** pgvector wants a `'[1,2,3]'::vector` literal — the interpreter never sees this string. */
function toVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

/** Record embedding token usage (fail-safe — never a silent free call, Tier-1 #6). Embedding cost
 *  may be unpriced (computeCost returns 0), which is fine: tokens are still ledgered. */
async function recordEmbedUsage(
  meta: AgentMeta,
  tokens: number,
  /** Node-type tag + measured call duration (Slice 2) — the caller knows which node
   *  kind it serves and measured the embed around the provider call. */
  timing?: { nodeType: string; durationMs: number },
): Promise<number> {
  await __agentDeps.recordUsage({
    tenantId: meta.tenantId,
    environmentId: meta.environmentId, // per-env cost tag (Slice 6)
    executionId: meta.executionId,
    nodeId: meta.nodeId,
    nodeType: timing?.nodeType,
    durationMs: timing?.durationMs,
    provider: "openai",
    model: EMBED_MODEL,
    usage: { inputTokens: tokens, outputTokens: 0 },
  });
  try {
    return computeCost({
      provider: "openai",
      model: EMBED_MODEL,
      inputTokens: tokens,
      outputTokens: 0,
    });
  } catch {
    return 0; // embedding model not in the pricing table → tokens ledgered, cost 0
  }
}

export interface VectorUpsertResult {
  status: "ok";
  result: { upserted: number };
  costUsd: number;
}

/** vectorUpsert node: embed the chunk(s) with the tenant's BYOK OpenAI key and store them in the
 *  tenant-scoped VectorChunk store under `collection`. Missing key → non-retryable (user must fix). */
export async function callVectorUpsert(
  cfg: { collection: string },
  input: unknown,
  meta: AgentMeta,
): Promise<VectorUpsertResult> {
  const startedAtMs = Date.now(); // Slice 2: in-activity measured duration (clock in activity — fine)
  const store = getObjectStore();
  const value = await resolveClaimChecks(input, store);
  const chunks = (Array.isArray(value) ? value : [value])
    .map((c) => (typeof c === "string" ? c : JSON.stringify(c)))
    .filter((c) => c.trim() !== "");
  if (chunks.length === 0) {
    return { status: "ok", result: { upserted: 0 }, costUsd: 0 };
  }
  let apiKey: string;
  try {
    apiKey = await __ragDeps.getKey(meta.tenantId, meta.environmentId);
  } catch {
    throw ApplicationFailure.nonRetryable(
      "No OpenAI key configured for embeddings",
      "RAG_NO_KEY",
      { tenantId: meta.tenantId },
    );
  }
  const { embeddings, tokens } = await __ragDeps.embedManyTexts(apiKey, chunks);
  for (let i = 0; i < chunks.length; i++) {
    await getPrisma().$executeRaw`
      INSERT INTO "VectorChunk" ("id", "tenantId", "collection", "chunkText", "embedding")
      VALUES (${randomUUID()}, ${meta.tenantId}, ${cfg.collection}, ${chunks[i]}, ${toVectorLiteral(embeddings[i])}::vector)`;
  }
  const costUsd = await recordEmbedUsage(meta, tokens, {
    nodeType: "vectorUpsert",
    durationMs: Date.now() - startedAtMs,
  });
  activityRuns.inc({ activity: "callVectorUpsert", outcome: "ok" });
  return { status: "ok", result: { upserted: chunks.length }, costUsd };
}

export interface VectorMatch {
  chunkText: string;
  score: number;
}
export interface VectorQueryResult {
  status: "ok";
  result: { matches: VectorMatch[] };
  costUsd: number;
}

/** vectorQuery node: embed the query and return the top-k nearest chunks (cosine similarity) from
 *  the tenant's `collection`. Exact search (`<=>`) — fine for v1 / small collections. */
export async function callVectorQuery(
  cfg: { collection: string; topK?: number },
  input: unknown,
  meta: AgentMeta,
): Promise<VectorQueryResult> {
  const startedAtMs = Date.now(); // Slice 2: in-activity measured duration
  const store = getObjectStore();
  const value = await resolveClaimChecks(input, store);
  const query = typeof value === "string" ? value : JSON.stringify(value ?? "");
  if (query.trim() === "") {
    return { status: "ok", result: { matches: [] }, costUsd: 0 };
  }
  let apiKey: string;
  try {
    apiKey = await __ragDeps.getKey(meta.tenantId, meta.environmentId);
  } catch {
    throw ApplicationFailure.nonRetryable(
      "No OpenAI key configured for embeddings",
      "RAG_NO_KEY",
      { tenantId: meta.tenantId },
    );
  }
  const { embedding, tokens } = await __ragDeps.embedOne(apiKey, query);
  const topK = Math.min(Math.max(1, Math.floor(cfg.topK ?? 4)), 50);
  const vec = toVectorLiteral(embedding);
  const rows = await getPrisma().$queryRaw<
    { chunkText: string; score: number }[]
  >`
    SELECT "chunkText", 1 - ("embedding" <=> ${vec}::vector) AS "score"
    FROM "VectorChunk"
    WHERE "tenantId" = ${meta.tenantId} AND "collection" = ${cfg.collection}
    ORDER BY "embedding" <=> ${vec}::vector
    LIMIT ${topK}`;
  const matches = rows.map((r) => ({
    chunkText: r.chunkText,
    score: Number(r.score),
  }));
  const costUsd = await recordEmbedUsage(meta, tokens, {
    nodeType: "vectorQuery",
    durationMs: Date.now() - startedAtMs,
  });
  activityRuns.inc({ activity: "callVectorQuery", outcome: "ok" });
  return { status: "ok", result: { matches }, costUsd };
}

// EMBED_DIM is asserted at build to match the migration's vector(1536).
void EMBED_DIM;
