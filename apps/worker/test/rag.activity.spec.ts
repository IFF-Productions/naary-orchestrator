import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const executeRaw = vi.fn();
const queryRaw = vi.fn();
vi.mock("@naary/db", () => ({
  getPrisma: () => ({ $executeRaw: executeRaw, $queryRaw: queryRaw }),
  getDefaultEnvironmentId: () => Promise.resolve("e1"),
}));

import {
  __closeSentryForTest,
  __initSentryForTest,
} from "@naary/observability";
import { __setObjectStore, MemoryObjectStore } from "@naary/storage";
import {
  __agentDeps,
  __ragDeps,
  callVectorQuery,
  callVectorUpsert,
} from "../src/temporal/activities";
import { collectGenAiAttrs } from "./genai-attrs";

const meta = { tenantId: "t-1", executionId: "e-1", nodeId: "n-1" };

/** The token count the ledger received, from the single recordUsage call. */
function ledgeredInputTokens(): number {
  const spy = __agentDeps.recordUsage as unknown as {
    mock: { calls: [{ usage: { inputTokens: number } }][] };
  };
  return spy.mock.calls[0][0].usage.inputTokens;
}

/** The rule-6 fail-safe estimate the activity must book when the provider reports no usage:
 *  `estimateTokens`' char/4 over the text actually embedded (input-only — no output half).
 *  Written out rather than imported so the test pins a VALUE, not the implementation. */
function expectedEstimate(texts: string[]): number {
  return Math.max(1, Math.ceil(JSON.stringify(texts).length / 4));
}

beforeEach(() => {
  __setObjectStore(new MemoryObjectStore());
  executeRaw.mockReset().mockResolvedValue(1);
  queryRaw.mockReset().mockResolvedValue([]);
  vi.spyOn(__agentDeps, "recordUsage").mockResolvedValue(undefined as never);
});
afterEach(() => vi.restoreAllMocks());

