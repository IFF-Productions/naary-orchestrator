import { describe, expect, it } from "vitest";
import {
  authErrorMessage,
  captureRedirectFailure,
  oneShot,
  shouldRetryWithRedirect,
} from "../src/lib/auth-errors";

/**
 * The sign-in screen used to render Firebase's `e.message` verbatim, so a blocked popup showed
 * `Firebase: Error (auth/popup-blocked).` — a dead end that reads like a crash. Pure mapper, so
 * the copy is pinned here rather than only ever seen by a stuck visitor.
 */
describe("authErrorMessage", () => {
  it("explains a blocked popup and what will happen next", () => {
    const msg = authErrorMessage({ code: "auth/popup-blocked" });
    expect(msg).toMatch(/blocked/i);
    expect(msg).toMatch(/pop-?ups/i);
    // Never leaks the raw Firebase shape.
    expect(msg).not.toMatch(/Firebase:/);
    expect(msg).not.toMatch(/auth\/popup-blocked/);
  });

  /**
   * Firebase collapses wrong-password and unknown-email into one code precisely so an attacker
   * can't enumerate accounts. Our copy must not undo that by naming which half was wrong.
   */
  it("gives credential failures ONE message that doesn't reveal whether the email exists", () => {
    const messages = [
      "auth/invalid-credential",
      "auth/wrong-password",
      "auth/user-not-found",
    ].map((code) => authErrorMessage({ code }));
    expect(new Set(messages).size).toBe(1);
    expect(messages[0]).not.toMatch(/no account|not registered|unknown email/i);
  });

  it("names an App Check refusal, which otherwise looks like nothing at all", () => {
    expect(
      authErrorMessage({ code: "auth/firebase-app-check-token-is-invalid" }),
    ).toMatch(/App Check/);
  });

  /** An unrecognized code must stay visible — that is exactly when someone needs to search it. */
  it("keeps an unmapped code in the message instead of hiding it", () => {
    expect(authErrorMessage({ code: "auth/some-new-thing" })).toBe(
      "Sign-in failed (auth/some-new-thing).",
    );
  });

  it("falls back safely for non-Firebase errors and for nothing at all", () => {
    expect(authErrorMessage(new Error("Login isn’t configured."))).toBe(
      "Login isn’t configured.",
    );
    // A Firebase-shaped message with no code attached still shouldn't show the prefix.
    expect(authErrorMessage(new Error("Firebase: something odd"))).toBe(
      "something odd",
    );
    expect(authErrorMessage(undefined)).toBe("Authentication failed.");
    expect(authErrorMessage({})).toBe("Authentication failed.");
  });
});

/**
 * The redirect return leg is the one auth failure nobody ever saw: the SDK completes it during
 * init and its catch is `// Swallow any errors here`, so a refused redirect just puts the visitor
 * back on the sign-in form. This is the seam that gets the error back out.
 */
describe("captureRedirectFailure", () => {
  it("is null when the redirect succeeded — or when there was no redirect at all", async () => {
    expect(await captureRedirectFailure(Promise.resolve({ user: {} }))).toBe(
      null,
    );
    // getRedirectResult resolves null on an ordinary page load; that is not a failure.
    expect(await captureRedirectFailure(Promise.resolve(null))).toBe(null);
  });

  it("maps a failed redirect to the same human message as any other auth failure", async () => {
    const msg = await captureRedirectFailure(
      Promise.reject({ code: "auth/firebase-app-check-token-is-invalid" }),
    );
    expect(msg).toBe(
      authErrorMessage({ code: "auth/firebase-app-check-token-is-invalid" }),
    );
    expect(msg).toMatch(/App Check/);
  });

  /**
   * This wraps a promise created at MODULE LOAD. If it ever rejected, every visit to the sign-in
   * screen after a failed redirect would log an unhandled rejection attributable to nothing.
   */
  it("never rejects, whatever it is handed", async () => {
    await expect(
      captureRedirectFailure(Promise.reject(new Error("boom"))),
    ).resolves.toBe("boom");
    await expect(
      captureRedirectFailure(Promise.reject(undefined)),
    ).resolves.toBe("Authentication failed.");
  });
});

describe("oneShot", () => {
  it("delivers the outcome to the first reader and nothing to the rest", async () => {
    const take = oneShot(Promise.resolve("App Check refused the sign-in."));
    expect(await take()).toBe("App Check refused the sign-in.");
    // A visitor who signs in another way, signs out, and returns to /auth must not meet the
    // failure from a page load two sessions ago.
    expect(await take()).toBe(null);
    expect(await take()).toBe(null);
  });

  it("does not run the outcome twice or reject", async () => {
    let reads = 0;
    const take = oneShot(Promise.resolve(null).then(() => (reads++, null)));
    await take();
    await take();
    expect(reads).toBe(1);
  });
});

/**
 * The redirect fallback navigates the whole page, so it must fire ONLY when the popup never
 * opened. Retrying after a popup the visitor deliberately closed would turn their cancel into a
 * surprise full-page redirect.
 */
describe("shouldRetryWithRedirect", () => {
  it("retries when the popup was blocked or is unsupported here", () => {
    expect(shouldRetryWithRedirect({ code: "auth/popup-blocked" })).toBe(true);
    expect(
      shouldRetryWithRedirect({
        code: "auth/operation-not-supported-in-this-environment",
      }),
    ).toBe(true);
  });

  it("does NOT retry a popup the visitor closed, or a superseded one", () => {
    expect(shouldRetryWithRedirect({ code: "auth/popup-closed-by-user" })).toBe(
      false,
    );
    expect(
      shouldRetryWithRedirect({ code: "auth/cancelled-popup-request" }),
    ).toBe(false);
  });

  it("does NOT retry unrelated failures", () => {
    expect(shouldRetryWithRedirect({ code: "auth/wrong-password" })).toBe(
      false,
    );
    expect(shouldRetryWithRedirect(new Error("boom"))).toBe(false);
    expect(shouldRetryWithRedirect(undefined)).toBe(false);
  });
});
