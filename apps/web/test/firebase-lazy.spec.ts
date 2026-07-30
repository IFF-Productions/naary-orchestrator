/**
 * The behavioural half of the async Firebase auth boundary (`src/lib/firebase-lazy.ts`).
 * `eager-bundle.spec.ts` proves the SDK is off the critical path; this file proves the two
 * properties that make that safe rather than merely smaller.
 *
 * 1. `loginWithGoogle` REACHES THE SDK SYNCHRONOUSLY. This is the #800 tripwire. Firebase's
 *    `signInWithPopup` already spends two network round trips before `window.open` — App Check
 *    among them — and a failing await ahead of that once ate the browser's user-gesture window
 *    and broke Google sign-in outright. Crossing an async boundary is precisely the change that
 *    reintroduces it: writing `export async function loginWithGoogle() { const m = await
 *    loadFirebase(); … }` is a one-word difference that no type, no build and no ordinary test
 *    would catch, because an `await` on an ALREADY-RESOLVED promise still costs a microtask.
 *    The assertion below therefore drains nothing: it calls, then checks the spy in the SAME
 *    synchronous block. Add an await inside the boundary and it fails.
 *
 * 2. NOTHING PULLS THE SDK IN BY ACCIDENT. `getBearerToken` is called by every API request,
 *    including the anonymous form/chat ones. If it activated the boundary to discover there is
 *    no signed-in user, a public form page would download the auth SDK anyway and the whole
 *    boundary would be decorative — and, again, silently: the app would work perfectly.
 *
 * `vi.resetModules()` per test rather than an exported reset seam: the boundary's state IS module
 * state, and re-importing is the only way to genuinely test "nobody has activated yet".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A stand-in for the real `src/lib/firebase` module behind the dynamic import. */
const fb = {
  loginWithGoogle: vi.fn(() => Promise.resolve("popup-result")),
  loginWithEmail: vi.fn(() => Promise.resolve("email-result")),
  signupWithEmail: vi.fn(() => Promise.resolve("signup-result")),
  sendPasswordReset: vi.fn(() => Promise.resolve()),
  logout: vi.fn(() => Promise.resolve()),
  getBearerToken: vi.fn(() => Promise.resolve("id-token")),
  takeRedirectSignInError: vi.fn(() => Promise.resolve("redirect failed")),
  subscribeToAuth: vi.fn(() => () => undefined),
  auth: undefined,
  firebaseConfigured: true,
};
vi.mock("../src/lib/firebase", () => fb);

/** lib/auth reads localStorage unguarded; node has none. */
const store = new Map<string, string>();
const localStorageStub = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

type Boundary = typeof import("../src/lib/firebase-lazy");

/** A fresh copy of the boundary, with no activation yet. */
async function freshBoundary(): Promise<Boundary> {
  vi.resetModules();
  return import("../src/lib/firebase-lazy");
}

