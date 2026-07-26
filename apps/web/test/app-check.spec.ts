import { afterEach, describe, expect, it, vi } from "vitest";
import { planAppCheck } from "../src/lib/app-check";

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
