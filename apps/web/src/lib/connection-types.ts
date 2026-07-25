/**
 * Which connection types each connection-based node can use — the ONE map for it, so the
 * canvas inspector's connection picker and the Templates screen's post-import connection
 * checklist can never drift apart.
 *
 * Extracted from screens/canvas/fields.tsx (which still re-exports it) so a non-canvas
 * screen can import it WITHOUT pulling the canvas/react-flow chunk in: this module is
 * pure data with a type-only import.
 *
 * Mirrors the Integrations forms: MCP/app servers = github/atlassian/custom; SQL engines;
 * smtp; signing.
 */
import type { ConnectionType } from "./api/types";

export const CONNECTION_TYPES: Record<string, ConnectionType[]> = {
  mcpTool: ["github", "atlassian", "custom"],
  integration: ["github", "atlassian", "custom"],
  // codeAgent write mode authorizes the clone + PR via a GitHub App connection.
  codeAgent: ["github"],
  httpRequest: ["github", "atlassian", "custom"],
  sqlQuery: ["postgres", "mssql", "mysql"],
  sqlExec: ["postgres", "mssql", "mysql"],
  sendEmail: ["smtp"],
  hmac: ["signing"],
  jwt: ["signing"],
  totp: ["signing"],
};

/**
 * Connection types that are apps/servers, i.e. the Integrations screen's "Apps & agents"
 * tab; every other type is created on the "Providers (BYOK)" tab. Lives here (not in the
 * AppsTab screen it was extracted from, which still re-exports it) so a pure module can
 * route a "connect this" CTA at the right tab without importing a React screen.
 */
export const APP_CONNECTION_TYPES: ConnectionType[] = [
  "github",
  "atlassian",
  "custom",
];

/** Integrations tab that hosts the connect form for a connection type. */
export function integrationsTabFor(type: ConnectionType): "apps" | "providers" {
  return APP_CONNECTION_TYPES.includes(type) ? "apps" : "providers";
}
