import { describe, expect, it } from "vitest";
import { InMemoryMembershipCache } from "../src/membership/membership-cache";

describe("InMemoryMembershipCache", () => {
  it("returns a set value before the TTL and undefined after", () => {
    let now = 1000;
    const cache = new InMemoryMembershipCache(60_000, 10_000, () => now);
    cache.set("u1", [{ tenantId: "t1", role: "owner" }]);
    expect(cache.get("u1")).toEqual([{ tenantId: "t1", role: "owner" }]);
    now += 60_001; // past the TTL
    expect(cache.get("u1")).toBeUndefined();
  });

  it("invalidate() drops the entry immediately (revocation is instant)", () => {
    const cache = new InMemoryMembershipCache();
    cache.set("u1", [{ tenantId: "t1", role: "member" }]);
    cache.invalidate("u1");
    expect(cache.get("u1")).toBeUndefined();
  });

  it("is bounded — evicts the oldest entry when full", () => {
    const cache = new InMemoryMembershipCache(60_000, 2);
    cache.set("a", [{ tenantId: "ta", role: "member" }]);
    cache.set("b", [{ tenantId: "tb", role: "member" }]);
    cache.set("c", [{ tenantId: "tc", role: "member" }]); // evicts "a"
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeDefined();
    expect(cache.get("c")).toBeDefined();
  });

  it("a miss on an unknown user is undefined", () => {
    expect(new InMemoryMembershipCache().get("nobody")).toBeUndefined();
  });
});
