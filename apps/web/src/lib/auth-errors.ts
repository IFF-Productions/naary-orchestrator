/**
 * Human messages for Firebase Auth failures.
 *
 * Until now the sign-in screen rendered `e.message` straight through, so a blocked popup read
 * `Firebase: Error (auth/popup-blocked).` — which tells the visitor nothing about what to do and
 * looks like a crash. Every auth path shares this surface, so wrong-password, already-registered
 * and weak-password all had the same problem.
 *
 * Unmapped codes keep the code visible in parentheses rather than hiding behind a generic
 * sentence: an unrecognized failure is exactly when someone needs the string to search for.
 */

/** Firebase errors carry `code`; plain Errors don't. */
function codeOf(err: unknown): string {
  const raw = (err as { code?: unknown })?.code;
  return typeof raw === "string" ? raw : "";
}

const MESSAGES: Record<string, string> = {
  // --- popup / redirect ---
  "auth/popup-blocked":
    "Your browser blocked the Google sign-in window. Allow pop-ups for this site, or try again — we’ll redirect you instead.",
  "auth/popup-closed-by-user":
    "The Google sign-in window closed before finishing. Try again.",
  "auth/cancelled-popup-request":
    "Another sign-in window was already open. Try again.",
  "auth/unauthorized-domain":
    "This site isn’t on the Firebase authorised-domains list, so Google sign-in can’t run here.",
  // --- credentials ---
  // Firebase deliberately collapses wrong-password and unknown-email into one code so an
  // attacker can't enumerate accounts. Mirror that: do NOT say which part was wrong.
  "auth/invalid-credential": "That email and password don’t match an account.",
  "auth/wrong-password": "That email and password don’t match an account.",
  "auth/user-not-found": "That email and password don’t match an account.",
  "auth/invalid-email": "That doesn’t look like a valid email address.",
  "auth/user-disabled": "This account has been disabled.",
  "auth/email-already-in-use":
    "There’s already an account with that email — sign in instead, or reset the password.",
  "auth/weak-password": "Pick a longer password (at least 6 characters).",
  "auth/too-many-requests":
    "Too many attempts. Wait a few minutes and try again.",
  // --- environment ---
  "auth/network-request-failed":
    "Couldn’t reach the sign-in service. Check your connection and try again.",
  "auth/operation-not-allowed":
    "That sign-in method isn’t enabled for this project.",
  // App Check enforcement with a bundle that can't mint tokens — the exact outage
  // docs/app-check.md warns about, worth naming rather than showing a bare code.
  "auth/firebase-app-check-token-is-invalid":
    "Sign-in was refused by App Check. If this just started, App Check enforcement is on but this build can’t produce a valid token.",
};

/** The message to show a visitor for a failed auth attempt. Never throws, never empty. */
export function authErrorMessage(err: unknown): string {
  const code = codeOf(err);
  const known = MESSAGES[code.toLowerCase()];
  if (known) return known;
  if (code) return `Sign-in failed (${code}).`;
  const msg = err instanceof Error ? err.message.trim() : "";
  // A non-Firebase Error: its message is ours and safe to show. Strip Firebase's own
  // "Firebase: " prefix if one slipped through with no code attached.
  return msg ? msg.replace(/^Firebase:\s*/, "") : "Authentication failed.";
}

/**
 * Append the App Check cause to a sign-in failure when this page already knows it cannot attest.
 *
 * WHY: with App Check enforcement ON and a token we can't mint, Google refuses sign-in one layer
 * BELOW the SDK — measured on prod 2026-07-28 (#792), `createAuthUri` came back
 * `401 "Firebase App Check token is invalid."` from inside the popup's own handler page. Our SDK
 * never sees that 401: the popup simply never hands a credential back, and the visitor is left
 * with whatever generic thing the popup poll eventually says (usually "the window closed"). The
 * true cause was already known at page load and went unsaid — which is exactly how this became a
 * multi-day outage that read as "I click sign in and nothing happens".
 *
 * Hedged wording on purpose ("may"): the client cannot see whether enforcement is on, so a failed
 * attestation is a strong suspicion, never a certainty. Naming a cause we can't confirm as fact
 * would send someone to the wrong console page.
 */
export function withAppCheckHint(message: string, failed: boolean): string {
  if (!failed) return message;
  return `${message} This app also couldn’t complete its bot check (App Check), which may be why sign-in was refused — see the browser console for details.`;
}

/**
 * Turn the `signInWithRedirect` return leg into a message to show, or null when it succeeded
 * (or never ran). NEVER rejects — this wraps a promise created at module load, and an unhandled
 * rejection there would be an unattributed console error on every visit to the sign-in screen.
 *
 * WHY THIS EXISTS: the SDK swallows a failed redirect completion. `initializeCurrentUser` calls
 * `tryRedirectSignIn`, whose catch is literally `// Swallow any errors here; the code can retrieve
 * them in getRedirectResult()` — it clears the redirect user and returns null. So a redirect that
 * fails (App Check refusal, a partitioned-storage iframe that can't hand the credential back)
 * signs nobody in and says nothing at all: the visitor is simply returned to the sign-in screen.
 * Asking for the outcome explicitly is the only way that error is ever seen.
 */
export function captureRedirectFailure(
  settled: Promise<unknown>,
): Promise<string | null> {
  return settled.then(
    () => null,
    (err) => authErrorMessage(err),
  );
}

/**
 * Wrap a ONE-SHOT outcome so exactly one reader receives it; every later read gets null.
 *
 * A redirect outcome describes a single page load, but the promise carrying it is created at
 * module load and lives as long as the SPA. Without this, a visitor who hit a failed redirect,
 * signed in another way, later signed out and came back to /auth would be shown that first
 * failure again — long after it stopped being true.
 */
export function oneShot(
  outcome: Promise<string | null>,
): () => Promise<string | null> {
  let taken = false;
  return () => {
    if (taken) return Promise.resolve(null);
    taken = true;
    return outcome;
  };
}

/**
 * Whether a popup failure is worth retrying as a full-page redirect.
 *
 * ONLY `popup-blocked` (and an environment that can't do popups at all). A popup the visitor
 * closed themselves, or one superseded by a second click, must NOT navigate the page out from
 * under them — that would turn a deliberate cancel into a surprise redirect.
 */
export function shouldRetryWithRedirect(err: unknown): boolean {
  const code = codeOf(err).toLowerCase();
  return (
    code === "auth/popup-blocked" ||
    code === "auth/operation-not-supported-in-this-environment"
  );
}
