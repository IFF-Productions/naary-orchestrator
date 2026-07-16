import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const executeRaw = vi.fn();
const queryRaw = vi.fn();
vi.mock("@naary/db", () => ({
  getPrisma: () => ({ $executeRaw: executeRaw, $queryRaw: queryRaw }),
  getDefaultEnvironmentId: () => Promise.resolve("e1"),
}));

import { __setObjectStore, MemoryObjectStore } from "@naary/storage";
import {
  __agentDeps,
  __ragDeps,
  callVectorQuery,
  callVectorUpsert,
} from "../src/temporal/activities";

const meta = { tenantId: "t-1", executionId: "e-1", nodeId: "n-1" };

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
  });

  it("returns no matches (no embed) for a blank query", async () => {
    const embedOne = vi.spyOn(__ragDeps, "embedOne");
    const res = await callVectorQuery({ collection: "docs" }, "  ", meta);
    expect(res.result).toEqual({ matches: [] });
    expect(embedOne).not.toHaveBeenCalled();
  });
});
