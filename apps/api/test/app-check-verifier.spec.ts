import { describe, expect, it, vi } from "vitest";
import { AppCheckVerifier } from "../src/turnstile/app-check-verifier";

/**
 * Firebase App Check verification (docs/design/TENANT-BOT-GATE-PROVIDERS.md §3), the second bot-gate
 * provider. The verify fn is injected so nothing here touches firebase-admin or the network.
 *
 * The verdict mapping is the security-relevant part:
 *   ok          → attested
 *   denied      → a DEFINITE negative (bad token, or a replayed one)
 *   unavailable → no answer (unconfigured / network) ⇒ callers ALLOW, matching Turnstile's fail-open
 */
const verifier = (fn: (t: string) => Promise<{ alreadyConsumed?: boolean }>) =>
  new AppCheckVerifier({}, fn);

describe("AppCheckVerifier", () => {
  it("is disabled — and reports `unavailable` — with no service account", async () => {
    // `null` = explicitly disabled, so this doesn't depend on the ambient env.
    const v = new AppCheckVerifier(null);
    expect(v.enabled).toBe(false);
    // NOT "denied": an unconfigured platform must not deny submissions, it must decline to enforce.
    expect(await v.verify("some-token")).toBe("unavailable");
  });

  it("attests a valid token", async () => {
    expect(await verifier(async () => ({})).verify("t")).toBe("ok");
    expect(
      await verifier(async () => ({ alreadyConsumed: false })).verify("t"),
    ).toBe("ok");
  });

  /**
   * A replay is a SUCCESSFUL verification with a definite answer, so it must deny rather than fall
   * into the fail-open bucket with network errors. (Whether replay protection actually engages
   * depends on limited-use tokens + a console setting — see the design doc; this pins our handling
   * of the signal, not the SDK's willingness to emit it.)
   */
  it("denies a replayed (already-consumed) token", async () => {
    expect(
      await verifier(async () => ({ alreadyConsumed: true })).verify("t"),
    ).toBe("denied");
  });

  it("denies an empty token without calling out", async () => {
    const fn = vi.fn();
    expect(await new AppCheckVerifier({}, fn).verify("")).toBe("denied");
    expect(fn).not.toHaveBeenCalled();
  });

  it("denies when firebase says the TOKEN is bad — the real attack path", async () => {
    for (const code of [
      "app-check/invalid-argument",
      "app-check/invalid-credential",
    ]) {
      const v = verifier(async () => {
        throw Object.assign(new Error("nope"), { code });
      });
      expect(await v.verify("forged")).toBe("denied");
    }
  });

  /**
   * Fail-open on anything we can't attribute to the token: a Google blip must not brick every public
   * form (the tenant budget cap is the real cost backstop). Documented asymmetry with Turnstile,
   * where Cloudflare hands us an explicit `success: false`.
   */
  it("reports `unavailable` for transport-ish and unrecognized failures", async () => {
    const cases: unknown[] = [
      Object.assign(new Error("fetch failed"), { code: "ECONNRESET" }),
      Object.assign(new Error("timeout"), { code: "app-check/unknown-error" }),
      new Error("no code at all"),
      "a thrown string",
    ];
    for (const err of cases) {
      const v = verifier(async () => {
        throw err;
      });
      expect(await v.verify("t")).toBe("unavailable");
    }
  });

  it("treats an injected verify fn as enabled, so tests need no env", () => {
    expect(new AppCheckVerifier(undefined, async () => ({})).enabled).toBe(
      true,
    );
  });
});
