import { randomBytes } from "node:crypto";
import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import {
  type FirebaseUser,
  secondFactorFromClaims,
} from "../auth/firebase-verifier";
import { ssoSessionSecret, ssoSessionTtlSeconds } from "../config";

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
    @Optional()
    @Inject(SSO_ENV)
    envOverride?: Record<string, string | undefined>,
  ) {
    const raw = ssoSessionSecret(envOverride);
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
    const ttl = ssoSessionTtlSeconds(envOverride);
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
   * Verify a session token → the authenticated user AND the ONE workspace it may act in, or
   * null (⇒ the guard 401s). The user shape matches a Firebase user so the whole downstream
   * path (allowlist, MFA gate, invitation accept-on-login, membership resolution) is shared,
   * not duplicated.
   *
   * WHY THE TENANT COMES BACK WITH THE USER (security-critical, see SAML-SSO.md "A session is
   * confined to one workspace"): an SSO identity is asserted by ONE tenant's IdP, so it must
   * never be usable outside that tenant. A Firebase identity proves mailbox ownership
   * instance-wide; a SAML identity proves only "this IdP says so", and that IdP speaks for a
   * single workspace. Handing the guard a global identity would let a workspace's own IdP mint
   * an `email_verified` principal for any address, which every email-keyed path in the
   * instance (invitation accept-on-login, company member resolution) would then honour.
   *
   * `claimTenant` is deliberately LEFT UNSET: the legacy `tenant` claim is a transitional
   * OWNER grant, so putting the connection's tenant there would silently promote every
   * federated user to owner. Authority stays the Membership row the ACS wrote; the returned
   * `tenantId` is a CONFINEMENT, not a grant.
   */
  async verify(
    token: string,
  ): Promise<{ user: FirebaseUser; tenantId: string } | null> {
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
      const tenantId = typeof payload.tenant === "string" ? payload.tenant : "";
      // A session with no tenant cannot be confined, so it is not a session. (Belt and
      // braces: `mint` always sets it.)
      if (userId.length === 0 || tenantId.length === 0) return null;
      return {
        tenantId,
        user: {
          userId,
          email: typeof payload.email === "string" ? payload.email : undefined,
          // The IdP asserted this address and the signature was verified, so it counts as
          // verified WITHIN this workspace — which is why the guard confines the session to
          // `tenantId`. This is what lets invitation accept-on-login work for a federated
          // user (SAML-SSO.md "Provisioning / linking", step 2), scoped to that workspace.
          emailVerified: payload.email_verified === true,
          name: typeof payload.name === "string" ? payload.name : undefined,
          secondFactor: secondFactorFromClaims(
            payload as Record<string, unknown>,
          ),
        },
      };
    } catch {
      // Expired / tampered / wrong secret / wrong iss-aud — all indistinguishable to the
      // caller on purpose (no oracle), and nothing about the token is logged.
      return null;
    }
  }
}
