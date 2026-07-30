/**
 * THE ASYNC AUTH BOUNDARY.
 *
 * `firebase` is 138 KB raw / 41.5 KB gzip. Before this module it sat in the chunk `index.html`
 * modulepreloads, because two eagerly-reachable things imported ./firebase statically:
 * `auth/AuthProvider` (mounted above the router, so on every page) and `lib/api/*`
 * (`getBearerToken`). Every anonymous visitor of a public form, chat or approve page therefore
 * downloaded the entire auth SDK to render a page they will never sign in on.
 *
 * This module is the seam. It contains NO `firebase/*` import — only a memoized dynamic
 * `import("./firebase")` — so nothing that imports it is coloured by the SDK. #934's lesson
 * applies directly: chunk assignment follows dependency EDGES, not the tree-shaken result, so the
 * only thing that keeps the SDK off the critical path is that no eager module has a static edge
 * to ./firebase.
 *
 * TWO RULES, both load-bearing, both covered by tests:
 *
 * 1. NOTHING FORCES THE LOAD BY ACCIDENT. `getBearerToken` below answers from the `nry_` store
 *    when the boundary was never activated, rather than pulling the SDK in to discover there is
 *    no user. A public page makes API calls (the anonymous form/chat endpoints); if those
 *    triggered the import, the whole boundary would be decorative.
 *
 * 2. `loginWithGoogle` IS NOT `async`. It reads the already-loaded module synchronously and calls
 *    straight through, so `signInWithPopup` is reached inside the click's own call stack with no
 *    microtask in between. An `await` here — even of an already-resolved promise — is the #800
 *    bug rebuilt: a pre-`window.open` await ate the user-gesture window and broke Google sign-in.
 *    test/firebase-lazy.spec.ts asserts the synchrony without awaiting anything.
 *
 * WHO ACTIVATES. Route loaders (see router.tsx) call `warmFirebaseAuth()` when a route under
 * RequireAuth or /auth matches — React Router runs loaders in PARALLEL with the route's lazy
 * chunk, so the SDK fetch is not serialized behind it. RequireAuth and AuthPage also activate
 * from an effect, so the boundary works under Storybook/tests and any future non-router mount.
 * Nothing on a public page activates, which is the point.
 *
 * CONSEQUENCE, stated because it is a real behaviour change: on a public page `AuthState.ready`
 * stays false forever and `authenticated` stays false even for a visitor who IS signed in
 * elsewhere in the app. No public page reads either (only RequireAuth, AuthPage, ModeSync and
 * screens under the shell do), and ModeSync's server-preference fetch simply doesn't run there.
 */
import { getToken } from "./auth";
import { firebaseConfigured } from "./firebase-env";

type FirebaseAuthModule = typeof import("./firebase");

/** The loaded module, readable SYNCHRONOUSLY — this is what keeps rule 2 above possible. */
let loaded: FirebaseAuthModule | undefined;
/** The in-flight (or settled) load. `undefined` means nobody has activated the boundary. */
let pending: Promise<FirebaseAuthModule> | undefined;

type Waiter = {
  onLoad: (m: FirebaseAuthModule) => void;
  onError: (err: unknown) => void;
};
const waiters = new Set<Waiter>();
let failure: unknown;

/**
 * Load the auth SDK, once. Idempotent and safe to call from anywhere; while a load is in flight or
 * has succeeded, later calls return the same promise. Rejects only if the CHUNK fails to load
 * (offline, a CDN blip, or a stale client after a deploy — `main.tsx`'s `vite:preloadError` handler
 * reloads for fresh assets in that case).
 *
 * A FAILURE MUST NOT LATCH. Before this boundary existed the SDK was in the eager bundle and was
 * therefore simply present; now its availability depends on a network fetch that can fail, so the
 * retry path is part of the feature. Memoizing the rejected promise would mean one transient
 * failure makes sign-in impossible for the rest of the page's life — the user clicks Sign in, gets
 * the same stale error, and nothing short of a reload helps. So the rejection handler clears
 * `pending`, and the NEXT call re-imports.
 *
 * The ordering is safe in both directions. `pending` is assigned synchronously, before any
 * settlement callback can run on the microtask queue, so this cannot null out an attempt that
 * hasn't been recorded yet; and the `pending === attempt` guard plus clearing it BEFORE notifying
 * waiters means a waiter that retries from inside its own error callback wins rather than being
 * clobbered.
 */
export function activateFirebaseAuth(): Promise<FirebaseAuthModule> {
  if (!pending) {
    // A retry is a genuinely fresh attempt: drop the previous error so a subscriber that mounts
    // while this one is in flight is not replayed a stale failure by `whenFirebaseAuthLoaded`.
    failure = undefined;
    const attempt: Promise<FirebaseAuthModule> = import("./firebase").then(
      (m) => {
        loaded = m;
        for (const w of [...waiters]) w.onLoad(m);
        return m;
      },
      (err) => {
        // UNLATCH FIRST — see the header. Everything below can re-enter this function.
        if (pending === attempt) pending = undefined;
        failure = err;
        for (const w of [...waiters]) w.onError(err);
        throw err;
      },
    );
    pending = attempt;
    // The rejection is delivered to waiters above; keep it from ALSO surfacing as an unhandled
    // rejection for every caller that used the fire-and-forget `warmFirebaseAuth` below. This
    // suppresses the noise only — the unlatch happens in the handler above, which runs first, so
    // recovery is unaffected.
    attempt.catch(() => undefined);
  }
  return pending;
}

