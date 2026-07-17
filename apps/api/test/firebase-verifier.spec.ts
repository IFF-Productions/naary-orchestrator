import { describe, expect, it, vi } from "vitest";
import {
  FirebaseVerifier,
  userFromClaims,
} from "../src/auth/firebase-verifier";

describe("userFromClaims", () => {
  it("maps uid + email + email_verified to a user", () => {
    expect(
      userFromClaims(
        { uid: "user-42", email: "a@b.co", email_verified: true },
        "tenant",
      ),
    ).toEqual({
      userId: "user-42",
      email: "a@b.co",
      emailVerified: true,
      claimTenant: undefined,
    });
  });

  it("carries a legacy tenant claim as claimTenant (transitional grant)", () => {
    expect(userFromClaims({ uid: "u", tenant: "t-9" }, "tenant")).toEqual({
      userId: "u",
      email: undefined,
      emailVerified: false,
      claimTenant: "t-9",
    });
  });

  it("authenticates a user WITHOUT a tenant claim (membership is the authority)", () => {
    // The change from the old model: no claim no longer rejects — the token still names a
    // user; a Membership (not the claim) authorizes a workspace later, in the guard.
    expect(userFromClaims({ uid: "u" }, "tenant")).toEqual({
      userId: "u",
      email: undefined,
      emailVerified: false,
      claimTenant: undefined,
    });
  });

  it("falls back to sub when uid is absent", () => {
    expect(userFromClaims({ sub: "s-1", tenant: "t-9" }, "tenant")).toEqual({
      userId: "s-1",
      email: undefined,
      emailVerified: false,
      claimTenant: "t-9",
    });
  });

  it("rejects a token with no user identity (no uid/sub ⇒ cannot authenticate)", () => {
    expect(userFromClaims({ tenant: "t-9" }, "tenant")).toBeNull();
  });

  it("ignores an empty/non-string tenant claim (no transitional grant)", () => {
    expect(userFromClaims({ uid: "u", tenant: "" }, "tenant")).toMatchObject({
      claimTenant: undefined,
    });
    expect(userFromClaims({ uid: "u", tenant: 123 }, "tenant")).toMatchObject({
      claimTenant: undefined,
    });
  });

  it("honors a custom claim name", () => {
    expect(userFromClaims({ uid: "u", org: "acme" }, "org")).toMatchObject({
      claimTenant: "acme",
    });
  });

  it("carries the user's display name (name claim), trimmed; ignores blank/non-string", () => {
    expect(
      userFromClaims({ uid: "u", name: "  Hassan Al Rawi " }, "tenant"),
    ).toMatchObject({ name: "Hassan Al Rawi" });
    expect(userFromClaims({ uid: "u", name: "   " }, "tenant")).toMatchObject({
      name: undefined,
    });
    expect(userFromClaims({ uid: "u", name: 42 }, "tenant")).toMatchObject({
      name: undefined,
    });
  });

  it("only treats email_verified === true as verified", () => {
    expect(
      userFromClaims({ uid: "u", email_verified: "true" }, "tenant"),
    ).toHaveProperty("emailVerified", false);
  });
});

describe("FirebaseVerifier", () => {
  const config = { tenantClaim: "tenant" };

  it("is disabled (and verify → null) without a config", async () => {
    const v = new FirebaseVerifier(undefined, vi.fn());
    // No service account configured in the test env ⇒ fromEnv() returns undefined.
    expect(v.enabled).toBe(false);
    expect(await v.verify("any.jwt.token")).toBeNull();
  });

  it("verifies a token via the injected verify fn → user", async () => {
    const verify = vi
      .fn()
      .mockResolvedValue({ uid: "u-1", email: "a@b.co", tenant: "t-1" });
    const v = new FirebaseVerifier(config, verify);
    expect(v.enabled).toBe(true);
    expect(await v.verify("good.jwt")).toEqual({
      userId: "u-1",
      email: "a@b.co",
      emailVerified: false,
      claimTenant: "t-1",
    });
    expect(verify).toHaveBeenCalledWith("good.jwt");
  });

  it("returns null when the verify fn throws (bad signature / expiry)", async () => {
    const verify = vi.fn().mockRejectedValue(new Error("invalid token"));
    expect(await new FirebaseVerifier(config, verify).verify("bad")).toBeNull();
  });

  it("returns null when the verified token has no user identity", async () => {
    const verify = vi.fn().mockResolvedValue({ tenant: "t-1" });
    expect(await new FirebaseVerifier(config, verify).verify("ok")).toBeNull();
  });
});
