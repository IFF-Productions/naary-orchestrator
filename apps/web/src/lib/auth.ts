/**
 * Client-side API-token store. The control plane authenticates with a per-tenant
 * bearer token (minted server-side); the web app holds it in localStorage and
 * attaches it to every API call. tenantId is resolved from the token server-side,
 * so the client never sends it.
 *
 * This is the pragmatic prototype auth: a real login that issues the token is a
 * later product step; for now the token is pasted on the Auth screen.
 */
const TOKEN_KEY = "naary_api_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token.trim());
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export function hasToken(): boolean {
  return !!getToken();
}
