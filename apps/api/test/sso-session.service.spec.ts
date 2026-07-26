import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import {
  SSO_TOKEN_PREFIX,
  SsoSessionService,
} from "../src/sso/sso-session.service";

const SECRET = "a".repeat(48);
const svc = (env: Record<string, string | undefined> = {}) =>
  new SsoSessionService({ SSO_SESSION_SECRET: SECRET, ...env });

const claims = {
  userId: "user-123",
  email: "alice@corp.example.com",
  tenantId: "ws-1",
  name: "Alice Example",
  mfa: false,
};

describe("SsoSessionService — configuration", () => {
  it("is disabled without SSO_SESSION_SECRET", async () => {
    const s = new SsoSessionService({});
    expect(s.enabled).toBe(false);
    expect(await s.verify(`${SSO_TOKEN_PREFIX}whatever`)).toBeNull();
    await expect(s.mint(claims)).rejects.toThrow(/not configured/);
  });

  it("refuses a too-short secret rather than signing with it", async () => {
    const s = new SsoSessionService({ SSO_SESSION_SECRET: "short" });
    expect(s.enabled).toBe(false);
    await expect(s.mint(claims)).rejects.toThrow(/not configured/);
  });

  it("only claims tokens with the nrys_ prefix (so the guard's other branches are untouched)", () => {
    const s = svc();
    expect(s.isSessionToken("nrys_abc")).toBe(true);
    expect(s.isSessionToken("nry_abc")).toBe(false); // API token
    expect(s.isSessionToken("eyJhbGciOi...")).toBe(false); // Firebase ID token
  });
});

describe("SsoSessionService — mint / verify round trip", () => {
  it("round-trips the identity and marks the email verified", async () => {
    const s = svc();
    const token = await s.mint(claims);
    expect(token.startsWith(SSO_TOKEN_PREFIX)).toBe(true);
    const session = await s.verify(token);
    expect(session?.user).toMatchObject({
      userId: "user-123",
      email: "alice@corp.example.com",
      emailVerified: true,
      name: "Alice Example",
    });
    // The session is CONFINED to the workspace whose IdP asserted it (the guard enforces this).
    expect(session?.tenantId).toBe("ws-1");
  });

  it("NEVER sets claimTenant (that would be a legacy OWNER grant)", async () => {
    const s = svc();
    const session = await s.verify(await s.mint({ ...claims, tenantId: "ws-9" }));
    const user = session?.user;
    // The tenant travels in the token for diagnostics, but the guard must resolve access from
    // the Membership table — a claimTenant would silently make every federated user an owner.
    expect(user?.claimTenant).toBeUndefined();
  });

  it("an IdP-asserted second factor surfaces as secondFactor (satisfies REQUIRE_MFA)", async () => {
    const s = svc();
    const withMfa = await s.verify(await s.mint({ ...claims, mfa: true }));
    expect(withMfa?.user.secondFactor).toBe("mfa");
    const without = await s.verify(await s.mint({ ...claims, mfa: false }));
    expect(without?.user.secondFactor).toBeUndefined(); // fails CLOSED under REQUIRE_MFA
  });

  it("rejects a tampered token", async () => {
    const s = svc();
    const token = await s.mint(claims);
    const [head, payload, signature] = token
      .slice(SSO_TOKEN_PREFIX.length)
      .split(".");
    const forged = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    forged.sub = "attacker";
    const swapped = `${SSO_TOKEN_PREFIX}${head}.${Buffer.from(
      JSON.stringify(forged),
    ).toString("base64url")}.${signature}`;
    expect(await s.verify(swapped)).toBeNull();
  });

  it("rejects a token signed with a different secret", async () => {
    const minted = await svc().mint(claims);
    const other = new SsoSessionService({ SSO_SESSION_SECRET: "b".repeat(48) });
    expect(await other.verify(minted)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const s = svc({ SSO_SESSION_TTL_SECONDS: "1" });
    const token = await s.mint(claims);
    // jose reads the clock via `new Date()`, so overriding Date.now is not enough — move the
    // whole system clock past `exp`.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 60_000));
    try {
      expect(await s.verify(token)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an alg=none / unsigned token (no algorithm confusion)", async () => {
    const s = svc();
    const header = Buffer.from(
      JSON.stringify({ alg: "none", typ: "JWT" }),
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        sub: "attacker",
        iss: "naary-sso",
        aud: "naary-api",
        exp: Math.floor(Date.now() / 1000) + 600,
      }),
    ).toString("base64url");
    expect(
      await s.verify(`${SSO_TOKEN_PREFIX}${header}.${payload}.`),
    ).toBeNull();
  });

  it("the token body carries identity only — no signing secret, no assertion", async () => {
    const token = await svc().mint(claims);
    const payload = JSON.parse(
      Buffer.from(
        token.slice(SSO_TOKEN_PREFIX.length).split(".")[1],
        "base64url",
      ).toString("utf8"),
    );
    expect(Object.keys(payload).sort()).toEqual([
      "aud",
      "email",
      "email_verified",
      "exp",
      "iat",
      "iss",
      "jti",
      "name",
      "sub",
      "tenant",
    ]);
    expect(JSON.stringify(payload)).not.toContain(SECRET);
    expect(JSON.stringify(payload)).not.toContain("SAMLResponse");
  });
});
