import { type Connection, getPrisma } from "@naary/db";
import { SecretStore } from "@naary/secrets";
import { MissingConnectionTokenError } from "./errors";

export type ConnectionType =
  "github" | "atlassian" | "custom" | "postgres" | "mssql" | "signing";
export type AuthMode = "api_token" | "pat" | "oauth" | "connection_string";
export type ConnectionStatus = "connected" | "needs_reauth" | "error";

/** Connection types that are SQL databases (the engine the sqlQuery node uses). */
export type DbEngine = "postgres" | "mssql";
const DB_ENGINES: ReadonlySet<string> = new Set<DbEngine>([
  "postgres",
  "mssql",
]);

export interface CreateConnectionInput {
  type: ConnectionType;
  label: string;
  serverUrl: string;
  authMode: AuthMode;
  scopes?: string[];
  /** PAT/api_token stored encrypted now; oauth refresh tokens arrive via consent. */
  token?: string;
}

/** Public view — NEVER includes the stored token. */
export interface ConnectionView {
  id: string;
  tenantId: string;
  type: ConnectionType;
  label: string;
  serverUrl: string;
  authMode: AuthMode;
  scopes: string[];
  status: ConnectionStatus;
  createdAt: Date;
}

/** Secret-store key for a connection's token (PAT or OAuth refresh token). */
export const connectionSecretKey = (connectionId: string) =>
  `conn:${connectionId}`;

function toView(row: Connection): ConnectionView {
  return {
    id: row.id,
    tenantId: row.tenantId,
    type: row.type as ConnectionType,
    label: row.label,
    serverUrl: row.serverUrl,
    authMode: row.authMode as AuthMode,
    scopes: row.scopes,
    status: row.status as ConnectionStatus,
    createdAt: row.createdAt,
  };
}

export class ConnectionService {
  private readonly store: SecretStore;

  constructor(store?: SecretStore) {
    this.store = store ?? new SecretStore();
  }

  async create(
    tenantId: string,
    input: CreateConnectionInput,
  ): Promise<ConnectionView> {
    const row = await getPrisma().connection.create({
      data: {
        tenantId,
        type: input.type,
        label: input.label,
        serverUrl: input.serverUrl,
        authMode: input.authMode,
        scopes: input.scopes ?? [],
      },
    });
    if (input.token) {
      await this.store.put(tenantId, connectionSecretKey(row.id), input.token);
    }
    return toView(row);
  }

  async list(tenantId: string): Promise<ConnectionView[]> {
    const rows = await getPrisma().connection.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(toView);
  }

  async remove(tenantId: string, id: string): Promise<void> {
    await this.store.remove(tenantId, connectionSecretKey(id));
    await getPrisma().connection.deleteMany({ where: { id, tenantId } });
  }

  getById(tenantId: string, id: string): Promise<Connection | null> {
    return getPrisma().connection.findFirst({ where: { id, tenantId } });
  }

  async setStatus(
    tenantId: string,
    id: string,
    status: ConnectionStatus,
  ): Promise<void> {
    // Tenant-scoped (Arch§3.7): updateMany so the composite where is allowed.
    await getPrisma().connection.updateMany({
      where: { id, tenantId },
      data: { status },
    });
  }
}

/**
 * Resolve a SQL-database connection to its engine + DSN (sibling of
 * resolveMcpTarget). The DSN is the stored secret (full connection string,
 * including password) — read here, used in-activity only, NEVER returned to a
 * caller boundary, logged, or put in workflow history. Throws if the connection
 * is unknown, not a DB type, or has no stored DSN.
 */
export async function resolveDbConnection(
  tenantId: string,
  connectionId: string,
  store: SecretStore = new SecretStore(),
): Promise<{ engine: DbEngine; dsn: string }> {
  const conn = await getPrisma().connection.findFirst({
    where: { id: connectionId, tenantId },
    select: { type: true },
  });
  if (!conn) throw new Error(`Unknown connection '${connectionId}'`);
  if (!DB_ENGINES.has(conn.type)) {
    throw new Error(
      `Connection '${connectionId}' is not a SQL database connection`,
    );
  }
  const dsn = await store.get(tenantId, connectionSecretKey(connectionId));
  if (!dsn) throw new MissingConnectionTokenError(connectionId);
  return { engine: conn.type as DbEngine, dsn };
}

/**
 * Resolve a `signing` connection's secret key for the hmac/jwt nodes. Same shape +
 * invariants as {@link resolveDbConnection}: the key is read here and used
 * in-activity only — NEVER returned to a caller boundary, logged, or put in
 * workflow history. Throws if the connection is unknown, not a signing type, or has
 * no stored key.
 */
export async function resolveSigningKey(
  tenantId: string,
  connectionId: string,
  store: SecretStore = new SecretStore(),
): Promise<string> {
  const conn = await getPrisma().connection.findFirst({
    where: { id: connectionId, tenantId },
    select: { type: true },
  });
  if (!conn) throw new Error(`Unknown connection '${connectionId}'`);
  if (conn.type !== "signing") {
    throw new Error(`Connection '${connectionId}' is not a signing connection`);
  }
  const key = await store.get(tenantId, connectionSecretKey(connectionId));
  if (!key) throw new MissingConnectionTokenError(connectionId);
  return key;
}
