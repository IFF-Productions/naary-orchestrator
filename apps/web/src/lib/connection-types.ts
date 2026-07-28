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

/** Human name per connection type — so an error can say "a GitHub connection", not "github". */
const TYPE_LABEL: Record<ConnectionType, string> = {
  github: "GitHub",
  atlassian: "Atlassian",
  custom: "custom MCP server",
  postgres: "Postgres",
  mssql: "SQL Server",
  mysql: "MySQL",
  signing: "signing-key",
  smtp: "SMTP",
};

/** "GitHub" / "Postgres, SQL Server or MySQL" — the acceptable types, read out loud. */
export function connectionTypeLabel(types: readonly ConnectionType[]): string {
  const names = types.map((t) => TYPE_LABEL[t] ?? t);
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

/**
 * The connection types a node MUST have configured, or null when it needs none.
 *
 * `codeAgent` is the reason this is a function rather than a lookup. Its `connectionId` is
 * OPTIONAL and only used in write mode — read mode (the DEFAULT) runs in-worker with no repo and
 * no clone, so it needs no connection at all. The canvas used to demand one from every codeAgent,
 * which put an author in a dead end: the inspector only renders the connection picker under
 * `mode === "write"`, so the error told them to pick a connection in a control the UI was
 * deliberately hiding. Reported from a real graph whose codeAgent had no `mode` set.
 *
 * `httpRequest`'s is optional for the plainer reason that a public API needs no auth.
 */
export function requiredConnectionTypes(node: {
  type: string;
  config?: Record<string, unknown> | null;
}): ConnectionType[] | null {
  const types = CONNECTION_TYPES[node.type];
  if (!types) return null;
  if (node.type === "httpRequest") return null;
  if (node.type === "codeAgent")
    return node.config?.mode === "write" ? types : null;
  return types;
}
