import { describe, expect, it } from "vitest";
import { resolveClientIp } from "../src/throttle/client-ip-throttler.guard";

// #596 AC: two clients behind the proxy get independent buckets — i.e. distinct real client IPs
// produce distinct trackers, instead of collapsing onto the proxy's req.ip.
describe("resolveClientIp (#596)", () => {
  it("prefers CF-Connecting-IP (Cloudflare overwrites it → trustworthy)", () => {
    expect(
      resolveClientIp({
        headers: {
          "cf-connecting-ip": "203.0.113.7",
          "x-real-ip": "10.0.0.1", // cloudflared in prod — ignored
        },
      }),
    ).toBe("203.0.113.7");
  });

  it("falls back to X-Real-IP (nginx sets it via $remote_addr → non-spoofable) when no CF header", () => {
    expect(resolveClientIp({ headers: { "x-real-ip": "198.51.100.4" } })).toBe(
      "198.51.100.4",
    );
  });

  it("returns null (→ base req.ip tracker) when neither trusted header is present", () => {
    expect(resolveClientIp({ headers: {} })).toBeNull();
    expect(resolveClientIp({})).toBeNull();
  });

  it("IGNORES X-Forwarded-For (nginx appends it → leftmost is attacker-controlled)", () => {
    // A bot sending a forged XFF must NOT get its own bucket off it.
    expect(
      resolveClientIp({ headers: { "x-forwarded-for": "1.2.3.4, 10.0.0.1" } }),
    ).toBeNull();
  });

  it("distinct clients → distinct trackers (the core bug: no shared bucket)", () => {
    const a = resolveClientIp({
      headers: { "cf-connecting-ip": "203.0.113.1" },
    });
    const b = resolveClientIp({
      headers: { "cf-connecting-ip": "203.0.113.2" },
    });
    expect(a).not.toBe(b);
  });

  it("tolerates an array-valued header (takes the first)", () => {
    expect(
      resolveClientIp({ headers: { "cf-connecting-ip": ["203.0.113.9"] } }),
    ).toBe("203.0.113.9");
  });
});
