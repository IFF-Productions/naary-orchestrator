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
  type AppCheck,
  ReCaptchaEnterpriseProvider,
  ReCaptchaV3Provider,
  getLimitedUseToken,
  getToken,
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
    const instance = initializeAppCheck(app, {
      provider:
        plan.kind === "recaptcha-v3"
          ? new ReCaptchaV3Provider(plan.siteKey)
          : new ReCaptchaEnterpriseProvider(plan.siteKey),
      // Keep the attestation fresh for long-lived sessions (the canvas is a
      // sit-on-one-tab-all-day surface) so tokens don't expire mid-session.
      isTokenAutoRefreshEnabled: true,
    });
    appCheck = instance;
    activePlan = plan;
    // Fire-and-forget: turn the FIRST token fetch into a diagnostic. Deliberately not
    // awaited — initAppCheck runs at module load and must not delay it.
    void probeAppCheckToken(instance, plan, isDev);
    return plan;
  } catch (err) {
    console.warn(
      "[app-check] initialization failed; continuing without it",
      err,
    );
    return { kind: "off" };
  }
}

/**
 * The live instance + plan, captured by `initAppCheck`. Module-level rather than passed
 * around because the public form/chat pages mint tokens from a completely different part of
 * the tree, and Firebase only permits ONE App Check per app anyway.
 */
let appCheck: AppCheck | undefined;
let activePlan: ActivePlan | undefined;
let attestationFailed = false;

/**
 * Whether this page has already PROVEN it cannot attest — the startup probe asked for a token
 * and was refused.
 *
 * Exists so a failed sign-in can name the likely reason instead of leaving the visitor with a
 * generic message. It is deliberately NOT surfaced before an attempt: when App Check enforcement
 * is OFF (the correct state while a key is being fixed) a broken attestation changes nothing and
 * sign-in works, so a warning on arrival would be a false alarm. After a failure it is the single
 * most likely cause, and worth saying.
 *
 * False while the probe is still in flight. That is fine here — the probe starts at module load
 * and a visitor cannot click sign-in inside that window — and it is the right way to be wrong:
 * silence rather than a guess. Also false when the startup probe SUCCEEDED and a later refresh
 * failed; same conservative direction.
 *
 * Unlike `mintBotGateToken`, this is safe to import directly rather than through ./firebase: it
 * reports a flag rather than using the App Check instance, so an importer that never triggered
 * `initAppCheck` reads "no failure observed" instead of silently getting null forever. The
 * sign-in screen is under AuthProvider → ./firebase anyway, so the probe has always run.
 */
export function appCheckAttestationFailed(): boolean {
  return attestationFailed;
}

/**
 * Mint a **limited-use** App Check token for one public form/chat submission — the tenant
 * bot-gate `app_check` provider (docs/design/TENANT-BOT-GATE-PROVIDERS.md §3).
 *
 * `getLimitedUseToken`, not `getToken`: the API verifies with `consume: true`, which can only
 * spend a token that was minted limited-use. A cached `getToken` token would be replayable no
 * matter what the server asks for. It also means every submission needs a FRESH call — these
 * are single-use by construction, so there is nothing to cache here.
 *
 * `null` means "this page cannot attest" — App Check off in this build, or a token fetch that
 * failed. Callers must treat that as "let the server decide" rather than blocking the visitor:
 * the server denies an absent token when it can enforce and fails open when it cannot, and it
 * is the only side that knows which. Never throws, for the same reason.
 */
export async function mintBotGateToken(): Promise<string | null> {
  if (!appCheck || !activePlan) {
    console.warn(
      "[app-check] a bot gate asked for an App Check token, but App Check is not initialized " +
        "in this build (no VITE_FIREBASE_APPCHECK_SITE_KEY). Submissions will carry no token.",
    );
    return null;
  }
  try {
    const { token } = await getLimitedUseToken(appCheck);
    return token || null;
  } catch (err) {
    console.error(explainAppCheckFailure(activePlan, err));
    return null;
  }
}

/** An active plan — the shape `explainAppCheckFailure` reports on. */
type ActivePlan = Exclude<AppCheckPlan, { kind: "off" }>;

/**
 * Ask for a token once so a broken configuration announces ITSELF.
 *
 * This works because the PUBLIC `getToken` export rethrows
 * (`if (result.error) throw result.error`, @firebase/app-check dist). Worth stating,
 * because the SDK's INTERNAL token path deliberately does the opposite — it resolves with
 * a dummy token that encodes the error, which is exactly how firebase/auth manages to log
 * a failure and still carry on. Swap this to the internal accessor and the catch below
 * goes dead while every test still passes.
 *
 * Nothing here changes behaviour: with `isTokenAutoRefreshEnabled` the SDK already fetches
 * at init, and getToken's own contract is that a fresh-token request "attaches to the most
 * recent in-flight request if one is present" — so the happy path costs one extra promise
 * and no second reCAPTCHA assessment (which past the free tier is billable). The point is
 * the failure path — Firebase logs `appCheck/recaptcha-error` from inside firebase/auth with no
 * mention of WHICH provider we picked or what to change, and the SPA keeps working
 * (until enforcement is switched on, at which point every sign-in fails). Without this,
 * the first real symptom is a total auth outage with an error that reads like a network
 * or CSP problem. Ours names the cause and the fix.
 */
