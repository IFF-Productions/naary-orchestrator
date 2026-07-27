/**
 * Auth context: subscribes to Firebase auth state and exposes session state +
 * login/logout to the app. Firebase is the primary login; the pasted `nry_` token
 * (handled in lib/auth.ts) remains a secondary path, so the app still renders if
 * Firebase isn't configured (no project → ready, not authenticated).
 */
import { type User, onAuthStateChanged } from "firebase/auth";
import {
  type ReactNode,
  createContext,
  useContext,
  useEffect,
  useState,
} from "react";
import {
  auth,
  logout as fbLogout,
  firebaseConfigured,
  loginWithEmail,
  loginWithGoogle,
  sendPasswordReset,
  signupWithEmail,
} from "../lib/firebase";

export interface AuthState {
  /** Firebase auth init has resolved (success or failure) — gates protected routes. */
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

  useEffect(() => {
    // No Firebase config (build without VITE_FIREBASE_*) ⇒ no session to restore;
    // mark ready so the app renders (the `nry_` token paste still works).
    if (!auth) {
      setReady(true);
      return;
    }
    // Fires once with the restored session (or null) on load, then on every
    // sign-in/out. Resolving it flips `ready` so routes stop waiting.
    const unsub = onAuthStateChanged(
      auth,
      async (u) => {
        setUser(u);
        // Any real auth-state emission supersedes an in-flight sign-out (including a failed one,
        // so the flag can never stick and lock a signed-in user out of their own session).
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
    return unsub;
  }, []);

  const value: AuthState = {
    ready,
    authenticated: Boolean(user) && !signingOut,
    subject: user?.uid,
    tenant,
    email: user?.email ?? undefined,
    emailVerified: Boolean(user?.emailVerified),
    configured: firebaseConfigured,
    login: async () => {
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
      void fbLogout();
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}
