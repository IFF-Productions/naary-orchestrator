import { beforeEach, describe, expect, it } from "vitest";
import {
  __setObjectStore,
  MemoryObjectStore,
  maybeOffload,
} from "@naary/storage";
import { callCode } from "../src/temporal/activities";

const meta = { tenantId: "t-1", executionId: "e-1", nodeId: "n-1" };

let store: MemoryObjectStore;
beforeEach(() => {
  store = new MemoryObjectStore();
  __setObjectStore(store);
});

const run = (code: string, input: unknown = {}, ctx = {}, extra = {}) =>
  callCode({ code, ...extra }, { input, ctx }, meta);

describe("callCode (QuickJS sandbox)", () => {
  it("computes a result from $input and $ctx", async () => {
    const r = await run(
      "return { sum: $input.a + $ctx.up.b, tag: 'x' }",
      { a: 2 },
      { up: { b: 40 } },
    );
    expect(r).toEqual({
      status: "ok",
      result: { sum: 42, tag: "x" },
      costUsd: 0,
    });
  });

  it("returns arrays/numbers/strings faithfully", async () => {
    expect((await run("return [1,2,3].map(x=>x*2)")).result).toEqual([2, 4, 6]);
    expect((await run("return 7 * 6")).result).toBe(42);
    expect((await run("return 'hi'.toUpperCase()")).result).toBe("HI");
  });

  it("has NO host access (process/require/fetch are undefined in the guest)", async () => {
    const r = await run(
      "return [typeof process, typeof require, typeof fetch, typeof globalThis.process]",
    );
    expect(r.result).toEqual([
      "undefined",
      "undefined",
      "undefined",
      "undefined",
    ]);
  });

  it("an infinite loop → non-retryable CODE_TIMEOUT (bounded)", async () => {
    const err = await run("while(true){}", {}, {}, { timeoutMs: 200 }).catch(
      (e) => e,
    );
    expect(err.nonRetryable).toBe(true);
    expect(err.type).toBe("CODE_TIMEOUT");
  });

  it("a SINGLE giant allocation → clean non-retryable failure fast (memory limit, not a hang)", async () => {
    // One op the deadline interrupt can't catch — only setMemoryLimit guards it. A
    // hostile OOM must NOT hang/crash the shared worker; it must return an error.
    const t0 = Date.now();
    const err = await run(
      "return 'x'.repeat(2e9)",
      {},
      {},
      {
        memoryMb: 32,
        timeoutMs: 4000,
      },
    ).catch((e) => e);
    expect(err.nonRetryable).toBe(true);
    expect(["CODE_ERROR", "CODE_TIMEOUT"]).toContain(err.type);
    expect(Date.now() - t0).toBeLessThan(4000); // fast, not a hang
  });

  it("grow-in-a-loop allocation → clean non-retryable failure", async () => {
    const err = await run(
      "const a=[]; for(;;){ a.push(new Array(100000).fill(7)); }",
      {},
      {},
      { memoryMb: 32, timeoutMs: 3000 },
    ).catch((e) => e);
    expect(err.nonRetryable).toBe(true);
    expect(["CODE_ERROR", "CODE_TIMEOUT"]).toContain(err.type);
  });

  it("a thrown error → non-retryable CODE_ERROR (guest message surfaced)", async () => {
    const err = await run("throw new Error('boom from user code')").catch(
      (e) => e,
    );
    expect(err.nonRetryable).toBe(true);
    expect(err.type).toBe("CODE_ERROR");
    expect(String(err.message)).toContain("boom from user code");
  });

  it("rehydrates a claim-checked input before the code sees it", async () => {
    const big = { blob: "x".repeat(1_100_000), n: 5 };
    const ref = await maybeOffload(big, store, { keyPrefix: "up" });
    expect(ref).toHaveProperty("__claimCheck"); // the input IS a ref
    // pass the ref as $ctx.up — the code reads the REAL value, not the reference
    const r = await run("return $ctx.up.n + 1", {}, { up: ref });
    expect(r.result).toBe(6);
  });

  it("offloads a large return value (claim-check ref, not inline)", async () => {
    const r = await run("return { blob: 'y'.repeat(1100000) }");
    expect(r.result).toHaveProperty("__claimCheck");
  });
});
