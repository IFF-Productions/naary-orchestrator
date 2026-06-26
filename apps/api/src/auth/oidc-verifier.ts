import { Injectable } from "@nestjs/common";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export interface OidcConfig {
  issuer: string;
  audience?: string;
  /** Claim that carries the tenant id (Keycloak protocol mapper). Default "tenant". */
  tenantClaim: string;
}

export interface OidcPrincipal {
  tenantId: string;
  subject: string;
}

/**
 * Verifies a Keycloak (OIDC) access token: RS256 signature via the realm JWKS,
 * plus issuer / audience / expiry. tenantId comes from a `tenant` claim mapped on
 * the user (decision A). OIDC is OFF unless OIDC_ISSUER is set — then the guard
 * accepts a JWT alongside API tokens (dual auth). The key source is injectable so
 * tests verify against a local key without a running Keycloak.
 */
@Injectable()
export class OidcVerifier {
  private readonly config?: OidcConfig;
  private keySource?: JWTVerifyGetKey;

  constructor(config?: OidcConfig, keySource?: JWTVerifyGetKey) {
    this.config = config ?? OidcVerifier.fromEnv();
    this.keySource = keySource;
  }

  static fromEnv(): OidcConfig | undefined {
    const issuer = process.env.OIDC_ISSUER;
    if (!issuer) return undefined;
    return {
      issuer,
      // "" would make jose reject every token; treat empty as "no audience check".
      audience: process.env.OIDC_AUDIENCE || undefined,
      tenantClaim: process.env.OIDC_TENANT_CLAIM ?? "tenant",
    };
  }

  get enabled(): boolean {
    return this.config !== undefined;
  }

  /** Verify a JWT → principal, or null (disabled / invalid / missing tenant claim). */
  async verify(token: string): Promise<OidcPrincipal | null> {
    if (!this.config) return null;
    if (!this.keySource) {
      this.keySource = createRemoteJWKSet(
        new URL(`${this.config.issuer}/protocol/openid-connect/certs`),
      );
    }
    try {
      const { payload } = await jwtVerify(token, this.keySource, {
        issuer: this.config.issuer,
        audience: this.config.audience,
        algorithms: ["RS256"], // Keycloak realm signing alg; defense-in-depth.
      });
      const tenantId = payload[this.config.tenantClaim];
      if (typeof tenantId !== "string" || tenantId.length === 0) return null;
      return { tenantId, subject: String(payload.sub ?? "") };
    } catch {
      return null; // bad signature / issuer / audience / expiry
    }
  }
}
