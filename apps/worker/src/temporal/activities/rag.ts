// RAG nodes — pgvector vectorUpsert / vectorQuery (BYOK OpenAI embeddings).
import { randomUUID } from "node:crypto";
import { ApplicationFailure } from "@temporalio/activity";
import { getDefaultEnvironmentId, getPrisma } from "@naary/db";
import { withGenAiSpan } from "@naary/observability";
import { getObjectStore, resolveClaimChecks } from "@naary/storage";
import { computeCost } from "@naary/usage";
import { activityRuns } from "../../metrics";
import {
  type AgentMeta,
  aiSdk,
  estimateTokens,
  getCredentials,
  openaiSdk,
} from "./shared";
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
  // NOTE (#1058): these report `tokens: undefined` when the provider omits `usage` — they do NOT
  // coerce it to 0. A 0 here would flow straight into the ledger as a silently-free call, the exact
  // failure CLAUDE.md Tier-1 rule 6 exists to prevent. The callers turn "nothing reported" into the
  // fail-safe ESTIMATE (see resolveEmbedTokens).
  embedOne: async (
    apiKey: string,
    value: string,
  ): Promise<{ embedding: number[]; tokens: number | undefined }> => {
    const [{ createOpenAI }, { embed }] = await Promise.all([
      openaiSdk(),
      aiSdk(),
    ]);
    const r = await embed({
      model: createOpenAI({ apiKey }).embedding(EMBED_MODEL),
      value,
    });
    return { embedding: r.embedding, tokens: r.usage?.tokens };
  },
  embedManyTexts: async (
    apiKey: string,
    values: string[],
  ): Promise<{ embeddings: number[][]; tokens: number | undefined }> => {
    const [{ createOpenAI }, { embedMany }] = await Promise.all([
      openaiSdk(),
      aiSdk(),
    ]);
    const r = await embedMany({
      model: createOpenAI({ apiKey }).embedding(EMBED_MODEL),
      values,
    });
    return { embeddings: r.embeddings, tokens: r.usage?.tokens };
  },
};

/**
 * BILLING FAIL-SAFE (CLAUDE.md Tier-1 rule 6, #1058) — the embedding twin of the agent path's
 * `estimated ? estimateTokens(…) : real` in agent.ts. The provider (or the AI-SDK v6
 * usage-undefined bug) may report no usage for a call that really happened; recording 0 tokens
 * would bill the tenant nothing and under-report the ledger, with nothing anywhere to signal it.
 *
 * Falls back to the SAME `estimateTokens` char/4 helper the agent + codeAgent paths use — one
 * mechanism for one rule. Embeddings are input-only, so only its `inputTokens` half is taken (its
 * `outputTokens` floors at 1, which would be wrong here — `recordEmbedUsage` books 0 output).
 *
 * `!reported` deliberately treats a reported literal 0 as "nothing measured", the same shape as
 * agent.ts's `!(real.inputTokens || real.outputTokens)`: a provider that embedded real text and
 * answered "0 tokens" has not measured it either. Do not "fix" this to `reported === undefined`.
 *
 * ZERO IS UNREACHABLE HERE, by construction: both callers early-return before any ledger write when
 * there is nothing to embed (no non-blank chunk / a blank query), and `estimateTokens` floors at 1
 * token. So no path ledgers an embedding at zero — "even an estimate is impossible" cannot arise,
 * and a silent 0 is the fallback nowhere.
 *
 * PRIVACY: `texts` is measured and discarded. Only the resulting COUNT leaves this function — the
 * chunk text never reaches the ledger, a span, or a log line.
 */
function resolveEmbedTokens(
  reported: number | undefined,
  texts: string[],
): { tokens: number; estimated: boolean } {
  if (reported) return { tokens: reported, estimated: false };
  return { tokens: estimateTokens("", texts, "").inputTokens, estimated: true };
}

/** Token cost of an embedding call. Guarded: an embedding model with no pricing row yields cost 0
 *  (a PRICING gap — the tokens are still ledgered), which is a different thing from zero tokens (a
 *  MEASUREMENT lie, what the fail-safe above prevents). Never throws — pricing must not fail a call
 *  the provider already charged for. */
function embedCostUsd(tokens: number): number {
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
  return embedCostUsd(tokens);
}

/**
 * Embed with the fail-safe token accounting attached: runs the provider call inside the GenAI
 * convention span (operation `embeddings`) and resolves the billed count there, so the count the
 * ledger books is the count the span reports.
 *
 * `estimated` rides the SAME mechanism the agent path uses — `naary.gen_ai.usage.estimated` as a
 * span attribute AND as a stable dimension on the `gen_ai.client.token.usage` metric — so a
 * dashboard cannot mistake a rule-6 estimate for a metered count. (It is NOT persisted on the
 * UsageEvent row — no recording site does, and a column only one site populated would be worse
 * than none; #1060 adds it across all four sites at once.)
 *
 * Wraps only the provider call plus the pure usage derivation, never the credential fetch or the
 * pgvector writes, so the span's duration keeps meaning "embedding latency".
 */
function embedWithUsage<T>(
  texts: string[],
  call: () => Promise<{ value: T; tokens: number | undefined }>,
): Promise<{ value: T; tokens: number; estimated: boolean }> {
  return withGenAiSpan(
    { operation: "embeddings", provider: "openai", model: EMBED_MODEL },
    async (record) => {
      const r = await call();
      const { tokens, estimated } = resolveEmbedTokens(r.tokens, texts);
      record({
        inputTokens: tokens,
        outputTokens: 0, // an embedding call produces no output tokens
        costUsd: embedCostUsd(tokens),
        estimated,
      });
      return { value: r.value, tokens, estimated };
    },
  );
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
  const { value: embeddings, tokens } = await embedWithUsage(
    chunks,
    async () => {
      const r = await __ragDeps.embedManyTexts(apiKey, chunks);
      return { value: r.embeddings, tokens: r.tokens };
    },
  );
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
  // The estimate is over what was actually embedded — the query text — mirroring the upsert path.
  const { value: embedding, tokens } = await embedWithUsage(
    [query],
    async () => {
      const r = await __ragDeps.embedOne(apiKey, query);
      return { value: r.embedding, tokens: r.tokens };
    },
  );
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
