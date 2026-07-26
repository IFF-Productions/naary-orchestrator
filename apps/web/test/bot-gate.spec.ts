import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveBotGate } from "../src/screens/public/bot-gate";

/**
 * Slice 2 of docs/design/TENANT-BOT-GATE-PROVIDERS.md. `resolveBotGate` is the single place the
 * public form and chat pages decide *whether there is a gate and which* — deliberately shared,
 * because drifting on it fails SILENTLY: a page renders no gate, sends no token, and the server
 * 403s every submission with nothing on screen to explain it.
 */
describe("resolveBotGate", () => {
  it("returns null when the definition advertises no gate", () => {
    expect(resolveBotGate({})).toBeNull();
  });

  it("passes a Turnstile gate through with its site key", () => {
    expect(
      resolveBotGate({ botGate: { provider: "turnstile", siteKey: "0xABC" } }),
    ).toEqual({ provider: "turnstile", siteKey: "0xABC" });
  });

  /** App Check carries NO key at all, so a page can only learn of it from `botGate`. */
  it("passes an App Check gate through", () => {
    expect(resolveBotGate({ botGate: { provider: "app_check" } })).toEqual({
      provider: "app_check",
    });
  });

  /**
   * The compatibility direction that actually matters: the PAGE is always the freshly-deployed
   * bundle, but the API it calls may be a release behind and send only `turnstileSiteKey`.
   */
  it("falls back to the deprecated turnstileSiteKey when an older API sends no botGate", () => {
    expect(resolveBotGate({ turnstileSiteKey: "0xOLD" })).toEqual({
      provider: "turnstile",
      siteKey: "0xOLD",
    });
  });

  /**
   * Both fields are emitted together for one release. `botGate` must win — otherwise an
   * `app_check` tenant whose response also carried a stale `turnstileSiteKey` would render a
   * Cloudflare widget whose token the server would then verify against App Check and reject.
   */
  it("prefers botGate over turnstileSiteKey when both are present", () => {
    expect(
      resolveBotGate({
        botGate: { provider: "app_check" },
        turnstileSiteKey: "0xSTALE",
      }),
    ).toEqual({ provider: "app_check" });
  });

  it("treats an empty turnstileSiteKey as no gate, not a keyless widget", () => {
    // #617 made a keyless, disabled config row legal (it holds allowedHostnames for embed CORS),
    // so an empty string is a shape we can actually be handed. Rendering Turnstile with `""`
    // would throw inside Cloudflare's script.
    expect(resolveBotGate({ turnstileSiteKey: "" })).toBeNull();
  });
});

/**
 * The App Check branch's token mint. Covered here for the case that matters most and is easiest
 * to get wrong: App Check absent from the build. It must return null (⇒ the page stops gating
 * and lets the server decide) and never throw, because this runs on an anonymous public page
 * where an exception is a blank screen.
 */
describe("mintBotGateToken with App Check uninitialized", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns null and warns rather than throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Imported here, not at top level: initAppCheck was never called in this process, which is
    // exactly the state under test (a build with no VITE_FIREBASE_APPCHECK_SITE_KEY).
    const { mintBotGateToken } = await import("../src/lib/app-check");
    await expect(mintBotGateToken()).resolves.toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toMatch(/not initialized in this build/);
  });
});
