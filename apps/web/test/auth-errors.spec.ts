import { describe, expect, it } from "vitest";
import {
  authErrorMessage,
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
