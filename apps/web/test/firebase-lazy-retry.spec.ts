/**
 * RECOVERY from a failed auth-SDK chunk load — `src/lib/firebase-lazy.ts`.
 *
 * WHY THIS MATTERS AT ALL. Before the async boundary, `firebase` was in the eager bundle and was
 * therefore simply *present*: if the page rendered, the SDK was there. Now its availability depends
 * on a network fetch that can fail — offline, a CDN blip, a stale client whose hashed chunk is gone
 * after a deploy — so the retry path is part of the feature, not a nicety.
 *
 * THE BUG THIS PINS (found in review on #942). `activateFirebaseAuth` memoizes on `if (!pending)`.
 * If the rejection handler does not clear `pending`, one transient failure leaves a permanently-
 * rejected promise in it and every later call returns that same rejection: the visitor clicks Sign
 * in, gets the same stale error, and nothing short of a full page reload helps. The app looks alive
 * and sign-in is simply dead.
 *
 * WHY A SEPARATE FILE from firebase-lazy.spec.ts, and why `vi.doMock`. Making the load fail means
 * making the mocked `../src/lib/firebase` module THROW on evaluation. A `vi.mock` factory cannot do
 * that conditionally: it is hoisted and its result is cached on first evaluation, so a
 * fail-then-succeed counter reads 0 and the tests go silently vacuous (measured — that is exactly
 * what happened first). `vi.doMock` is NOT hoisted, so registering it per test with
 * `vi.resetModules()` gets the factory re-invoked — verified: first import rejects, second resolves,
 * factory called twice. Keeping these cases in their own file keeps that machinery away from the
 * happy-path spec.
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

/** How many of the next module evaluations must FAIL. The factory decrements it. */
let failNextImports = 0;
/** How many times the factory ran — the non-vacuity witness for every test below. */
let factoryCalls = 0;

/** lib/auth reads localStorage unguarded; node has none. */
const store = new Map<string, string>();
const localStorageStub = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

type Boundary = typeof import("../src/lib/firebase-lazy");

/** A fresh copy of the boundary, with no activation yet and a re-armed (non-hoisted) mock. */
async function freshBoundary(): Promise<Boundary> {
  vi.resetModules();
  vi.doMock("../src/lib/firebase", () => {
    factoryCalls++;
    if (failNextImports > 0) {
      failNextImports--;
      throw new Error("chunk load failed");
    }
    return fb;
  });
  return import("../src/lib/firebase-lazy");
}

/** `resolves.toBe(fb)` makes vitest try to pretty-print a mocked module and blow up; identify it
 *  by a member instead. */
const isTheModule = async (p: Promise<unknown>) =>
  ((await p) as typeof fb).getBearerToken === fb.getBearerToken;

beforeEach(() => {
  store.clear();
  failNextImports = 0;
  factoryCalls = 0;
  vi.stubGlobal("localStorage", localStorageStub);
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

describe("a failed auth-SDK load must not latch", () => {
  it("retries on the next call instead of replaying the cached rejection", async () => {
    failNextImports = 1;
    const boundary = await freshBoundary();

    const first = boundary.activateFirebaseAuth();
    await expect(first).rejects.toThrow();

    // THE ASSERTION that pins the fix: a fresh attempt, not the cached rejection. `if (!pending)`
    // without clearing `pending` on failure returns the very same promise here.
    const second = boundary.activateFirebaseAuth();
    expect(second).not.toBe(first);
    expect(await isTheModule(second)).toBe(true);

    // Non-vacuity: the import really was attempted twice, and the first really did fail.
    expect(factoryCalls).toBe(2);
    expect(failNextImports).toBe(0);

    // And the recovered module is genuinely usable — sign-in works on the retry.
    await expect(boundary.getBearerToken()).resolves.toBe("id-token");
  });

  it("recovers through the sign-in call sites, not just activateFirebaseAuth", async () => {
    // The real recovery path is the visitor's SECOND click. AuthScreen calls these, so they are
    // what must re-import; asserting only on activateFirebaseAuth would leave that untested.
    failNextImports = 1;
    const boundary = await freshBoundary();

    await expect(boundary.loginWithEmail("a@b.co", "pw")).rejects.toThrow();
    await expect(boundary.loginWithEmail("a@b.co", "pw")).resolves.toBe(
      "email-result",
    );
    expect(fb.loginWithEmail).toHaveBeenCalledTimes(1);
    expect(factoryCalls).toBe(2);
  });

  it("leaves no stale error for a subscriber that arrives during the retry", async () => {
    failNextImports = 1;
    const boundary = await freshBoundary();
    const onLoad = vi.fn();
    const onError = vi.fn();

    await expect(boundary.activateFirebaseAuth()).rejects.toThrow();
    // A subscriber mounting after the failure IS told, so AuthProvider can flip `ready` instead of
    // hanging on a gate that will never open.
    boundary.whenFirebaseAuthLoaded(onLoad, onError);
    await Promise.resolve();
    expect(onError).toHaveBeenCalledTimes(1);

    // …but once a retry is under way the stale failure must not be replayed to someone new.
    void boundary.activateFirebaseAuth();
    const late = { onLoad: vi.fn(), onError: vi.fn() };
    boundary.whenFirebaseAuthLoaded(late.onLoad, late.onError);
    await boundary.activateFirebaseAuth();
    await Promise.resolve();
    expect(late.onError).not.toHaveBeenCalled();
    expect(late.onLoad).toHaveBeenCalledTimes(1);
  });

  it("shares one attempt among concurrent callers, before and after the failure", async () => {
    failNextImports = 1;
    const boundary = await freshBoundary();
    // Two concurrent activations must join the SAME attempt (no double fetch)…
    const a = boundary.activateFirebaseAuth();
    const b = boundary.activateFirebaseAuth();
    expect(a).toBe(b);
    await expect(a).rejects.toThrow();
    // …and after it fails, one retry serves everyone.
    const c = boundary.activateFirebaseAuth();
    const d = boundary.activateFirebaseAuth();
    expect(c).toBe(d);
    expect(await isTheModule(c)).toBe(true);
    expect(factoryCalls).toBe(2); // not four — the sharing is real
  });

  it("getBearerToken falls back to the nry_ token when the load failed", async () => {
    failNextImports = 1;
    const boundary = await freshBoundary();
    store.set("naary_api_token", "nry_pasted");

    await expect(boundary.activateFirebaseAuth()).rejects.toThrow();
    // Degrade, don't throw: a failed SDK load must not break the secondary auth path.
    expect(await boundary.getBearerToken()).toBe("nry_pasted");
  });

  it("a route loader's fire-and-forget warm does not strand the retry either", async () => {
    failNextImports = 1;
    const boundary = await freshBoundary();

    // warmFirebaseAuth is what router.tsx's loaders call, and it discards the promise. Its attempt
    // is the SHARED one, so asking for it here returns the same (failing) promise rather than
    // starting a second fetch — which is also how we consume the rejection that a real loader
    // never would. The internal `.catch` in activateFirebaseAuth suppresses the unhandled-rejection
    // noise; it must not suppress the unlatch.
    boundary.warmFirebaseAuth();
    await expect(boundary.activateFirebaseAuth()).rejects.toThrow();
    expect(factoryCalls).toBe(1); // one fetch, shared — warm did not start a second

    expect(await isTheModule(boundary.activateFirebaseAuth())).toBe(true);
    expect(factoryCalls).toBe(2);
  });
});
