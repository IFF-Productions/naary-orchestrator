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
