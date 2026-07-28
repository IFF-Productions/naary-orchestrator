import { afterEach, describe, expect, it, vi } from "vitest";
import { explainAppCheckFailure, planAppCheck } from "../src/lib/app-check";

/**
 * #782 — Firebase App Check. `planAppCheck` is the whole decision surface (provider +
 * on/off) split out from `initializeAppCheck` precisely so it can be tested without a
 * live Firebase project or a browser.
 *
 * The property that matters most is the OFF case: an unset site key must not produce a
 * half-configured init, because this module loads on the SPA's critical path.
 */
describe("planAppCheck", () => {
  afterEach(() => vi.restoreAllMocks());

  it("is OFF with no site key — the default for dev and self-hosted installs", () => {
    expect(planAppCheck({})).toEqual({ kind: "off" });
    expect(planAppCheck({ VITE_FIREBASE_APPCHECK_SITE_KEY: "" })).toEqual({
      kind: "off",
    });
    // Whitespace-only is a real .env accident ("KEY= " / a stray quote-space) and must
    // not reach initializeAppCheck, which throws on an empty key.
    expect(planAppCheck({ VITE_FIREBASE_APPCHECK_SITE_KEY: "   " })).toEqual({
      kind: "off",
    });
  });

  it("stays OFF when a provider is named but no key is given", () => {
    expect(
      planAppCheck({ VITE_FIREBASE_APPCHECK_PROVIDER: "enterprise" }),
    ).toEqual({ kind: "off" });
  });

  it("defaults to reCAPTCHA Enterprise, which is what the console registers today", () => {
    expect(
      planAppCheck({ VITE_FIREBASE_APPCHECK_SITE_KEY: "site-abc" }),
    ).toEqual({ kind: "recaptcha-enterprise", siteKey: "site-abc" });
  });

  it("selects the v3 provider on request", () => {
    for (const v of [
      "v3",
      "V3",
      "recaptcha-v3",
      " recaptchav3 ",
      "recaptcha_v3",
    ]) {
      expect(
        planAppCheck({
          VITE_FIREBASE_APPCHECK_SITE_KEY: "k",
          VITE_FIREBASE_APPCHECK_PROVIDER: v,
        }),
      ).toEqual({ kind: "recaptcha-v3", siteKey: "k" });
    }
  });

  it("accepts the enterprise spellings", () => {
    for (const v of [
      "enterprise",
      "ENTERPRISE",
      "recaptcha-enterprise",
      " enterprise ",
    ]) {
      expect(
        planAppCheck({
          VITE_FIREBASE_APPCHECK_SITE_KEY: "k",
          VITE_FIREBASE_APPCHECK_PROVIDER: v,
        }),
      ).toEqual({ kind: "recaptcha-enterprise", siteKey: "k" });
    }
  });

  /**
   * A typo must NOT disable App Check: under Auth enforcement, "off" means every
   * sign-in is refused by Google, whereas a wrong provider fails loudly at token fetch.
   * Defaulting is the less destructive of the two.
   */
  it("warns and falls back to enterprise on an unrecognized provider", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      planAppCheck({
        VITE_FIREBASE_APPCHECK_SITE_KEY: "k",
        VITE_FIREBASE_APPCHECK_PROVIDER: "turnstile",
      }),
    ).toEqual({ kind: "recaptcha-enterprise", siteKey: "k" });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toMatch(/turnstile/);
  });

  it("trims the site key so a copy-paste newline can't break attestation", () => {
    expect(
      planAppCheck({ VITE_FIREBASE_APPCHECK_SITE_KEY: "  site-abc\n" }),
    ).toEqual({ kind: "recaptcha-enterprise", siteKey: "site-abc" });
  });
});

/**
 * The message IS the feature. Firebase reports `appCheck/recaptcha-error` from inside
 * firebase/auth without naming the provider we chose or what to change, and the SPA
 * keeps working until enforcement is flipped on — so the first real symptom is a total
 * sign-in outage behind an error that reads like a network/CSP problem. These tests pin
 * the parts that make it actionable, because the alternative is only ever reading this
 * copy during an outage.
 */
