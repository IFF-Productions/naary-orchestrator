/**
 * Firebase App Check for the SPA — attests that a request comes from THIS app before
 * Firebase Auth will serve it.
 *
 * Why this exists (issue #782): Firebase account creation is client-side, so our API
 * never sees a signup and there is no server-side hook to verify a CAPTCHA token
 * against. A widget on the sign-up form would raise the bar for someone using a
 * browser and not at all for anyone POSTing to Firebase's REST endpoint with the
 * (public by design) web API key. App Check is the layer that closes that gap,
 * because it is enforced by Google in front of Firebase Auth itself.
 *
 * Two halves, and they must land in this order:
 *   1. this code, deployed with a site key  →  the SPA sends attestation tokens
 *   2. enforcement flipped on in the Firebase console  →  Google starts REQUIRING them
 * Flipping (2) before (1) is live breaks every sign-in. See docs/app-check.md.
 *
 * UNSET site key ⇒ App Check is not initialized at all (see `planAppCheck`), which is
 * the correct state for local dev, self-hosted installs, and any Firebase project
 * running App Check in monitoring-only mode.
 */
import type { FirebaseApp } from "firebase/app";
import {
  ReCaptchaEnterpriseProvider,
  ReCaptchaV3Provider,
  initializeAppCheck,
} from "firebase/app-check";

/** What we should do at startup, decided from env alone so it is unit-testable. */
export type AppCheckPlan =
  | { kind: "off" }
  | { kind: "recaptcha-enterprise" | "recaptcha-v3"; siteKey: string };

type AppCheckEnv = {
  VITE_FIREBASE_APPCHECK_SITE_KEY?: string;
  VITE_FIREBASE_APPCHECK_PROVIDER?: string;
};

/**
 * reCAPTCHA Enterprise and reCAPTCHA v3 site keys are DIFFERENT and not
 * interchangeable, and a mismatch fails at token fetch rather than at init — so it
 * surfaces as a mystery network/CSP error, not as a config error. Which one the
 * Firebase console registered is not knowable from here, so the provider is env-
 * selectable: a console mismatch becomes an env fix instead of a code change plus a
 * full image rebuild.
 */
const V3_ALIASES = ["v3", "recaptcha-v3", "recaptchav3", "recaptcha_v3"];
const ENTERPRISE_ALIASES = [
  "enterprise",
  "recaptcha-enterprise",
  "recaptchaenterprise",
  "recaptcha_enterprise",
];

export function planAppCheck(env: AppCheckEnv): AppCheckPlan {
  const siteKey = env.VITE_FIREBASE_APPCHECK_SITE_KEY?.trim();
  // No key ⇒ off. Never a partially-configured attempt: initializeAppCheck with an
  // empty key throws, and this module loads on the SPA's critical path.
  if (!siteKey) return { kind: "off" };

  const raw = env.VITE_FIREBASE_APPCHECK_PROVIDER?.trim().toLowerCase();
  if (raw && V3_ALIASES.includes(raw)) return { kind: "recaptcha-v3", siteKey };
  if (!raw || ENTERPRISE_ALIASES.includes(raw)) {
    // Enterprise is the default: it is what the Firebase console registers for new
    // web apps today.
    return { kind: "recaptcha-enterprise", siteKey };
  }
  // Unrecognized value: default rather than silently disabling. Turning App Check OFF
  // on a typo would be the worse failure under enforcement (every sign-in blocked),
  // and a wrong-provider token fetch at least logs loudly in the console.
  console.warn(
    `[app-check] unknown VITE_FIREBASE_APPCHECK_PROVIDER "${raw}" — expected "enterprise" or "v3"; using enterprise`,
  );
  return { kind: "recaptcha-enterprise", siteKey };
}

/**
 * Initialize App Check. MUST be called after `initializeApp` and before the first
 * auth request, so the caller invokes it between those two lines in firebase.ts —
 * `getAuth()` runs at module load there, and auth-state restoration can fire a token
 * refresh straight away.
 *
 * Never throws: App Check is a hardening layer, and a failure here must not
 * white-screen the SPA (which would also take out the `nry_` token-paste path).
 */
export function initAppCheck(
  app: FirebaseApp,
  env: AppCheckEnv = import.meta.env,
  isDev = import.meta.env.DEV,
): AppCheckPlan {
  const plan = planAppCheck(env);
  if (plan.kind === "off") return plan;

  try {
    // Debug tokens mint VALID attestations for whoever holds one, so this is gated on
    // the DEV build flag ONLY — never on an env var, which could be set in a prod
    // build. `true` asks the SDK to print a fresh token to the console for you to
    // register (Firebase console → App Check → Apps → Manage debug tokens); no token
    // string is ever baked into the bundle.
    if (isDev) {
      (
        self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN?: boolean }
      ).FIREBASE_APPCHECK_DEBUG_TOKEN = true;
    }
    initializeAppCheck(app, {
      provider:
        plan.kind === "recaptcha-v3"
          ? new ReCaptchaV3Provider(plan.siteKey)
          : new ReCaptchaEnterpriseProvider(plan.siteKey),
      // Keep the attestation fresh for long-lived sessions (the canvas is a
      // sit-on-one-tab-all-day surface) so tokens don't expire mid-session.
      isTokenAutoRefreshEnabled: true,
    });
    return plan;
  } catch (err) {
    console.warn(
      "[app-check] initialization failed; continuing without it",
      err,
    );
    return { kind: "off" };
  }
}
