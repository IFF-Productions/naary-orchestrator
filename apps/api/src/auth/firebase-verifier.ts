import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import {
  type App,
  applicationDefault,
  cert,
  getApps,
  initializeApp,
} from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import {
  firebaseProjectId,
  firebaseServiceAccountJson,
  firebaseTenantClaim,
  googleApplicationCredentials,
} from "../config";

export interface FirebaseConfig {
  /** Firebase project id (also derivable from the service account). */
  projectId?: string;
  /** Raw service-account JSON (FIREBASE_SERVICE_ACCOUNT_JSON), if provided inline. */
  serviceAccountJson?: string;
  /** Custom claim carrying the tenant id (set via setCustomUserClaims). Default "tenant". */
  tenantClaim: string;
}

/** The authenticated Firebase user (design §3 — the token authenticates the USER,
 *  not a tenant). Workspace access is granted by a Membership row, resolved by the
 *  AuthGuard; this type carries only identity. */
export interface FirebaseUser {
  /** Firebase uid — the stable user identity. */
  userId: string;
  email?: string;
  emailVerified: boolean;
  /** The user's display name (`name` claim — set by Google sign-in or updateProfile). */
  name?: string;
  /** Legacy `tenant` custom claim, if present. A TRANSITIONAL owner grant for existing
   *  single-tenant users — the AuthGuard migrates it to a Membership on first request.
   *  Undefined for new (post-provisioning) users. */
  claimTenant?: string;
  /** The second factor THIS SESSION signed in with (#457), e.g. "phone" | "totp" — or
   *  undefined for a single-factor session. Firebase stamps the factor it used into the ID
   *  token, so the TOKEN (not our DB) is the authority on whether the user completed MFA.
   *  Deliberately optional rather than a boolean `false`: "no second factor" is the absence
   *  of a claim, and it leaves the shape of an ordinary user unchanged. */
  secondFactor?: string;
}

/**
 * Pure: which second factor did this ID token's session complete? (#457)
 *
 * Firebase Auth (Identity Platform) MFA puts the factor used into the token's `firebase`
 * claim as `sign_in_second_factor` — "phone" or "totp" — alongside `sign_in_provider`.
 * A single-factor sign-in simply omits it. As a secondary signal we accept a standard OIDC
 * `amr` (authentication-method-references) array carrying an MFA/OTP method, which some
 * Identity Platform configurations emit. That's safe to trust: `amr` is on firebase-admin's
 * RESERVED_CLAIMS list (auth-api-request.ts) alongside `firebase`/`sub`/`aud`, so neither
 * `setCustomUserClaims` nor a minted custom token can self-assert it — only the issuer can.
 *
 * Returns the factor name when present, else undefined — so a missing/unknown claim fails
 * CLOSED under enforcement (no factor ⇒ gated), never the other way around.
 */
export function secondFactorFromClaims(
  claims: Record<string, unknown>,
): string | undefined {
  const fb = claims.firebase;
  if (fb && typeof fb === "object" && !Array.isArray(fb)) {
    const sf = (fb as Record<string, unknown>).sign_in_second_factor;
    if (typeof sf === "string" && sf.trim().length > 0) return sf.trim();
  }
  const amr = claims.amr;
  if (Array.isArray(amr)) {
    const hit = amr.find(
      (m): m is string =>
        typeof m === "string" &&
        ["mfa", "otp", "sms", "totp"].includes(m.trim().toLowerCase()),
    );
    if (hit !== undefined) return hit.trim().toLowerCase();
  }
  return undefined;
}

/** A verify function over the raw token → decoded claims. Injectable so the
 *  verifier is unit-testable without firebase-admin / a live project. When
 *  `checkRevoked` is true the implementation must also confirm the token hasn't
 *  been revoked (a Google round-trip in the real impl); stubs may ignore it. */
export type VerifyIdToken = (
  token: string,
  checkRevoked?: boolean,
) => Promise<Record<string, unknown>>;

/**
 * Pure: decoded ID-token claims → the authenticated user, or null when there is no
 * user identity at all (no `uid`/`sub` — a token that names no user must never
 * authenticate). Unlike the old claim model, a MISSING tenant claim no longer rejects:
 * the token authenticates the user; a Membership (not the claim) authorizes a workspace.
 * The claim, when present, rides along as a transitional owner grant. Unit-tested in
 * isolation.
 */
