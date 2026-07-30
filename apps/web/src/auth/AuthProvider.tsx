/**
 * Auth context: subscribes to Firebase auth state and exposes session state +
 * login/logout to the app. Firebase is the primary login; the pasted `nry_` token
 * (handled in lib/auth.ts) remains a secondary path, so the app still renders if
 * Firebase isn't configured (no project → ready, not authenticated).
 *
 * MOUNTED ABOVE THE ROUTER, so this component renders on the public form/chat/approve pages too
 * — which is exactly why it must not import lib/firebase. Everything Firebase here goes through
 * lib/firebase-lazy's async boundary; the only fact taken synchronously is `firebaseConfigured`,
 * from the SDK-free lib/firebase-env. `import type { User }` erases, so it costs nothing.
 *
 * IT DOES NOT ACTIVATE THE BOUNDARY ITSELF. It waits for someone who actually needs auth —
 * RequireAuth or AuthPage, plus the matching route loaders — to call `warmFirebaseAuth()`. On a
 * public page nobody does, so `ready` stays false and no SDK is fetched. See lib/firebase-lazy.
 */
import type { User } from "firebase/auth";
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { firebaseConfigured } from "../lib/firebase-env";
import {
  activateFirebaseAuth,
  logout as fbLogout,
  loginWithEmail,
  loginWithGoogle,
  sendPasswordReset,
  signupWithEmail,
  whenFirebaseAuthLoaded,
} from "../lib/firebase-lazy";

export interface AuthState {
  /** Firebase auth init has resolved (success or failure) — gates protected routes.
   *  Stays false on pages that never activate the auth boundary (the public ones). */
  ready: boolean;
  /** A Firebase session is active. */
  authenticated: boolean;
  /** Firebase uid and tenant custom-claim, when signed in. */
  subject?: string;
  tenant?: string;
  /** Signed-in user's email, when available (shown on the NotAvailable screen). */
  email?: string;
  /** Whether the signed-in user's email is verified — gates workspace creation. */
  emailVerified: boolean;
  /** True when a Firebase web config was provided at build time (else login is
   *  unavailable and only the `nry_` token paste works). */
  configured: boolean;
  /** Start loading the Firebase auth SDK and resolving the session. Idempotent; call it from
   *  anything that needs `ready`/`authenticated` to become meaningful. */
  activate: () => void;
  /** Primary login (Google popup); awaitable so callers can surface errors. */
  login: () => Promise<void>;
  /** Email/password sign-in + sign-up (used by the auth screen). */
  loginEmail: (email: string, password: string) => Promise<void>;
  signupEmail: (
    email: string,
    password: string,
    fullName?: string,
  ) => Promise<void>;
  /** Send a Firebase password-reset email to the given address. */
  resetPassword: (email: string) => Promise<void>;
  /** End the Firebase session and return to the sign-in screen. */
  logout: () => void;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [tenant, setTenant] = useState<string | undefined>(undefined);
  /**
   * Sign-out is in flight. `signOut()` is fire-and-forget at every call site, which then navigates
   * to /auth in the same tick — so without this, `authenticated` is still true when AuthPage
   * mounts, and its "already signed in" guard would bounce the user straight back into /app until
   * onAuthStateChanged caught up: a visible flicker plus API calls made as a user who just left.
   * Held here rather than fixed at the call sites so a future one can't reintroduce it.
   */
  const [signingOut, setSigningOut] = useState(false);

  // Stable identity: useAuthSession puts this in an effect dependency list, and the context value
  // object is rebuilt on every render.
  const activate = useCallback(() => {
    if (firebaseConfigured) void activateFirebaseAuth();
  }, []);

  useEffect(() => {
    // No Firebase config (build without VITE_FIREBASE_*) ⇒ no session to restore and no chunk
    // worth fetching; mark ready so the app renders (the `nry_` token paste still works).
    if (!firebaseConfigured) {
      setReady(true);
      return;
    }
    // Waits for someone to activate the boundary — it never activates on a public page, so this
    // subscription simply never fires there. `unsubAuth` is assigned inside the callback; the
    // cleanup closes over the same binding, so a late arrival is still torn down.
    let unsubAuth: (() => void) | undefined;
    const stop = whenFirebaseAuthLoaded(
      (fb) => {
        // Fires once with the restored session (or null) on load, then on every
        // sign-in/out. Resolving it flips `ready` so routes stop waiting.
        unsubAuth = fb.subscribeToAuth(
          async (u) => {
            setUser(u);
            // Any real auth-state emission supersedes an in-flight sign-out (including a failed
            // one, so the flag can never stick and lock a signed-in user out of their session).
            setSigningOut(false);
            if (u) {
              try {
                const res = await u.getIdTokenResult();
                setTenant(res.claims.tenant as string | undefined);
              } catch {
                setTenant(undefined);
              }
            } else {
              setTenant(undefined);
            }
            setReady(true);
          },
          () => setReady(true), // init error — still let the app load (token fallback)
        );
      },
      // The chunk itself failed to load (offline, or a stale client after a deploy). Let the app
      // render rather than hanging on a gate that will never open — the `nry_` paste path is
      // still usable, and main.tsx's vite:preloadError handler reloads for fresh assets.
      () => setReady(true),
    );
    return () => {
      stop();
      unsubAuth?.();
    };
  }, []);

  const value: AuthState = {
    ready,
    authenticated: Boolean(user) && !signingOut,
    subject: user?.uid,
    tenant,
    email: user?.email ?? undefined,
    emailVerified: Boolean(user?.emailVerified),
    configured: firebaseConfigured,
    activate,
    login: async () => {
      // NO `await` BEFORE THIS CALL. loginWithGoogle is deliberately non-async so the click's
      // gesture window survives all the way to signInWithPopup (#800). See lib/firebase-lazy.
      await loginWithGoogle();
    },
    loginEmail: async (email, password) => {
      await loginWithEmail(email, password);
    },
    signupEmail: async (email, password, fullName) => {
      await signupWithEmail(email, password, fullName);
    },
    resetPassword: async (email) => {
      await sendPasswordReset(email);
    },
    logout: () => {
      setSigningOut(true);
      // Clear the flag only if sign-out FAILS. On success the auth-state emission clears it (and
      // clearing it here could land before that emission, briefly re-admitting the leaving user).
      // Without this branch a rejected signOut — which need not emit anything — leaves the flag
      // stuck on, hiding a session that is in fact still live.
      void fbLogout().catch(() => setSigningOut(false));
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}

/**
 * Read the auth session AND declare that this component needs it — activating the async boundary
 * on mount if a route loader hasn't already. Use this instead of `useAuth()` in anything that
 * gates on `ready`/`authenticated`; plain `useAuth()` stays correct for components that only read
 * `email`/`logout` from inside an already-activated subtree.
 */
export function useAuthSession(): AuthState {
  const state = useAuth();
  const { activate } = state;
  useEffect(() => {
    activate();
  }, [activate]);
  return state;
}
