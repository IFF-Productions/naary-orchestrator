import "reflect-metadata";
import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWK,
  type KeyLike,
} from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { OidcVerifier, type OidcConfig } from "../src/auth/oidc-verifier";

const ISSUER = "https://keycloak.test/realms/naary";
const AUDIENCE = "naary-api";
const CONFIG: OidcConfig = {
  issuer: ISSUER,
  audience: AUDIENCE,
  tenantClaim: "tenant",
};

let privateKey: KeyLike;
let publicJwk: JWK;

/** A local JWKS getter so we verify against an in-memory key, no running Keycloak. */
function localKeySource() {
  return async () => {
    const { importJWK } = await import("jose");
    return importJWK(publicJwk, "RS256");
  };
}

function verifier(config: OidcConfig | undefined = CONFIG): OidcVerifier {
  return new OidcVerifier(config, config ? localKeySource() : undefined);
}

interface ClaimOverrides {
  tenant?: unknown;
  iss?: string;
  aud?: string;
  expSecondsFromNow?: number;
  sub?: string;
}

async function sign(overrides: ClaimOverrides = {}): Promise<string> {
  const {
    iss = ISSUER,
    aud = AUDIENCE,
    expSecondsFromNow = 300,
    sub = "user-1",
  } = overrides;
  // Distinguish "omit the tenant claim" (key present, value undefined) from default.
  const tenant = "tenant" in overrides ? overrides.tenant : "t-1";
  const payload: Record<string, unknown> = {};
  if (tenant !== undefined) payload.tenant = tenant;
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(iss)
    .setAudience(aud)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime(`${expSecondsFromNow}s`)
    .sign(privateKey);
}

beforeAll(async () => {
  const kp = await generateKeyPair("RS256");
  privateKey = kp.privateKey;
  publicJwk = await exportJWK(kp.publicKey);
});

describe("OidcVerifier", () => {
  it("is disabled (and verify() returns null) when no issuer is configured", async () => {
    const saved = process.env.OIDC_ISSUER;
    delete process.env.OIDC_ISSUER;
    try {
      const v = new OidcVerifier(); // falls back to fromEnv() → undefined config
      expect(v.enabled).toBe(false);
      expect(await v.verify(await sign())).toBeNull();
    } finally {
      if (saved !== undefined) process.env.OIDC_ISSUER = saved;
    }
  });

  it("is enabled when an issuer is configured", () => {
    expect(verifier().enabled).toBe(true);
  });

  it("returns { tenantId, subject } for a valid token", async () => {
    const p = await verifier().verify(
      await sign({ tenant: "t-42", sub: "u-7" }),
    );
    expect(p).toEqual({ tenantId: "t-42", subject: "u-7" });
  });

  it("rejects a token from the wrong issuer", async () => {
    const token = await sign({ iss: "https://evil.example/realms/naary" });
    expect(await verifier().verify(token)).toBeNull();
  });

  it("rejects a token with the wrong audience", async () => {
    const token = await sign({ aud: "some-other-client" });
    expect(await verifier().verify(token)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const token = await sign({ expSecondsFromNow: -10 });
    expect(await verifier().verify(token)).toBeNull();
  });

  it("rejects a token missing the tenant claim", async () => {
    const token = await sign({ tenant: undefined });
    expect(await verifier().verify(token)).toBeNull();
  });

  it("rejects a token whose tenant claim is not a non-empty string", async () => {
    expect(await verifier().verify(await sign({ tenant: "" }))).toBeNull();
    expect(await verifier().verify(await sign({ tenant: 123 }))).toBeNull();
  });

  it("honours a custom tenant claim name", async () => {
    const cfg: OidcConfig = { ...CONFIG, tenantClaim: "org_id" };
    const v = new OidcVerifier(cfg, localKeySource());
    const token = await new SignJWT({ org_id: "t-org" })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject("u-9")
      .setIssuedAt()
      .setExpirationTime("300s")
      .sign(privateKey);
    expect(await v.verify(token)).toEqual({
      tenantId: "t-org",
      subject: "u-9",
    });
  });
});
