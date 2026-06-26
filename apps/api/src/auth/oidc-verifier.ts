import { Injectable } from "@nestjs/common";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export interface OidcConfig {
  issuer: string;
  audience?: string;
  /** Claim that carries the tenant id (Keycloak protocol mapper). Default "tenant". */
  tenantClaim: string;
  /**
   * Where to fetch the realm JWKS, when it differs from `${issuer}/protocol/...`.
   * Needed when the browser and the API reach Keycloak on different hostnames
   * (e.g. dockerized API): tokens carry `iss = http://localhost:8080/...` (what the
   * browser used), but the API must fetch keys over the docker network at
   * `http://keycloak:8080/...`. JWKS content is host-independent, so the signature
   * still validates. Unset → derived from the issuer (host-dev, where they match).
   */
  jwksUri?: string;
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
      jwksUri: process.env.OIDC_JWKS_URI || undefined,
    };
  }

  get enabled(): boolean {
    return this.config !== undefined;
  }

  /** Verify a JWT → principal, or null (disabled / invalid / missing tenant claim). */
  async verify(token: string): Promise<OidcPrincipal | null> {
    if (!this.config) return null;
    if (!this.keySource) {
      const jwksUri =
        this.config.jwksUri ??
        `${this.config.issuer}/protocol/openid-connect/certs`;
      this.keySource = createRemoteJWKSet(new URL(jwksUri));
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
