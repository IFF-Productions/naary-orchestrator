import "reflect-metadata";
import { createHash } from "node:crypto";
import { ThrottlerModule } from "@nestjs/throttler";
import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { ApiTokenThrottlerGuard } from "../src/v1/api-token-throttler.guard";

/**
 * The v1 throttler keys on the API TOKEN, not the IP — and buckets on a HASH of the token, never the
 * raw secret. getTracker reads only the Authorization header, so it needs no DB and no guard-order
 * assumption. Non-`nry_` callers fall back to the base per-IP tracker.
 */

// getTracker is protected; construct with stub deps (unused on the nry_ path) and reach it via cast.
function makeGuard() {
  const g = new ApiTokenThrottlerGuard(
    { throttlers: [] } as never,
    {} as never,
    {} as never,
  );
  return (req: Record<string, unknown>): Promise<string> =>
    (
      g as unknown as { getTracker: (r: unknown) => Promise<string> }
    ).getTracker(req);
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("ApiTokenThrottlerGuard.getTracker", () => {
  it("keys an nry_ token on its sha256, NOT the raw token", async () => {
    const track = makeGuard();
    const key = await track({
      headers: { authorization: "Bearer nry_secret123" },
    });
    expect(key).toBe(`tok:${sha("nry_secret123")}`);
    // the raw secret never appears in the bucket key
    expect(key).not.toContain("nry_secret123");
  });

  it("gives different tokens different buckets, and the same token a stable bucket", async () => {
    const track = makeGuard();
    const a = await track({ headers: { authorization: "Bearer nry_aaa" } });
    const b = await track({ headers: { authorization: "Bearer nry_bbb" } });
    const a2 = await track({ headers: { authorization: "Bearer nry_aaa" } });
    expect(a).not.toBe(b);
    expect(a).toBe(a2);
  });

  it("is case-insensitive on the Bearer scheme", async () => {
    const track = makeGuard();
    const key = await track({ headers: { authorization: "bearer nry_x" } });
    expect(key).toBe(`tok:${sha("nry_x")}`);
  });

  it("falls back to the base (per-IP) tracker for a non-nry_ caller", async () => {
    const track = makeGuard();
    // super.getTracker reads req.ips/req.ip; give it an ip and assert we did NOT produce a token bucket.
    const key = await track({
      headers: { authorization: "Bearer eyJ.firebase.jwt" },
      ip: "203.0.113.9",
      ips: [],
    });
    expect(key).not.toMatch(/^tok:/);
    expect(key).toBe("203.0.113.9");
  });

  it("falls back when there is no Authorization header at all", async () => {
    const track = makeGuard();
    const key = await track({ headers: {}, ip: "203.0.113.10", ips: [] });
    expect(key).not.toMatch(/^tok:/);
  });
});

describe("ApiTokenThrottlerGuard DI", () => {
  it("resolves its ThrottlerModule deps (options/storage/reflector) when provided", async () => {
    // Proves the guard wires under a real ThrottlerModule — the one new DI element V1Module adds.
    const mod = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }])],
      providers: [ApiTokenThrottlerGuard],
    }).compile();
    expect(mod.get(ApiTokenThrottlerGuard)).toBeInstanceOf(
      ApiTokenThrottlerGuard,
    );
    await mod.close();
  });
});
