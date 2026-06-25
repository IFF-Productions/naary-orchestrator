import { SecretStore } from "@naary/secrets";
import { ConnectionService, connectionSecretKey } from "./connection.service";
import { MissingConnectionTokenError } from "./errors";
import { getOAuthAccessToken } from "./oauth";

// Re-export so existing imports from '@naary/connections' keep working.
export { MissingConnectionTokenError, NeedsReauthError } from "./errors";

export interface AuthDeps {
  connections?: ConnectionService;
  store?: SecretStore;
}

/**
 * Resolve the Authorization header for an MCP call. PAT/api_token paths return
 * the stored token as a Bearer header (B1). OAuth uses non-interactive refresh
 * (B4). The token is used in-memory for the call only — never returned separately
 * or logged.
 */
export async function resolveAuthHeader(
  tenantId: string,
  connectionId: string,
  deps: AuthDeps = {},
): Promise<Record<string, string>> {
  const connections = deps.connections ?? new ConnectionService();
  const store = deps.store ?? new SecretStore();

  const conn = await connections.getById(tenantId, connectionId);
  if (!conn) {
    throw new Error(`Unknown connection '${connectionId}'`);
  }

  if (conn.authMode === "api_token" || conn.authMode === "pat") {
    const token = await store.get(tenantId, connectionSecretKey(connectionId));
    if (!token) {
      throw new MissingConnectionTokenError(connectionId);
    }
    return { Authorization: `Bearer ${token}` };
  }

  if (conn.authMode === "oauth") {
    // B4: non-interactive refresh (cached + per-connection lock) from the stored
    // refresh token. invalid_grant flips the connection to needs_reauth.
    const accessToken = await getOAuthAccessToken(tenantId, connectionId, {
      store,
      connections,
    });
    return { Authorization: `Bearer ${accessToken}` };
  }

  throw new Error(`Unsupported authMode '${conn.authMode}'`);
}
