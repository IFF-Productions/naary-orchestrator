import { Injectable } from "@nestjs/common";
import {
  type App,
  applicationDefault,
  cert,
  getApps,
  initializeApp,
} from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

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
  /** Legacy `tenant` custom claim, if present. A TRANSITIONAL owner grant for existing
   *  single-tenant users — the AuthGuard migrates it to a Membership on first request.
   *  Undefined for new (post-provisioning) users. */
  claimTenant?: string;
}

/** A verify function over the raw token → decoded claims. Injectable so the
 *  verifier is unit-testable without firebase-admin / a live project. */
export type VerifyIdToken = (token: string) => Promise<Record<string, unknown>>;

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
    claimTenant:
      typeof claim === "string" && claim.length > 0 ? claim : undefined,
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

  constructor(config?: FirebaseConfig, verifyFn?: VerifyIdToken) {
    this.config = config ?? FirebaseVerifier.fromEnv();
    this.verifyFn = verifyFn;
  }

  static fromEnv(): FirebaseConfig | undefined {
    const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    const hasAdc = Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS);
    // verifyIdToken requires a service-account credential (Firebase docs) — so
    // Firebase auth is only enabled when one is supplied.
    if (!serviceAccountJson && !hasAdc) return undefined;
    return {
      projectId: process.env.FIREBASE_PROJECT_ID || undefined,
      serviceAccountJson: serviceAccountJson || undefined,
      tenantClaim: process.env.FIREBASE_TENANT_CLAIM ?? "tenant",
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
      const claims = await verify(token);
      return userFromClaims(claims, this.config.tenantClaim);
    } catch {
      return null; // bad signature / issuer / audience / expiry / revoked
    }
  }

  private resolveVerifyFn(): VerifyIdToken {
    if (!this.verifyFn) {
      const auth = getAuth(this.initApp());
      this.verifyFn = async (token) =>
        (await auth.verifyIdToken(token)) as unknown as Record<string, unknown>;
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