describe("explainAppCheckFailure", () => {
  const V3 = { kind: "recaptcha-v3", siteKey: "6Lsite" } as const;
  const ENT = { kind: "recaptcha-enterprise", siteKey: "6Lsite" } as const;
  const recaptchaErr = { code: "appCheck/recaptcha-error" };

  it("names the ACTIVE provider and the key that is actually deployed", () => {
    const msg = explainAppCheckFailure(V3, recaptchaErr);
    expect(msg).toContain("recaptcha-v3");
    // Site keys are public by design (inlined in the bundle), so echoing it is safe and
    // makes "which key is live?" answerable from a screenshot.
    expect(msg).toContain("6Lsite");
    // The code is echoed with Firebase's OWN casing: someone searching their console for
    // the string firebase printed must find our line too.
    expect(msg).toContain("appCheck/recaptcha-error");
  });

  /** Matching is case-insensitive even though display is verbatim. */
  it("still classifies a code whose casing differs from Firebase's", () => {
    expect(
      explainAppCheckFailure(V3, { code: "APPCHECK/RECAPTCHA-ERROR" }),
    ).toMatch(/DOES THE KEY RESOLVE/);
  });

  /**
   * A 200 from `render=` proves the key LOADS, not which provider to use — a freshly created
   * score-based key returned 200 from BOTH endpoints (measured), so the earlier "200 on exactly
   * one tells you the type" advice was wrong. The Firebase App Check registration is what decides.
   */
  it("does not claim a 200 identifies the provider", () => {
    const msg = explainAppCheckFailure(V3, recaptchaErr);
    expect(msg).not.toMatch(/200 on exactly one/);
    expect(msg).toMatch(/App Check → Apps registered/);
  });

  /** The swap is a SECRET change, not a code change — the cheapest fix, so it leads. */
  it("suggests the OPPOSITE provider, in the direction that fixes it", () => {
    expect(explainAppCheckFailure(V3, recaptchaErr)).toContain(
      "VITE_FIREBASE_APPCHECK_PROVIDER=enterprise",
    );
    expect(explainAppCheckFailure(ENT, recaptchaErr)).toContain(
      "VITE_FIREBASE_APPCHECK_PROVIDER=v3",
    );
  });

  /** Setting it in the server .env changes nothing — the trap that costs a whole cycle. */
  it("says the provider is inlined at BUILD time", () => {
    expect(explainAppCheckFailure(V3, recaptchaErr)).toMatch(/BUILD time/);
  });

  it("covers the domain-allowlist and wrong-project causes too", () => {
    const msg = explainAppCheckFailure(ENT, recaptchaErr);
    expect(msg).toMatch(/allowed domains/);
    expect(msg).toMatch(/VITE_FIREBASE_PROJECT_ID/);
  });

  /**
   * The one real occurrence (#792) was a key Google returned 400 for on BOTH endpoints —
   * so provider type, domain allowlist and CSP were all red herrings. That check is also
   * the cheapest available (two curls, no browser, no release), so it must come FIRST or
   * the message sends people down the same wrong path we went down.
   */
  /**
   * Order changed on 2026-07-28, deliberately: the CHEAPEST check is not the most decisive one.
   *
   * `render=` is neither domain- nor provider-checked — it returns 200 for a live key even with a
   * bogus Referer (measured). Leading with it invites "200 on both ⇒ score-based ⇒ it must be the
   * provider", which is exactly the wrong turn I took: I recommended flipping to v3, and the v3
   * `clr` endpoint 400d the same as Enterprise's had. Which `clr` fails is the signal that
   * actually separates the causes, so it goes first.
   */
  it("leads with the which-clr-fails check, ahead of both the resolve curl and the provider swap", () => {
    const msg = explainAppCheckFailure(V3, recaptchaErr);
    const clr = msg.indexOf("WHICH `clr` 400s");
    const resolve = msg.indexOf("DOES THE KEY RESOLVE");
    // The step-2 HEADING, not the cross-reference to it inside step 0 — a bare
    // indexOf("WRONG PROVIDER") matches "⇒ WRONG PROVIDER, go to 2" and reads as out of order.
    const swap = msg.indexOf("2. WRONG PROVIDER");
    expect(clr).toBeGreaterThan(-1);
    expect(resolve).toBeGreaterThan(clr);
    expect(swap).toBeGreaterThan(resolve);
    // And it must say what BOTH failing means, or the reader repeats my mistake.
    expect(msg).toMatch(/BOTH 400.*provider is/s);
    // Copy-pasteable, with the real key substituted in — both endpoints, since a 400 on
    // both is what distinguishes "dead key" from "wrong provider".
    expect(msg).toContain("recaptcha/api.js?render=6Lsite");
    expect(msg).toContain("recaptcha/enterprise.js?render=6Lsite");
  });

  /**
   * #792's actual root cause: the key existed, but as a CHALLENGE-BASED (checkbox) key.
   * `render=` rejects those outright, and App Check — which calls execute() with no user
   * interaction — can only use a score-based key. Key type is immutable, so "create a new
   * one" is the fix and nothing about the provider setting helps. Named explicitly because
   * the generic "check for a typo" advice sends you looking for a problem that isn't there.
   */
  it("names the checkbox-key cause for a 400 on both endpoints", () => {
    const msg = explainAppCheckFailure(V3, recaptchaErr);
    expect(msg).toMatch(/CHALLENGE-BASED \(checkbox\)/);
    expect(msg).toMatch(/SCORE-BASED/);
    expect(msg).toMatch(/immutable/);
  });

  /** A DIFFERENT failure: reCAPTCHA worked, the App Check exchange didn't. */
  it("distinguishes a fetch-status error from a reCAPTCHA error", () => {
    const msg = explainAppCheckFailure(V3, {
      code: "appCheck/fetch-status-error",
    });
    expect(msg).toMatch(/not registered with this provider/);
    // …and does NOT send the reader off to swap providers, which would not help here.
    expect(msg).not.toContain("VITE_FIREBASE_APPCHECK_PROVIDER=");
  });

  it("explains the throttle instead of looking like a new error", () => {
    expect(explainAppCheckFailure(V3, { code: "appCheck/throttled" })).toMatch(
      /backoff clears on its own/,
    );
  });

  /** Always present: it is the difference between "noisy console" and "nobody can log in". */
  it("always states the enforcement blast radius and how to roll back", () => {
    for (const err of [recaptchaErr, { code: "weird" }, new Error("nope")]) {
      const msg = explainAppCheckFailure(ENT, err);
      expect(msg).toMatch(/enforcement is ON/);
      expect(msg).toMatch(/Firebase Authentication/);
    }
  });

  it("adds the debug-token step only for a dev build", () => {
    expect(explainAppCheckFailure(V3, recaptchaErr, true)).toMatch(
      /Manage debug tokens/,
    );
    expect(explainAppCheckFailure(V3, recaptchaErr, false)).not.toMatch(
      /Manage debug tokens/,
    );
  });

  it("survives an error with no code at all", () => {
    expect(explainAppCheckFailure(V3, undefined)).toContain("unknown error");
  });
});