async function probeAppCheckToken(
  appCheck: Parameters<typeof getToken>[0],
  plan: ActivePlan,
  isDev: boolean,
): Promise<void> {
  try {
    await getToken(appCheck);
  } catch (err) {
    attestationFailed = true;
    console.error(explainAppCheckFailure(plan, err, isDev));
  }
}

/**
 * The error's `code`, as-written for display and lowercased for matching. Firebase prints
 * `appCheck/recaptcha-error` with that exact casing, so echoing a lowercased copy would stop
 * anyone correlating our line with theirs by searching the console for the same string.
 */
function errorCode(err: unknown): { shown: string; match: string } {
  const raw = (err as { code?: unknown })?.code;
  const shown = typeof raw === "string" ? raw : "";
  return { shown, match: shown.toLowerCase() };
}

/**
 * The actionable message for a failed token fetch. Pure and exported so the wording —
 * which is the entire value of this code — is covered by tests rather than only ever
 * seen in a browser console during an outage.
 *
 * Site keys are PUBLIC by design (this one is inlined in the bundle any visitor can
 * read), so echoing it is not a leak and makes "which key is actually deployed?"
 * answerable from a screenshot.
 */
export function explainAppCheckFailure(
  plan: ActivePlan,
  err: unknown,
  isDev = false,
): string {
  const { shown, match: code } = errorCode(err);
  const other = plan.kind === "recaptcha-v3" ? "enterprise" : "v3";
  const lines = [
    `[app-check] could not get an attestation token (${shown || "unknown error"}).`,
    `  active provider: ${plan.kind}   site key: ${plan.siteKey}`,
    `  host: ${typeof location === "undefined" ? "?" : location.host}`,
  ];

  if (code.endsWith("/recaptcha-error")) {
    // Ordered by what the ONE real occurrence of this taught us (#792): the key did not
    // resolve at Google at all, so every downstream theory (provider type, domain
    // allowlist, CSP) was wrong. That check is also the cheapest — two curls, no browser,
    // no rebuild — so it goes first.
    lines.push(
      "  reCAPTCHA refused to serve for this key. Check, in this order:",
      "  0. WHICH `clr` 400s — this is the fastest and most decisive signal, from the",
      "     Network tab on THIS page. classic-v3 posts to /recaptcha/api2/clr, Enterprise to",
      "     /recaptcha/enterprise/clr.",
      "       ONE 400s, the other works  ⇒ WRONG PROVIDER, go to 2.",
      "       BOTH 400 (try each by flipping VITE_FIREBASE_APPCHECK_PROVIDER) ⇒ the provider is",
      "       NOT the variable. Skip to 3 and 4: the key id exists but Google is refusing to mint",
      "       a token for THIS HOST or THIS PROJECT.",
      "  1. DOES THE KEY RESOLVE AT ALL? Run both:",
      `       curl -s -o /dev/null -w '%{http_code}\\n' "https://www.google.com/recaptcha/api.js?render=${plan.siteKey}"`,
      `       curl -s -o /dev/null -w '%{http_code}\\n' "https://www.google.com/recaptcha/enterprise.js?render=${plan.siteKey}"`,
      "     MEASURED, both directions (2026-07-28, two real keys in the same project):",
      "       400/400 DOES mean checkbox — a challenge key returns 400 from both `render=`",
      '         endpoints, and is the one used as a <div class="g-recaptcha"> for reCAPTCHA',
      "         fraud-defence/WAF. App Check can never use it. This test is sound for TYPE.",
      "       200/200 means score-based AND NOTHING ELSE. `render=` does not check the domain —",
      "         it returns 200 even with a bogus Referer — and does not tell you the provider.",
      '         Reading 200/200 as "so it must be the provider" is the trap; it cost a wrong',
      "         fix on 2026-07-28 when both `clr` endpoints then failed identically.",
      "     ALSO: two keys in one project share their first ~13 chars. Compare the WHOLE string",
      "     before concluding the console and the bundle hold the same key — they did not.",
      "     400 on BOTH ⇒ `render=` does not accept this key, and no provider setting fixes",
      "     that. Most likely it is a CHALLENGE-BASED (checkbox) reCAPTCHA key: those are used",
      "     as a `g-recaptcha` div, never via `render=`, and App Check requires a SCORE-BASED",
      "     key. Key type is immutable — create a new score-based one. Otherwise: a",
      "     typo/truncated paste, a deleted key, or the wrong project. (A 400 is also exactly",
      "     what makes a <script> tag fire onerror, so that is this same symptom.)",
      `  2. WRONG PROVIDER. A 200 above proves the key LOADS; it does not tell you which provider`,
      `     to use — a score-based key is commonly served by BOTH endpoints (measured). What`,
      `     decides is what Firebase console → App Check → Apps registered for this web app:`,
      `     reCAPTCHA Enterprise ⇒ "enterprise", reCAPTCHA v3 ⇒ "v3". We are currently sending`,
      `     "${plan.kind === "recaptcha-v3" ? "v3" : "enterprise"}"; if the console says the other one, set`,
      `     VITE_FIREBASE_APPCHECK_PROVIDER=${other} and rebuild the web image — VITE_* is inlined at`,
      `     BUILD time, so changing it on the server has no effect.`,
      '     Only conclude "wrong provider" when the OTHER `clr` endpoint actually works — see 0.',
      "  3. DOMAIN NOT REGISTERED — the likeliest cause when BOTH `clr` endpoints 400 while",
      "     `render=` returns 200, because `render=` never checks the domain and `clr` does.",
      `     Add ${typeof location === "undefined" ? "this host" : location.host} to the key's allowed domains`,
      "     (reCAPTCHA admin for v3, Google Cloud → Security → reCAPTCHA for Enterprise).",
      "  4. WRONG PROJECT. The key must belong to the same project as VITE_FIREBASE_PROJECT_ID.",
    );
  } else if (code.endsWith("/fetch-status-error")) {
    lines.push(
      "  reCAPTCHA succeeded but Google refused to exchange the result for an App Check",
      "  token — usually this app is not registered with this provider in the Firebase",
      "  console (App Check → Apps), or the key belongs to a different project.",
    );
  } else if (code.endsWith("/initial-throttle")) {
    // MEASURED on prod, 2026-07-28 (#792). reCAPTCHA itself was healthy — /recaptcha/api2/clr
    // and /reload both 200 for this key on this host — and the failure was one step LATER:
    //   POST content-firebaseappcheck.googleapis.com/v1/projects/<p>/apps/<a>:exchangeRecaptchaV3Token
    //   → 403 {"message":"App attestation failed.","status":"PERMISSION_DENIED"}
    // So none of the reCAPTCHA-side checks in the recaptcha-error branch above apply here:
    // the key resolves, the host is allowed, the provider matches the key type. What is wrong
    // is the REGISTRATION on the App Check side.
    lines.push(
      "  reCAPTCHA worked; Google then REFUSED to exchange its token for an App Check token",
      '  (403 "App attestation failed." on :exchangeRecaptcha…Token). Do NOT re-run the',
      "  reCAPTCHA-side checks — a 403 here means the key resolved and the host was accepted.",
      "  Causes, in likelihood order:",
      "  1. The key registered in Firebase console → App Check → Apps for THIS web app is not",
      `     this one. Compare the WHOLE string against ${plan.siteKey} — two keys in one project`,
      "     share their first ~13 chars, so a glance at the prefix proves nothing.",
      `  2. That app is registered under the OTHER provider. We are sending ${plan.kind}; if the`,
      `     console registered ${other}, set VITE_FIREBASE_APPCHECK_PROVIDER=${other} and REBUILD the`,
      "     web image (VITE_* is inlined at build time; a server .env edit does nothing).",
      "  3. The app is not registered with App Check at all.",
      "  4. A reCAPTCHA score below the threshold — expected for automation/headless, and the",
      "     one cause that is not a misconfiguration. Rule it out by reproducing in a normal",
      "     browser before changing any registration.",
      "  THE BACKOFF IS ONE DAY, NOT SECONDS. The SDK throttles hard on a 403 and every later",
      "  attempt fails locally as appCheck/throttled without another network call — so the",
      "  console goes QUIET and a reload does not retry. Silence here is NOT evidence of a fix;",
      "  verify with the Network tab (the exchange request must return 200) or a fresh profile.",
    );
  } else if (code.endsWith("/throttled")) {
    lines.push(
      "  Throttled after repeated failures — fix the underlying error above and reload;",
      "  the backoff clears on its own. NB a 403 sets a ONE-DAY backoff, so this can persist",
      "  long after the real cause is fixed; check in a fresh browser profile.",
    );
  }

  if (isDev) {
    lines.push(
      "  DEV build: a debug token was requested. Copy the token the SDK printed above into",
      "  Firebase console → App Check → Apps → Manage debug tokens.",
    );
  }
  lines.push(
    "  Sign-in still works while App Check enforcement is OFF. If enforcement is ON, turn",
    "  it off (Firebase console → App Check → APIs → Firebase Authentication) until this is",
    "  fixed — otherwise every sign-in is refused. See docs/app-check.md.",
  );
  return lines.join("\n");
}
