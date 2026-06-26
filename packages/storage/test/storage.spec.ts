import { describe, expect, it, vi } from "vitest";
import {
  isClaimCheck,
  maybeOffload,
  MemoryObjectStore,
  resolveClaimChecks,
  S3ObjectStore,
} from "../src/index";

describe("MemoryObjectStore", () => {
  it("put returns a ref that get round-trips", async () => {
    const s = new MemoryObjectStore();
    const ref = await s.put("k1", "hello");
    expect(ref).toBe("mem://k1");
    expect((await s.get(ref)).toString()).toBe("hello");
  });

  it("get throws for an unknown ref", async () => {
    await expect(new MemoryObjectStore().get("mem://nope")).rejects.toThrow();
  });
});

describe("claim-check", () => {
  it("keeps small values inline (no offload)", async () => {
    const s = new MemoryObjectStore();
    const v = { a: 1, b: "small" };
    const out = await maybeOffload(v, s, {
      keyPrefix: "t",
      thresholdBytes: 1000,
    });
    expect(out).toBe(v);
    expect(isClaimCheck(out)).toBe(false);
  });

  it("offloads a large value to a reference that resolveClaimChecks restores", async () => {
    const s = new MemoryObjectStore();
    const big = { blob: "x".repeat(2000) };
    const out = await maybeOffload(big, s, {
      keyPrefix: "t",
      thresholdBytes: 1000,
    });
    expect(isClaimCheck(out)).toBe(true);
    expect((out as { bytes: number }).bytes).toBeGreaterThan(1000);
    expect(await resolveClaimChecks(out, s)).toEqual(big);
  });

  it("resolves references nested in objects/arrays, leaving scalars alone", async () => {
    const s = new MemoryObjectStore();
    const ref = await maybeOffload({ data: "y".repeat(2000) }, s, {
      keyPrefix: "t",
      thresholdBytes: 1000,
    });
    const resolved = (await resolveClaimChecks(
      { items: [{ result: ref }], scalar: 5 },
      s,
    )) as { items: { result: { data: string } }[]; scalar: number };
    expect(resolved.items[0].result).toEqual({ data: "y".repeat(2000) });
    expect(resolved.scalar).toBe(5);
  });
});

describe("S3ObjectStore", () => {
  it("put issues PutObject (s3:// ref) and get reads the bytes back", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({}) // PutObject
      .mockResolvedValueOnce({
        Body: { transformToByteArray: async () => Buffer.from("data-bytes") },
      }); // GetObject
    const store = new S3ObjectStore({ send } as never, "my-bucket");

    const ref = await store.put("k/1.json", "data-bytes");
    expect(ref).toBe("s3://my-bucket/k/1.json");
    expect((await store.get(ref)).toString()).toBe("data-bytes");
    expect(send).toHaveBeenCalledTimes(2);
  });
});
