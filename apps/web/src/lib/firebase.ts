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
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  updateProfile,
} from "firebase/auth";
import { shouldRetryWithRedirect } from "./auth-errors";
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

const googleProvider = new GoogleAuthProvider();

const notConfigured = (): Promise<never> =>
  Promise.reject(new Error("Firebase login isn’t configured for this build."));

/**
 * Google sign-in, popup first with a full-page redirect as the fallback.
 *
 * A popup blocker is the visitor's browser config, not an error we can fix or ask them to fix
 * mid-flow, and until now it dead-ended sign-in with a raw `auth/popup-blocked`. The redirect
 * flow needs no popup at all, so it recovers instead of failing.
 *
 * Only for `popup-blocked` (see shouldRetryWithRedirect) — a popup the visitor CLOSED must not
 * navigate the page out from under them. Note the returned promise never settles on the redirect
 * path: the page unloads. Nothing downstream needs it to, because AuthProvider's
 * `onAuthStateChanged` is what observes the completed sign-in when we come back.
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
