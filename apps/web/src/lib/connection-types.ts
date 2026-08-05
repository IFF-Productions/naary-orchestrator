/**
 * Connection-type helpers for the web app: the node→accepted-types map (re-exported from
 * @naary/dsl) plus the presentation bits only the SPA needs (labels, which Integrations tab
 * hosts each type's connect form).
 *
 * The map itself moved to `@naary/dsl/connection-types` in #830 — the AI graph generator has to
 * apply the same rule server-side, and two copies of it would be exactly the kind of drift this
 * module was created to prevent. Still re-exported here (and from screens/canvas/fields.tsx) so
 * every existing importer is unchanged, and so a non-canvas screen can read it WITHOUT pulling
 * the canvas/react-flow chunk in.
 */
import type { ConnectionType } from "./api/types";

// The shared map + its "does this node REQUIRE one" helper. Web's `ConnectionType` and the DSL's
// are the same union, so the re-export is transparent to every caller.
export {
  CONNECTION_TYPES,
  requiredConnectionTypes,
} from "@naary/dsl/dist/connection-types";

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
  firestore: "Cloud Firestore",
  kafka: "Kafka",
  mqtt: "MQTT",
  signing: "signing-key",
  smtp: "SMTP",
};

/** "GitHub" / "Postgres, SQL Server or MySQL" — the acceptable types, read out loud. */
export function connectionTypeLabel(types: readonly ConnectionType[]): string {
  const names = types.map((t) => TYPE_LABEL[t] ?? t);
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}
