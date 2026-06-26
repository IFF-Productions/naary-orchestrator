/**
 * Keycloak (OIDC) singleton for the SPA. One instance per page; `initKeycloak()`
 * is idempotent (guarded by a module-level promise) so React StrictMode's double
 * effect, or multiple callers, don't init twice. Login is Authorization Code +
 * PKCE against the public `naary-web` client; the access token carries the
 * `tenant` claim the API authorizes on.
 *
 * Config is public (no client secret — PKCE) and comes from Vite env with dev
 * defaults pointing at the local Keycloak.
 */
import Keycloak from "keycloak-js";
import { getToken } from "./auth";

const config = {
  url: import.meta.env.VITE_KEYCLOAK_URL ?? "http://localhost:8080",
  realm: import.meta.env.VITE_KEYCLOAK_REALM ?? "naary",
  clientId: import.meta.env.VITE_KEYCLOAK_CLIENT_ID ?? "naary-web",
};

export const keycloak = new Keycloak(config);

let initPromise: Promise<boolean> | undefined;

/** Initialize once; resolves to whether a session was restored. Never rejects on a
 *  missing session (check-sso) — only on a genuine Keycloak-unreachable error. */
export function initKeycloak(): Promise<boolean> {
  if (!initPromise) {
    initPromise = keycloak
      .init({
        onLoad: "check-sso",
        silentCheckSsoRedirectUri: `${window.location.origin}/silent-check-sso.html`,
        pkceMethod: "S256",
        // The login-status iframe is flaky behind proxies and not needed: we
        // refresh proactively via updateToken() instead.
        checkLoginIframe: false,
      })
      .then((authenticated) => {
        // Keep the token fresh: when it nears expiry, refresh in the background.
        keycloak.onTokenExpired = () => {
          void keycloak.updateToken(30).catch(() => {
            /* refresh failed (session gone); next API call falls back / 401s */
          });
        };
        return authenticated;
      });
  }
  return initPromise;
}

/**
 * The bearer token for an API call: a FRESH Keycloak access token when logged in
 * (refreshed if it's within 30s of expiry), otherwise the pasted `nry_` API token
 * (the secondary/"advanced" path). Returns null when neither is available.
 */
export async function getBearerToken(): Promise<string | null> {
  if (keycloak.authenticated) {
    try {
      await keycloak.updateToken(30);
    } catch {
      /* refresh failed; fall through to the paste fallback / unauthenticated */
    }
    if (keycloak.token) return keycloak.token;
  }
  return getToken();
}
