import { describe, expect, it, vi } from "vitest";
import {
  FirebaseVerifier,
  principalFromClaims,
} from "../src/auth/firebase-verifier";

describe("principalFromClaims", () => {
  it("maps a tenant claim + uid to a principal", () => {
    expect(
      principalFromClaims({ tenant: "t-9", uid: "user-42" }, "tenant"),
    ).toEqual({ tenantId: "t-9", subject: "user-42" });
  });

  it("falls back to sub when uid is absent", () => {
    expect(
      principalFromClaims({ tenant: "t-9", sub: "s-1" }, "tenant"),
    ).toEqual({ tenantId: "t-9", subject: "s-1" });
  });

  it("rejects a missing tenant claim (no tenant ⇒ cannot authenticate)", () => {
    expect(principalFromClaims({ uid: "u" }, "tenant")).toBeNull();
  });

  it("rejects an empty or non-string tenant claim", () => {
    expect(principalFromClaims({ tenant: "" }, "tenant")).toBeNull();
    expect(principalFromClaims({ tenant: 123 }, "tenant")).toBeNull();
  });

  it("honors a custom claim name", () => {
    expect(principalFromClaims({ org: "acme", uid: "u" }, "org")).toEqual({
      tenantId: "acme",
      subject: "u",
    });
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

  it("verifies a token via the injected verify fn → principal", async () => {
    const verify = vi.fn().mockResolvedValue({ tenant: "t-1", uid: "u-1" });
    const v = new FirebaseVerifier(config, verify);
    expect(v.enabled).toBe(true);
    expect(await v.verify("good.jwt")).toEqual({
      tenantId: "t-1",
      subject: "u-1",
    });
    expect(verify).toHaveBeenCalledWith("good.jwt");
  });

  it("returns null when the verify fn throws (bad signature / expiry)", async () => {
    const verify = vi.fn().mockRejectedValue(new Error("invalid token"));
    expect(await new FirebaseVerifier(config, verify).verify("bad")).toBeNull();
  });

  it("returns null when the verified token has no tenant claim", async () => {
    const verify = vi.fn().mockResolvedValue({ uid: "u-1" });
    expect(await new FirebaseVerifier(config, verify).verify("ok")).toBeNull();
  });
});