beforeEach(() => {
  store.clear();
  vi.stubGlobal("localStorage", localStorageStub);
  // firebase-env computes `firebaseConfigured` at module load; a configured build is the case
  // that actually exercises the boundary.
  vi.stubEnv("VITE_FIREBASE_API_KEY", "test-api-key");
  for (const spy of Object.values(fb)) {
    if (typeof spy === "function")
      (spy as ReturnType<typeof vi.fn>).mockClear();
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("the Google sign-in click path stays synchronous (#800)", () => {
  it("calls into the SDK with no microtask between the click and signInWithPopup", async () => {
    const boundary = await freshBoundary();
    // Warm the boundary the way /auth's route loader does, long before any click.
    await boundary.activateFirebaseAuth();
    fb.loginWithGoogle.mockClear();

    // THE ASSERTION. No `await`, no `.then`, nothing that drains the microtask queue between
    // these two lines — exactly the shape of a browser click handler.
    const promise = boundary.loginWithGoogle();
    expect(fb.loginWithGoogle).toHaveBeenCalledTimes(1);

    await expect(promise).resolves.toBe("popup-result");
  });

  it("falls back to the async path (→ redirect, via popup-blocked) when clicked cold", async () => {
    const boundary = await freshBoundary();
    // No activation: the chunk is still in flight or never started.
    const promise = boundary.loginWithGoogle();
    // It cannot have been synchronous here — there was nothing to call yet. This is the defined
    // degradation: the popup is refused, and firebase.ts's shouldRetryWithRedirect turns
    // auth/popup-blocked into signInWithRedirect.
    expect(fb.loginWithGoogle).not.toHaveBeenCalled();
    await expect(promise).resolves.toBe("popup-result");
    expect(fb.loginWithGoogle).toHaveBeenCalledTimes(1);
  });
});

describe("nothing loads the SDK by accident", () => {
  it("getBearerToken answers from the nry_ store without activating", async () => {
    const boundary = await freshBoundary();
    store.set("naary_api_token", "nry_pasted");

    expect(await boundary.getBearerToken()).toBe("nry_pasted");
    // The load-bearing half: the SDK was never asked for. A public form page makes API calls,
    // and they must not drag 138 KB of auth in behind them.
    expect(fb.getBearerToken).not.toHaveBeenCalled();
  });

  it("getBearerToken returns null (not a hang) with neither a session nor a token", async () => {
    const boundary = await freshBoundary();
    expect(await boundary.getBearerToken()).toBeNull();
    expect(fb.getBearerToken).not.toHaveBeenCalled();
  });

  it("getBearerToken WAITS for an in-flight activation instead of racing it", async () => {
    const boundary = await freshBoundary();
    store.set("naary_api_token", "nry_pasted");
    // Activation started but not awaited — the window in which a signed-in user's first request
    // could otherwise go out carrying the wrong credential.
    void boundary.activateFirebaseAuth();

    expect(await boundary.getBearerToken()).toBe("id-token");
    expect(fb.getBearerToken).toHaveBeenCalledTimes(1);
  });

  it("whenFirebaseAuthLoaded never fires while nobody activates", async () => {
    const boundary = await freshBoundary();
    const onLoad = vi.fn();
    boundary.whenFirebaseAuthLoaded(onLoad);

    // Drain the microtask queue a few times: a subscriber on a public page must simply never be
    // called, which is what leaves AuthProvider's `ready` false there.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(onLoad).not.toHaveBeenCalled();
  });

  it("whenFirebaseAuthLoaded delivers to both earlier and later subscribers", async () => {
    const boundary = await freshBoundary();
    const early = vi.fn();
    const late = vi.fn();
    boundary.whenFirebaseAuthLoaded(early);
    await boundary.activateFirebaseAuth();
    expect(early).toHaveBeenCalledTimes(1);

    // A subscriber that mounts AFTER the load still gets the module — otherwise a remount of
    // AuthProvider (StrictMode's double-invoke, a route error boundary) would wedge `ready`.
    boundary.whenFirebaseAuthLoaded(late);
    await Promise.resolve();
    expect(late).toHaveBeenCalledTimes(1);
  });

  it("unsubscribing stops delivery", async () => {
    const boundary = await freshBoundary();
    const onLoad = vi.fn();
    const stop = boundary.whenFirebaseAuthLoaded(onLoad);
    stop();
    await boundary.activateFirebaseAuth();
    expect(onLoad).not.toHaveBeenCalled();
  });

  it("logout resolves without loading anything when there was no session", async () => {
    const boundary = await freshBoundary();
    await boundary.logout();
    expect(fb.logout).not.toHaveBeenCalled();
  });

  it("activateFirebaseAuth is idempotent", async () => {
    const boundary = await freshBoundary();
    const [a, b] = await Promise.all([
      boundary.activateFirebaseAuth(),
      boundary.activateFirebaseAuth(),
    ]);
    expect(a).toBe(b);
  });
});

describe("unconfigured builds never fetch the chunk", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_FIREBASE_API_KEY", "");
  });

  it("warmFirebaseAuth is a no-op and takeRedirectSignInError short-circuits", async () => {
    const boundary = await freshBoundary();
    boundary.warmFirebaseAuth();
    expect(await boundary.takeRedirectSignInError()).toBeNull();
    expect(fb.takeRedirectSignInError).not.toHaveBeenCalled();

    // …and the paste path still works, which is the whole point of tolerating no Firebase.
    store.set("naary_api_token", "nry_pasted");
    expect(await boundary.getBearerToken()).toBe("nry_pasted");
  });
});