describe("callVectorUpsert", () => {
  it("embeds each chunk (BYOK key) and inserts one row per chunk; meters tokens", async () => {
    vi.spyOn(__ragDeps, "getKey").mockResolvedValue("sk-test");
    const embedMany = vi.spyOn(__ragDeps, "embedManyTexts").mockResolvedValue({
      embeddings: [
        [0.1, 0.2],
        [0.3, 0.4],
      ],
      tokens: 12,
    });

    const res = await callVectorUpsert(
      { collection: "docs" },
      ["chunk one", "chunk two"],
      meta,
    );

    expect(embedMany).toHaveBeenCalledWith("sk-test", [
      "chunk one",
      "chunk two",
    ]);
    expect(executeRaw).toHaveBeenCalledTimes(2); // one INSERT per chunk
    expect(res.result).toEqual({ upserted: 2 });
    expect(__agentDeps.recordUsage).toHaveBeenCalledOnce(); // tokens ledgered (fail-safe)
    // The VALUE, not just the call: the provider's own count reaches the ledger untouched.
    expect(ledgeredInputTokens()).toBe(12);
  });

  it("is a no-op (no key fetch, no write) for empty input", async () => {
    const getKey = vi.spyOn(__ragDeps, "getKey");
    const res = await callVectorUpsert({ collection: "docs" }, [], meta);
    expect(res.result).toEqual({ upserted: 0 });
    expect(getKey).not.toHaveBeenCalled();
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it("fails non-retryably when the tenant has no OpenAI key", async () => {
    vi.spyOn(__ragDeps, "getKey").mockRejectedValue(new Error("no key"));
    await expect(
      callVectorUpsert({ collection: "docs" }, "hello", meta),
    ).rejects.toMatchObject({ type: "RAG_NO_KEY" });
  });
});

describe("callVectorQuery", () => {
  it("embeds the query and returns the top-k nearest chunks with scores", async () => {
    vi.spyOn(__ragDeps, "getKey").mockResolvedValue("sk-test");
    vi.spyOn(__ragDeps, "embedOne").mockResolvedValue({
      embedding: [0.1, 0.2],
      tokens: 5,
    });
    queryRaw.mockResolvedValue([
      { chunkText: "closest", score: 0.92 },
      { chunkText: "next", score: 0.71 },
    ]);

    const res = await callVectorQuery(
      { collection: "docs", topK: 2 },
      "what is X?",
      meta,
    );

    expect(res.result.matches).toEqual([
      { chunkText: "closest", score: 0.92 },
      { chunkText: "next", score: 0.71 },
    ]);
    expect(__agentDeps.recordUsage).toHaveBeenCalledOnce();
    expect(ledgeredInputTokens()).toBe(5);
  });

  it("returns no matches (no embed) for a blank query", async () => {
    const embedOne = vi.spyOn(__ragDeps, "embedOne");
    const res = await callVectorQuery({ collection: "docs" }, "  ", meta);
    expect(res.result).toEqual({ matches: [] });
    expect(embedOne).not.toHaveBeenCalled();
  });
});

/**
 * REGRESSION (#1058) — CLAUDE.md Tier-1 rule 6: "if token usage is missing/undefined, record a
 * fallback estimate — a zero is a silently-free call". Both embed paths used to book
 * `r.usage?.tokens ?? 0`, so a provider that omitted `usage` (the ai@6 usage-undefined bug is the
 * documented case) had its real embedding work ledgered at ZERO: the tenant billed nothing, the
 * ledger under-reporting, the run succeeding with nothing to signal it.
 *
 * The old spec asserted only that recordUsage was CALLED, which stayed green on 0 tokens — hence
 * the value assertions here, and the estimated flag on the exported span.
 */
describe("provider reports no usage (Tier-1 rule 6 fail-safe)", () => {
  const CHUNK_SENTINEL = "zetaChunkTextSentinel";
  let sink: unknown[];

  beforeEach(() => {
    sink = [];
    vi.spyOn(__ragDeps, "getKey").mockResolvedValue("sk-test");
    __initSentryForTest(sink);
  });
  afterEach(() => __closeSentryForTest());

  it("vectorUpsert estimates from the chunks instead of ledgering zero", async () => {
    const chunks = [CHUNK_SENTINEL, "chunk two"];
    vi.spyOn(__ragDeps, "embedManyTexts").mockResolvedValue({
      embeddings: [
        [0.1, 0.2],
        [0.3, 0.4],
      ],
      tokens: undefined, // the provider omitted `usage`
    });

    const res = await callVectorUpsert({ collection: "docs" }, chunks, meta);

    expect(res.result).toEqual({ upserted: 2 }); // the work still happened…
    expect(__agentDeps.recordUsage).toHaveBeenCalledOnce();
    expect(ledgeredInputTokens()).toBeGreaterThan(0); // …so it is NOT billed as free
    expect(ledgeredInputTokens()).toBe(expectedEstimate(chunks));
  });

  it("vectorQuery estimates from the query instead of ledgering zero", async () => {
    vi.spyOn(__ragDeps, "embedOne").mockResolvedValue({
      embedding: [0.1, 0.2],
      tokens: undefined,
    });

    await callVectorQuery({ collection: "docs" }, CHUNK_SENTINEL, meta);

    expect(__agentDeps.recordUsage).toHaveBeenCalledOnce();
    expect(ledgeredInputTokens()).toBeGreaterThan(0);
    expect(ledgeredInputTokens()).toBe(expectedEstimate([CHUNK_SENTINEL]));
  });

  it("a reported ZERO is treated as 'not measured', not as a free call", async () => {
    // A provider that embedded real text and answered "0 tokens" has measured nothing either —
    // same shape as agent.ts's `!(real.inputTokens || real.outputTokens)`.
    vi.spyOn(__ragDeps, "embedOne").mockResolvedValue({
      embedding: [0.1, 0.2],
      tokens: 0,
    });

    await callVectorQuery({ collection: "docs" }, CHUNK_SENTINEL, meta);

    expect(ledgeredInputTokens()).toBe(expectedEstimate([CHUNK_SENTINEL]));
  });

  it("flags the estimate on the embeddings span so it can't pass for a metered count", async () => {
    vi.spyOn(__ragDeps, "embedOne").mockResolvedValue({
      embedding: [0.1, 0.2],
      tokens: undefined,
    });

    await callVectorQuery({ collection: "docs" }, CHUNK_SENTINEL, meta);

    await __closeSentryForTest(); // flush the capturing transport
    const attrs = collectGenAiAttrs(sink);
    expect(attrs["gen_ai.operation.name"]).toBe("embeddings");
    expect(attrs["gen_ai.request.model"]).toBe("text-embedding-3-small");
    expect(attrs["naary.gen_ai.usage.estimated"]).toBe(true);
    expect(attrs["gen_ai.usage.input_tokens"]).toBeGreaterThan(0);
    expect(attrs["gen_ai.usage.output_tokens"]).toBe(0); // embeddings are input-only

    // PRIVACY (CLAUDE.md): the estimate is derived from the embedded text, so prove the text
    // itself never reaches the span — only the resulting count does.
    expect(JSON.stringify(sink)).not.toContain(CHUNK_SENTINEL);
  });

  it("does NOT flag provider-reported counts as estimated", async () => {
    vi.spyOn(__ragDeps, "embedOne").mockResolvedValue({
      embedding: [0.1, 0.2],
      tokens: 42,
    });

    await callVectorQuery({ collection: "docs" }, "what is X?", meta);

    await __closeSentryForTest();
    const attrs = collectGenAiAttrs(sink);
    expect(attrs["naary.gen_ai.usage.estimated"]).toBe(false);
    expect(attrs["gen_ai.usage.input_tokens"]).toBe(42);
    expect(ledgeredInputTokens()).toBe(42);
  });
});
