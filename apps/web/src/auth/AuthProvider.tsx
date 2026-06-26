/**
 * Auth context: initializes Keycloak once on mount and exposes session state +
 * login/logout to the app. OIDC is the primary login; the pasted `nry_` token
 * (handled in lib/auth.ts) remains a secondary path, so the app still renders if
 * Keycloak is unreachable (init failure → ready, not authenticated).
 */
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { initKeycloak, keycloak } from "../lib/keycloak";

export interface AuthState {
  /** Keycloak init has finished (success or failure) — gates protected routes. */
  ready: boolean;
  /** A Keycloak session is active. */
  authenticated: boolean;
  /** OIDC subject (user id) and tenant claim, when logged in. */
  subject?: string;
  tenant?: string;
  /** Start the Authorization Code + PKCE redirect, returning to the app after. */
  login: () => void;
  /** End the Keycloak session and return to the sign-in screen. */
  logout: () => void;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);

  useEffect(() => {
    let mounted = true;
    initKeycloak()
      .then((auth) => {
        if (mounted) {
          setAuthenticated(auth);
          setReady(true);
        }
      })
      .catch(() => {
        // Keycloak unreachable — still let the app load (token-paste fallback).
        if (mounted) setReady(true);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const value: AuthState = {
    ready,
    authenticated,
    subject: keycloak.tokenParsed?.sub,
    tenant: (keycloak.tokenParsed as Record<string, unknown> | undefined)
      ?.tenant as string | undefined,
    login: () =>
      keycloak.login({ redirectUri: `${window.location.origin}/app` }),
    logout: () =>
      keycloak.logout({ redirectUri: `${window.location.origin}/auth` }),
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}