export function userFromClaims(
  claims: Record<string, unknown>,
  tenantClaim: string,
): FirebaseUser | null {
  const userId = String(claims.uid ?? claims.sub ?? "");
  if (userId.length === 0) return null;
  const claim = claims[tenantClaim];
  return {
    userId,
    email: typeof claims.email === "string" ? claims.email : undefined,
    emailVerified: claims.email_verified === true,
    name:
      typeof claims.name === "string" && claims.name.trim().length > 0
        ? claims.name.trim()
        : undefined,
    claimTenant:
      typeof claim === "string" && claim.length > 0 ? claim : undefined,
    // #457: surface the MFA state of the SESSION so the guard can enforce an instance-wide
    // "require MFA" policy without any extra round-trip.
    secondFactor: secondFactorFromClaims(claims),
  };
}

/**
 * Verifies a Firebase ID token (RS256, signed by Google): firebase-admin's
 * `verifyIdToken` checks the signature against Google's public keys plus
 * issuer/audience (= the project) and expiry, then yields the authenticated USER
 * (uid/email). A legacy `tenant` custom claim (set via setCustomUserClaims — see
 * set-tenant-claim.ts), if present, rides along for migration; workspace access is
 * decided by Membership in the guard, not the claim. The guard accepts a Firebase JWT
 * alongside `nry_` API tokens (dual auth).
 *
 * Firebase requires a SERVICE ACCOUNT to verify ID tokens, so this is OFF unless
 * one is configured (FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS)
 * — keeping API-token-only deployments unchanged. The verify fn is injectable so
 * tests don't need firebase-admin.
 */
@Injectable()
export class FirebaseVerifier {
  private readonly config?: FirebaseConfig;
  private app?: App;
  private verifyFn?: VerifyIdToken;
  /** sha256(token) → epoch-ms of the last successful REVOCATION check (#598): a plain
   *  `verifyIdToken(token)` never notices a revoked/disabled user until the ID token
   *  expires (~1h). Checking revocation costs a Google round-trip, and `verify` runs on
   *  every request — so re-check each distinct token at most once per TTL. */
  private readonly revocationCheckedAt = new Map<string, number>();
  private static readonly REVOCATION_TTL_MS = 5 * 60_000;
  private static readonly REVOCATION_CACHE_MAX = 10_000;

  constructor(config?: FirebaseConfig, verifyFn?: VerifyIdToken) {
    this.config = config ?? FirebaseVerifier.fromEnv();
    this.verifyFn = verifyFn;
  }

  static fromEnv(): FirebaseConfig | undefined {
    const serviceAccountJson = firebaseServiceAccountJson();
    const hasAdc = Boolean(googleApplicationCredentials());
    // verifyIdToken requires a service-account credential (Firebase docs) — so
    // Firebase auth is only enabled when one is supplied.
    if (!serviceAccountJson && !hasAdc) return undefined;
    return {
      projectId: firebaseProjectId(),
      serviceAccountJson: serviceAccountJson || undefined,
      tenantClaim: firebaseTenantClaim(),
    };
  }

  get enabled(): boolean {
    return this.config !== undefined;
  }

  /** Verify a Firebase ID token → the authenticated user, or null (disabled / invalid /
   *  no user identity). */
  async verify(token: string): Promise<FirebaseUser | null> {
    if (!this.config) return null;
    try {
      const verify = this.resolveVerifyFn();
      const key = createHash("sha256").update(token).digest("hex");
      const last = this.revocationCheckedAt.get(key);
      const checkRevoked =
        last === undefined ||
        Date.now() - last > FirebaseVerifier.REVOCATION_TTL_MS;
      const claims = await verify(token, checkRevoked);
      if (checkRevoked) {
        // Bounded: reset rather than grow past the cap (tokens rotate hourly anyway).
        if (
          this.revocationCheckedAt.size >= FirebaseVerifier.REVOCATION_CACHE_MAX
        ) {
          this.revocationCheckedAt.clear();
        }
        this.revocationCheckedAt.set(key, Date.now());
      }
      return userFromClaims(claims, this.config.tenantClaim);
    } catch {
      return null; // bad signature / issuer / audience / expiry / revoked
    }
  }

  private resolveVerifyFn(): VerifyIdToken {
    if (!this.verifyFn) {
      const auth = getAuth(this.initApp());
      this.verifyFn = async (token, checkRevoked) =>
        (await auth.verifyIdToken(
          token,
          checkRevoked === true,
        )) as unknown as Record<string, unknown>;
    }
    return this.verifyFn;
  }

  private initApp(): App {
    if (this.app) return this.app;
    // Reuse an already-initialized default app (hot reload / the CLI) to avoid the
    // "app already exists" error.
    const existing = getApps();
    if (existing.length > 0) {
      this.app = existing[0];
      return this.app;
    }
    const cfg = this.config as FirebaseConfig;
    const credential = cfg.serviceAccountJson
      ? cert(JSON.parse(cfg.serviceAccountJson))
      : applicationDefault();
    this.app = initializeApp({
      credential,
      ...(cfg.projectId ? { projectId: cfg.projectId } : {}),
    });
    return this.app;
  }
}
