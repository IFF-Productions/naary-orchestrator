/**
 * Firebase Auth for the SPA. Replaces the previous Keycloak login. The web config
 * is public (Firebase API keys are not secrets — access is enforced by Firebase
 * security rules + the backend verifying the ID token), but we still keep it OUT
 * of source: all values come from VITE_FIREBASE_* env, injected at build time
 * (see docker-compose web build-args / .env.example).
 *
 * The bearer token sent to the API is the user's Firebase ID token (a Google-signed
 * JWT carrying the `tenant` custom claim the API authorizes on); when not signed
 * in, we fall back to a pasted `nry_` API token (the secondary path).
 */
import { type FirebaseApp, initializeApp } from "firebase/app";
import {
  type Auth,
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  getAuth,
  getRedirectResult,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  updateProfile,
} from "firebase/auth";
import { captureRedirectFailure, shouldRetryWithRedirect } from "./auth-errors";
import { initAppCheck, mintBotGateToken } from "./app-check";
import { getToken } from "./auth";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

/** True when the build was given a Firebase project (else login is unavailable;
 *  the `nry_` token paste still works). */
export const firebaseConfigured = Boolean(firebaseConfig.apiKey);

// Init ONLY when configured: getAuth() with an empty apiKey throws
// `auth/invalid-api-key` synchronously at load, which would white-screen the whole
// SPA — including the `nry_` paste path. Unconfigured ⇒ auth is undefined and the
// app still renders (login disabled, token paste works).
export const firebaseApp: FirebaseApp | undefined = firebaseConfigured
  ? initializeApp(firebaseConfig)
  : undefined;

// App Check BEFORE getAuth(): attestation tokens must be available to the first auth
// request, and auth-state restoration can fire a token refresh as soon as `auth`
// exists. No-op unless VITE_FIREBASE_APPCHECK_SITE_KEY was set at build time; never
// throws (see ./app-check).
export const appCheckPlan = firebaseApp
  ? initAppCheck(firebaseApp)
  : ({ kind: "off" } as const);

export const auth: Auth | undefined = firebaseApp
  ? getAuth(firebaseApp)
  : undefined;

/**
 * Re-exported so the public form/chat pages have ONE import that both initializes App Check
 * (that happens as a side effect of loading this module) and mints a submission token. Importing
 * ./app-check directly would compile fine and always return null, because nothing would have
 * called initAppCheck.
 */
export { mintBotGateToken };

/**
 * The outcome of a `signInWithRedirect` return leg: a message when it FAILED, null otherwise.
 *
 * Started here at module load, deliberately, because the SDK's own completion happens during auth
 * init and throws its error away (see captureRedirectFailure). `getRedirectResult` awaits
 * `_initializationPromise` first, so this always reads the outcome init already computed — it
 * never races it or consumes the pending-redirect flag out from under it.
 *
 * THAT DEPENDS ON `getAuth()` ABOVE, which registers `browserPopupRedirectResolver`. Swap it for
 * an `initializeAuth()` without a popupRedirectResolver and init skips `tryRedirectSignIn`
 * entirely — this line then becomes the FIRST caller, consuming the pending-redirect flag and
 * discarding a real credential. Keep the resolver, or delete this.
 *
 * A promise rather than a callback because the return leg is a fresh page load: whoever renders
 * the sign-in screen must be able to ask "did we just come back from a failed redirect?" whenever
 * they mount, not be told once at a moment nothing is listening.
 */
export const redirectSignInError: Promise<string | null> = auth
  ? captureRedirectFailure(getRedirectResult(auth))
  : Promise.resolve(null);

const googleProvider = new GoogleAuthProvider();

const notConfigured = (): Promise<never> =>
  Promise.reject(new Error("Firebase login isn’t configured for this build."));

/**
 * Google sign-in, popup first with a full-page redirect as the fallback.
 *
 * A blocked popup is NOT simply the visitor's browser config. Our handler is clean — AuthScreen
 * calls this synchronously inside the button's onClick — but the SDK puts two network round trips
 * between the click and `window.open`:
 *   1. `AbstractPopupRedirectOperation.execute()` awaits `resolver._initialize(auth)`, loading the
 *      `<authDomain>/__/auth/iframe` helper. Memoized per auth, so it costs once per page load.
 *   2. `_openPopup()` awaits `_getRedirectUrl()`, which awaits `auth._getAppCheckToken()` to hang
 *      the token off the handler URL as `#fac=…`.
 * Only after both does `_open()` reach `window.open`. (2) is what hurts us today: with App Check
 * mis-provisioned (#792) that is a reCAPTCHA round trip that FAILS on every attempt —
 * `_getAppCheckToken` logs "Error while retrieving App Check token" and returns undefined instead
 * of throwing, so the flow limps on having already spent the browser's gesture window. Hence the
 * intermittency, and hence fixing App Check should take most of this away on its own.
 *
 * The redirect fallback fires only for `popup-blocked` (see shouldRetryWithRedirect) — a popup the
 * visitor CLOSED must not navigate the page out from under them. The returned promise never
 * settles on that path: the page unloads. Coming back is a FRESH PAGE LOAD, so nothing resolves
 * and no `onAuthed` callback runs — AuthPage has to notice `authenticated` and navigate itself,
 * and `redirectSignInError` above carries the failure the SDK would otherwise swallow.
 */
export function loginWithGoogle(): Promise<unknown> {
  if (!auth) return notConfigured();
  const a = auth;
  return signInWithPopup(a, googleProvider).catch((err) => {
    if (!shouldRetryWithRedirect(err)) throw err;
    return signInWithRedirect(a, googleProvider);
  });
}

export function loginWithEmail(
  email: string,
  password: string,
): Promise<unknown> {
  return auth
    ? signInWithEmailAndPassword(auth, email, password)
    : notConfigured();
}

export async function signupWithEmail(
  email: string,
  password: string,
  displayName?: string,
): Promise<unknown> {
  if (!auth) return notConfigured();
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  // Persist the name the user typed as their Firebase displayName — BEST-EFFORT: the account
  // already exists, so a failed profile update must NOT fail signup (which would report a
  // false failure and invite duplicate-signup attempts). The name can be set later in Settings.
  const name = displayName?.trim();
  if (name) {
    try {
      await updateProfile(cred.user, { displayName: name });
    } catch {
      /* non-fatal — the user is signed up; only the display name didn't stick */
    }
  }
  return cred;
}

export function sendPasswordReset(email: string): Promise<unknown> {
  return auth ? sendPasswordResetEmail(auth, email) : notConfigured();
}

export function logout(): Promise<void> {
  return auth ? signOut(auth) : Promise.resolve();
}

/**
 * The bearer token for an API call: a FRESH Firebase ID token when signed in (the
 * SDK returns a cached valid token or refreshes automatically), otherwise the
 * pasted `nry_` API token. Returns null when neither is available.
 */
export async function getBearerToken(): Promise<string | null> {
  const user = auth?.currentUser;
  if (user) {
    try {
      return await user.getIdToken();
    } catch {
      /* refresh failed; fall through to the paste fallback */
    }
  }
  return getToken();
}
