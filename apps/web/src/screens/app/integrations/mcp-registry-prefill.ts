/**
 * PURE mapping from a picked MCP-registry row (#578) to the connect form's initial values.
 *
 * Kept out of the component (and free of any runtime import — the row type comes in as `import
 * type`, which is erased) so it can be unit-tested in the web suite's node environment.
 */
import type { McpRegistryServerRow } from "../../../lib/api";

export interface McpConnectPrefill {
  label: string;
  serverUrl: string;
  type: "custom";
  authMode: "api_token" | "pat" | "oauth";
  note: string;
}

/**
 * How a picked server maps onto the connection form. A server that needs NO credential still opens
 * the token-based form (the token field is optional) with a note saying it can stay blank — there is
 * no "none" auth mode on a Connection.
 */
export function prefillFor(server: McpRegistryServerRow): McpConnectPrefill {
  return {
    label: server.name,
    serverUrl: server.transportUrl,
    // Every registry server is a generic remote MCP endpoint; the `github`/`atlassian` connection
    // types exist for their bespoke OAuth apps, not for arbitrary registry rows.
    type: "custom",
    authMode: server.authMode === "none" ? "api_token" : server.authMode,
    note: server.requiresAuth
      ? `Transport pre-filled from the MCP registry. Supply the credential ${server.name} expects.`
      : `Transport pre-filled from the MCP registry. ${server.name} needs no credential — leave the token blank.`,
  };
}
