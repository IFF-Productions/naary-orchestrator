import { randomBytes } from "node:crypto";
import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import {
  type FirebaseUser,
  secondFactorFromClaims,
} from "../auth/firebase-verifier";

/**
 * The SSO session token (design SAML-SSO.md, #455).
 *
 * SAML terminates in OUR api (not Identity Platform), so after a verified assertion we have
 * to hand the browser something it can put in `Authorization: Bearer`. That is this: a
 * compact JWS (HS256 over `SSO_SESSION_SECRET`) with an `nrys_` prefix.
 *
 * The PREFIX is load-bearing. It is what lets `AuthGuard` pick an identity source without
 * reordering any existing branch — exactly the role `nry_` plays for API tokens. `@Public()`
 * and the `nry_` branch still return before the MFA gate; the SSO branch joins the Firebase
 * branch AFTER verification and BEFORE the instance-wide policies, so an SSO session is
 * subject to the same allowlist + `REQUIRE_MFA` rules (it is not a bypass).
 *
 * OFF unless configured: no `SSO_SESSION_SECRET` ⇒ `enabled === false`, minting refuses and
 * verification returns null. Nothing about a Firebase-only deployment changes.
 */

/** Bearer-token prefix identifying a Naary SSO session (cf. `nry_` for API tokens). */
export const SSO_TOKEN_PREFIX = "nrys_";

/** DI token for an env override. `@Optional()` so nothing has to provide it in production
 *  (the service falls back to `process.env`); tests inject a literal instead of mutating
 *  global env — and Nest must NOT try to auto-resolve a `Record` type. */
export const SSO_ENV = Symbol("SSO_ENV");

const ISSUER = "naary-sso";
const AUDIENCE = "naary-api";
/** Session lifetime. Deliberately short-ish: there is no refresh/renew in this slice, so a
 *  federated user re-authenticates at the IdP (usually silently) once a day. */
const DEFAULT_TTL_SECONDS = 8 * 60 * 60;

/** What the ACS asks to be minted. Identity facts only — never any assertion XML. */
export interface SsoSessionClaims {
  /** The resolved Membership.userId (an existing linked user, or the synthetic sso: id). */
  userId: string;
  email: string;
  /** The workspace the SsoConnection belongs to. NOT a legacy owner claim (see below). */
  tenantId: string;
  name?: string;
  /** True when the IdP asserted a second factor (AuthnContextClassRef). */
  mfa: boolean;
}

@Injectable()
export class SsoSessionService {
  private readonly logger = new Logger(SsoSessionService.name);
  private readonly secret?: Uint8Array;
  private readonly ttlSeconds: number;

  constructor(
    @Optional() @Inject(SSO_ENV) envOverride?: Record<string, string | undefined>,
  ) {
    const env = envOverride ?? process.env;
    const raw = (env.SSO_SESSION_SECRET ?? "").trim();
    // 32+ chars: this key signs sessions, so a short/guessable value would let anyone mint
    // a principal. Refuse quietly-but-loudly (log + stay disabled) rather than accept it.
    if (raw.length > 0 && raw.length < 32) {
      this.logger.error(
        "SSO_SESSION_SECRET is shorter than 32 characters — SAML SSO stays DISABLED",
      );
      this.secret = undefined;
    } else if (raw.length >= 32) {
      this.secret = new TextEncoder().encode(raw);
    }
    const ttl = Number(env.SSO_SESSION_TTL_SECONDS ?? "");
    this.ttlSeconds =
      Number.isFinite(ttl) && ttl > 0 ? Math.floor(ttl) : DEFAULT_TTL_SECONDS;
    this.logger.log(
      this.secret
        ? `SAML SSO sessions: enabled (ttl ${this.ttlSeconds}s)`
        : "SAML SSO sessions: disabled (no SSO_SESSION_SECRET)",
    );
  }

  /** Whether SSO login can work at all (mint + verify). */
  get enabled(): boolean {
    return this.secret !== undefined;
  }

  /** Cheap, allocation-free discriminator used by the guard to choose an identity source. */
  isSessionToken(token: string): boolean {
    return token.startsWith(SSO_TOKEN_PREFIX);
  }

  /**
   * Mint a session for a verified assertion. `jose` is ESM-only and the api is CJS under
   * `@swc/register`, so it is loaded via dynamic `import()` — the sanctioned CJS→ESM path
   * in this repo (see apps/worker/.../shared.ts).
   */
  async mint(claims: SsoSessionClaims): Promise<string> {
    if (!this.secret) throw new Error("SSO sessions are not configured");
    const { SignJWT } = await import("jose");
    const jwt = await new SignJWT({
      email: claims.email,
      email_verified: true,
      name: claims.name,
      tenant: claims.tenantId,
      // The #457 second-factor signal, in the shape `secondFactorFromClaims` already reads.
      // An IdP-asserted MFA context therefore satisfies REQUIRE_MFA with NO change to the
      // guard's enforcement line; its absence fails closed, like a single-factor Firebase
      // session. See SAML-SSO.md.
      ...(claims.mfa ? { amr: ["mfa"] } : {}),
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(claims.userId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${this.ttlSeconds}s`)
      .setJti(randomBytes(16).toString("hex"))
      .sign(this.secret);
    return `${SSO_TOKEN_PREFIX}${jwt}`;
  }

  /**
   * Verify a session token → the authenticated user, or null (⇒ the guard 401s). Returns the
   * SAME shape as a Firebase user so the whole downstream path (allowlist, MFA gate,
   * invitation accept-on-login, membership resolution) is shared, not duplicated.
   *
   * `claimTenant` is deliberately LEFT UNSET: the legacy `tenant` claim is a transitional
   * OWNER grant, so passing the connection's tenant here would silently promote every
   * federated user to owner. Authority stays the Membership row the ACS wrote.
   */
  async verify(token: string): Promise<FirebaseUser | null> {
    if (!this.secret || !this.isSessionToken(token)) return null;
    const compact = token.slice(SSO_TOKEN_PREFIX.length);
    try {
      const { jwtVerify } = await import("jose");
      const { payload } = await jwtVerify(compact, this.secret, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ["HS256"],
      });
      const userId = typeof payload.sub === "string" ? payload.sub : "";
      if (userId.length === 0) return null;
      return {
        userId,
        email: typeof payload.email === "string" ? payload.email : undefined,
        // The IdP asserted this address and the assertion signature was verified, so it is
        // verified by our trust model. This is what lets invitation accept-on-login work
        // for a federated user (SAML-SSO.md "Provisioning / linking", step 2).
        emailVerified: payload.email_verified === true,
        name: typeof payload.name === "string" ? payload.name : undefined,
        secondFactor: secondFactorFromClaims(
          payload as Record<string, unknown>,
        ),
      };
    } catch {
      // Expired / tampered / wrong secret / wrong iss-aud — all indistinguishable to the
      // caller on purpose (no oracle), and nothing about the token is logged.
      return null;
    }
  }
}
