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
  /** True when a Firebase web config was provided at build time (else login is
   *  unavailable and only the `nry_` token paste works). */
  configured: boolean;
  /** Primary login (Google popup); awaitable so callers can surface errors. */
  login: () => Promise<void>;
  /** Email/password sign-in + sign-up (used by the auth screen). */
  loginEmail: (email: string, password: string) => Promise<void>;
  signupEmail: (email: string, password: string) => Promise<void>;
  /** End the Firebase session and return to the sign-in screen. */
  logout: () => void;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [tenant, setTenant] = useState<string | undefined>(undefined);

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
    authenticated: Boolean(user),
    subject: user?.uid,
    tenant,
    configured: firebaseConfigured,
    login: async () => {
      await loginWithGoogle();
    },
    loginEmail: async (email, password) => {
      await loginWithEmail(email, password);
    },
    signupEmail: async (email, password) => {
      await signupWithEmail(email, password);
    },
    logout: () => {
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
