/**
 * Firebase Auth for the SPA. Replaces the previous Keycloak login.
 *
 * THIS MODULE IS BEHIND AN ASYNC BOUNDARY. Nothing on the critical path may import it
 * statically — it is reached only through the memoized `import("./firebase")` in ./firebase-lazy,
 * so a visitor to a public form/chat/approve page never downloads the auth SDK (#934's follow-up:
 * 138 KB raw / 41.5 KB gzip of eager bytes). If you need one fact from here in an eagerly-reachable
 * file, take it from ./firebase-env (config only) or ./firebase-lazy (the async accessors); adding
 * `import { … } from "./firebase"` anywhere the app shell can reach puts the whole SDK back on the
 * critical path with no error and no failing build. `apps/web/test/eager-bundle.spec.ts` is what
 * catches that.
 *
 * The bearer token sent to the API is the user's Firebase ID token (a Google-signed JWT carrying
 * the `tenant` custom claim the API authorizes on); when not signed in, we fall back to a pasted
 * `nry_` API token (the secondary path).
 */
import {
  type Auth,
  GoogleAuthProvider,
  type User,
  createUserWithEmailAndPassword,
  getAuth,
  getRedirectResult,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  updateProfile,
} from "firebase/auth";
import {
  captureRedirectFailure,
  oneShot,
  shouldRetryWithRedirect,
} from "./auth-errors";
import { getToken } from "./auth";
// initializeApp + App Check. Imported for its VALUE and for its ORDERING: this import is
// evaluated in full before `getAuth()` below, which is the "App Check before the first auth
// request" invariant. See ./firebase-app.
import { firebaseApp } from "./firebase-app";

export { firebaseConfigured } from "./firebase-env";

export const auth: Auth | undefined = firebaseApp
  ? getAuth(firebaseApp)
  : undefined;

/**
 * The outcome of a `signInWithRedirect` return leg: a message when it FAILED, null otherwise.
 *
 * Started at THIS module's load, deliberately, because the SDK's own completion happens during
 * auth init and throws its error away (see captureRedirectFailure). `getRedirectResult` awaits
 * `_initializationPromise` first, so this always reads the outcome init already computed — it
 * never races it or consumes the pending-redirect flag out from under it. That reasoning is
 * unchanged by the async boundary: `getAuth()` is three lines up, in the same module evaluation.
 * What changed is only WHEN the module evaluates — on the redirect's return leg the visitor lands
 * back on /auth, whose route loader activates the boundary (see router.tsx), so this still runs
 * while nothing else has touched the pending-redirect flag.
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
const redirectSignIn: Promise<string | null> = auth
  ? captureRedirectFailure(getRedirectResult(auth))
  : Promise.resolve(null);

/**
 * The failed-redirect message, ONCE — later calls resolve null. Consumed rather than exposed
 * because the promise lives as long as the SPA while the outcome describes a single page load
 * (see oneShot).
 */
export const takeRedirectSignInError = oneShot(redirectSignIn);

const googleProvider = new GoogleAuthProvider();

const notConfigured = (): Promise<never> =>
  Promise.reject(new Error("Firebase login isn’t configured for this build."));

/**
 * Subscribe to auth-state changes. Wrapped here rather than exposing `auth` + `onAuthStateChanged`
 * to the caller so AuthProvider — which is EAGER — needs no `firebase/auth` value import of its
 * own. (It keeps `import type { User }`, which erases.)
 *
 * Unconfigured build ⇒ there is no session to restore, so `next(null)` fires on a microtask and
 * the caller's ready-gate resolves exactly as it does for a real "signed out" emission. Async so
 * the callback never runs synchronously inside the subscriber's render/effect.
 */
export function subscribeToAuth(
  next: (user: User | null) => void,
  onError: () => void,
): () => void {
  if (!auth) {
    let live = true;
    queueMicrotask(() => {
      if (live) next(null);
    });
    return () => {
      live = false;
    };
  }
  return onAuthStateChanged(auth, next, onError);
}

/**
 * Google sign-in, popup first with a full-page redirect as the fallback.
 *
 * SYNCHRONOUS TO `signInWithPopup`, AND IT MUST STAY THAT WAY. AuthScreen calls this inside the
 * button's onClick; every `await` before `window.open` spends the browser's user-gesture window,
 * and this app has already been bitten by exactly that (#800: an App Check await ahead of
 * `window.open` broke Google sign-in). The async boundary in ./firebase-lazy is therefore crossed
 * by a NON-async function that calls straight through when the module is already loaded — see
 * `loginWithGoogle` there and the synchrony test in test/firebase-lazy.spec.ts.
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
 * and `takeRedirectSignInError` above carries the failure the SDK would otherwise swallow.
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
 *
 * Call it through ./firebase-lazy's `getBearerToken`, not directly — that one answers from the
 * `nry_` store without pulling this module in when nobody has activated the auth boundary.
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
