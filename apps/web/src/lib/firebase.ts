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
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
} from "firebase/auth";
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
export const auth: Auth | undefined = firebaseApp
  ? getAuth(firebaseApp)
  : undefined;

const googleProvider = new GoogleAuthProvider();

const notConfigured = (): Promise<never> =>
  Promise.reject(new Error("Firebase login isn’t configured for this build."));

export function loginWithGoogle(): Promise<unknown> {
  return auth ? signInWithPopup(auth, googleProvider) : notConfigured();
}

export function loginWithEmail(
  email: string,
  password: string,
): Promise<unknown> {
  return auth
    ? signInWithEmailAndPassword(auth, email, password)
    : notConfigured();
}

export function signupWithEmail(
  email: string,
  password: string,
): Promise<unknown> {
  return auth
    ? createUserWithEmailAndPassword(auth, email, password)
    : notConfigured();
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
