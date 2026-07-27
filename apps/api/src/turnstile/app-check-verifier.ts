import { Injectable } from "@nestjs/common";
import {
  type App,
  applicationDefault,
  cert,
  getApps,
  initializeApp,
} from "firebase-admin/app";
import { getAppCheck } from "firebase-admin/app-check";
import {
  firebaseProjectId,
  firebaseServiceAccountJson,
  googleApplicationCredentials,
} from "../config";

/**
 * Server-side Firebase App Check verification — the second bot-gate provider a tenant may pick for
 * their public form/chat pages (docs/design/TENANT-BOT-GATE-PROVIDERS.md).
 *
 * Unlike Turnstile, NOTHING here is tenant-supplied: App Check attests OUR Firebase project, so the
 * keys are the platform's and a token minted on one tenant's form page verifies against another's.
 * That is why the design calls it the weaker gate (§1) — it answers "did this come from our real
 * app?", not "did this submission pass a challenge?".
 *
 * Requires the same SERVICE ACCOUNT the ID-token verifier needs, so it is OFF in
 * API-token-only deployments; `enabled` is false and callers must not advertise the gate.
 * The verify fn is injectable so tests never touch firebase-admin or the network.
 */

/**
 * `ok` — attested. `denied` — a definite negative verdict (bad/expired token, or a replayed one).
 * `unavailable` — we could not get an answer (not configured, network/timeout), which callers treat
 * as "cannot enforce" and ALLOW, matching Turnstile's siteverify posture.
 */
export type AppCheckVerdict = "ok" | "denied" | "unavailable";

/** Injectable seam: resolves to firebase-admin's appCheck().verifyToken in production. */
export type VerifyAppCheckToken = (
  token: string,
) => Promise<{ alreadyConsumed?: boolean }>;

interface AppCheckConfig {
  projectId?: string;
  serviceAccountJson?: string;
}

/**
 * firebase-admin error codes that mean "the TOKEN is the problem" — a definite negative. Everything
 * else (network, timeout, JWKS fetch failure, an unrecognized SDK error) is classified as transport
 * and fails OPEN.
 *
 * The asymmetry with Turnstile is deliberate and worth stating: Cloudflare hands us an explicit
 * `success: false`, so we can be precise. App Check *throws*, so we have to classify — and the
 * design's posture is that a Google blip must not brick every public form (the tenant budget cap is
 * the real cost backstop). A forged or garbage token lands on `invalid-argument`, which is the attack
 * path that actually matters, so defaulting the residue to allow costs little.
 */
const TOKEN_ERROR_CODES = new Set([
  "app-check/invalid-argument",
  "app-check/invalid-credential",
]);

@Injectable()
export class AppCheckVerifier {
  private readonly config?: AppCheckConfig;
  private app?: App;
  private verifyFn?: VerifyAppCheckToken;

  constructor(config?: AppCheckConfig | null, verifyFn?: VerifyAppCheckToken) {
    // `null` means "explicitly disabled" (tests); `undefined` means "read the env".
    this.config =
      config === null ? undefined : (config ?? AppCheckVerifier.fromEnv());
    this.verifyFn = verifyFn;
    // An injected verify fn implies enabled, so tests can exercise the verdicts without env — but
    // an EXPLICIT `null` stays disabled (that's the contract the disabled-path tests rely on).
    if (verifyFn && config === undefined && !this.config) this.config = {};
  }

  static fromEnv(): AppCheckConfig | undefined {
    const serviceAccountJson = firebaseServiceAccountJson();
    const hasAdc = Boolean(googleApplicationCredentials());
    if (!serviceAccountJson && !hasAdc) return undefined;
    return {
      projectId: firebaseProjectId(),
      serviceAccountJson: serviceAccountJson || undefined,
    };
  }

  /** Whether we can verify at all. False ⇒ the gate must NOT be advertised or enforced. */
  get enabled(): boolean {
    return this.config !== undefined;
  }

  /**
   * Verify one App Check token.
   *
   * `consume: true` asks Firebase to spend the token so it can't be replayed. That only has teeth
   * when the client minted a LIMITED-USE token (`getLimitedUseToken()`) and replay protection is
   * enabled for the app in the Firebase console — neither is visible from here, so treat single-use
   * as best-effort until verified against the live project (design §3). When it does apply,
   * `alreadyConsumed: true` is a SUCCESSFUL verification with a definite answer: deny, never
   * fail-open.
   */
  async verify(token: string): Promise<AppCheckVerdict> {
    if (!this.config) return "unavailable";
    if (!token) return "denied";
    try {
      const result = await this.resolveVerifyFn()(token);
      return result?.alreadyConsumed === true ? "denied" : "ok";
    } catch (err) {
      const code = (err as { code?: unknown })?.code;
      if (typeof code === "string" && TOKEN_ERROR_CODES.has(code)) {
        return "denied";
      }
      return "unavailable"; // network / timeout / unrecognized ⇒ fail open
    }
  }

  private resolveVerifyFn(): VerifyAppCheckToken {
    if (!this.verifyFn) {
      const appCheck = getAppCheck(this.initApp());
      this.verifyFn = (token) => appCheck.verifyToken(token, { consume: true });
    }
    return this.verifyFn;
  }

  /** Reuses the already-initialized default app (the ID-token verifier normally creates it). */
  private initApp(): App {
    if (this.app) return this.app;
    const existing = getApps();
    if (existing.length > 0) {
      this.app = existing[0];
      return this.app;
    }
    const cfg = this.config as AppCheckConfig;
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