/**
 * Fire-and-forget activation for route loaders. Skips unconfigured builds entirely — no Firebase
 * project means there is nothing to restore and nothing to sign into, so a self-hosted install
 * never fetches the chunk at all.
 */
export function warmFirebaseAuth(): void {
  if (firebaseConfigured) void activateFirebaseAuth();
}

/**
 * Run `onLoad` when the boundary has been activated AND the module has arrived — immediately-ish
 * if that already happened, later if it is in flight, and NEVER if nobody activates (a public
 * page). Returns an unsubscribe.
 *
 * Notification is always asynchronous, even when the module is already loaded, so a React
 * subscriber can never be called back inside its own effect body.
 */
export function whenFirebaseAuthLoaded(
  onLoad: (m: FirebaseAuthModule) => void,
  onError: (err: unknown) => void = () => undefined,
): () => void {
  let live = true;
  const waiter: Waiter = {
    onLoad: (m) => {
      if (live) onLoad(m);
    },
    onError: (err) => {
      if (live) onError(err);
    },
  };
  waiters.add(waiter);
  // Replay a load/failure that already happened — `waiters` only sees future events.
  if (loaded || failure !== undefined) {
    const m = loaded;
    const err = failure;
    queueMicrotask(() => {
      if (m) waiter.onLoad(m);
      else waiter.onError(err);
    });
  }
  return () => {
    live = false;
    waiters.delete(waiter);
  };
}

/**
 * The bearer token for an API call.
 *
 * NEVER activates the boundary (rule 1 in the header): with no activation there is no Firebase
 * session by construction, so the answer is the pasted `nry_` token or nothing. When the boundary
 * IS active this waits for it, which closes the race a bare "is it loaded yet?" check would open
 * — an authenticated screen's first fetch must not go out unauthenticated just because the chunk
 * is still in flight. (In practice RequireAuth gates every such screen behind `ready`, which only
 * flips after the module loads; this wait is the belt-and-braces to that.)
 */
export async function getBearerToken(): Promise<string | null> {
  if (loaded) return loaded.getBearerToken();
  if (pending) {
    const m = await pending.catch(() => undefined);
    if (m) return m.getBearerToken();
  }
  return getToken();
}

/**
 * Google sign-in. NOT `async` — see rule 2 in the header. When the module is loaded (the case
 * that matters: /auth's route loader started the fetch before AuthScreen could paint, let alone
 * be clicked) this reaches `signInWithPopup` with zero microtask ticks between it and the click
 * handler.
 *
 * THE COLD PATH IS A DEFINED DEGRADATION, not a break. If someone clicks Google before the chunk
 * lands, the `.then` costs a real async gap, `window.open` is refused, and the SDK reports
 * `auth/popup-blocked` — which `shouldRetryWithRedirect` already converts into
 * `signInWithRedirect`, the same full-page fallback that has always covered a blocked popup. The
 * visitor gets Google sign-in either way; on the cold path it is a redirect rather than a popup.
 */
export function loginWithGoogle(): Promise<unknown> {
  const m = loaded;
  if (m) return m.loginWithGoogle();
  return activateFirebaseAuth().then((mod) => mod.loginWithGoogle());
}

/** Email/password sign-in. Not gesture-sensitive (no popup), so an await here is harmless. */
export async function loginWithEmail(
  email: string,
  password: string,
): Promise<unknown> {
  return (await activateFirebaseAuth()).loginWithEmail(email, password);
}

export async function signupWithEmail(
  email: string,
  password: string,
  displayName?: string,
): Promise<unknown> {
  return (await activateFirebaseAuth()).signupWithEmail(
    email,
    password,
    displayName,
  );
}

export async function sendPasswordReset(email: string): Promise<unknown> {
  return (await activateFirebaseAuth()).sendPasswordReset(email);
}

/** End the session. Resolves without loading anything if the boundary was never activated —
 *  there is no session to end in that case. */
export async function logout(): Promise<void> {
  if (!pending) return;
  const m = await pending.catch(() => undefined);
  await m?.logout();
}

/**
 * The failed-redirect message from a `signInWithRedirect` return leg, or null.
 *
 * Activates deliberately: this is called from AuthPage, and reading the outcome is the entire
 * reason ./firebase captures it. Short-circuits on an unconfigured build so /auth there stays
 * SDK-free (it can only offer the `nry_` paste anyway).
 */
export async function takeRedirectSignInError(): Promise<string | null> {
  if (!firebaseConfigured) return null;
  return (await activateFirebaseAuth()).takeRedirectSignInError();
}
