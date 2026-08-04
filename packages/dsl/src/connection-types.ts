/**
 * Which connection types each connection-based node can use — the ONE map for it.
 *
 * Lived in `apps/web/src/lib/connection-types.ts` (canvas picker + Templates checklist) until the
 * SERVER needed it too: the AI graph generator can only tell a Postgres connection on an
 * `integration` node apart from a valid one if it knows which types that node accepts (#830). Web
 * now re-exports from here so the picker, the checklist and the generator can never drift apart.
 *
 * Mirrors the Integrations forms: MCP/app servers = github/atlassian/custom; SQL engines; smtp;
 * signing. Pure data — no I/O, no zod, safe in a workflow bundle.
 */

/** Connection type — MCP/app servers plus SQL databases, SMTP and signing keys.
 *  Mirrors `ConnectionType` in @naary/connections (which owns the DB-facing definition). */
export type ConnectionType =
  | "github"
  | "atlassian"
  | "custom"
  | "postgres"
  | "mssql"
  | "mysql"
  | "firestore"
  | "kafka"
  | "signing"
  | "smtp";

export const CONNECTION_TYPES: Record<string, ConnectionType[]> = {
  mcpTool: ["github", "atlassian", "custom"],
  integration: ["github", "atlassian", "custom"],
  // codeAgent write mode authorizes the clone + PR via a GitHub App connection.
  codeAgent: ["github"],
  httpRequest: ["github", "atlassian", "custom"],
  sqlQuery: ["postgres", "mssql", "mysql"],
  sqlExec: ["postgres", "mssql", "mysql"],
  kafkaPublish: ["kafka"],
  kafkaTrigger: ["kafka"],
  firestoreQuery: ["firestore"],
  firestoreWrite: ["firestore"],
  sendEmail: ["smtp"],
  hmac: ["signing"],
  jwt: ["signing"],
  totp: ["signing"],
};

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
