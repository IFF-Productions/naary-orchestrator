import { type Connection, getPrisma } from "@naary/db";
import { SecretStore } from "@naary/secrets";
import { MissingConnectionTokenError } from "./errors";

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
export type AuthMode =
  "api_token" | "pat" | "oauth" | "github_app" | "connection_string";
export type ConnectionStatus = "connected" | "needs_reauth" | "error";

/** Connection types that are SQL databases (the engine the sqlQuery/sqlExec nodes use). */
export type DbEngine = "postgres" | "mssql" | "mysql";
const DB_ENGINES: ReadonlySet<string> = new Set<DbEngine>([
  "postgres",
  "mssql",
  "mysql",
]);

/**
 * Auth modes whose stored secret is a single, clean bearer token — the only ones a last-4 is
 * meaningful for (#471). Deliberately NARROW:
 *   - `pat` / `api_token` store the raw token string (see {@link ConnectionService.create}) — last-4
 *     is the credential's tail, exactly like a card's last-4.
 *   - `connection_string` stores a full DSN/SMTP URI whose tail (`…require`, `…:465`) is a URL
 *     fragment, not a key — excluded.
 *   - `oauth` / `github_app` store a JSON GRANT blob (`{refreshToken,accessToken}` / `{installationId}`,
 *     see oauth.ts / github-app.ts), not a bearer string — a "last-4" there would be JSON punctuation
 *     or a non-secret installation-id fragment, so they're excluded too.
 */
const BEARER_AUTH_MODES: ReadonlySet<string> = new Set<AuthMode>([
  "api_token",
  "pat",
]);

/**
 * Display last-4 of a connection's stored credential (#471): the final 4 chars of a raw bearer token
 * (pat/api_token), for at-a-glance "which key is this?" identification — like a card's last-4, NEVER
 * the whole secret. `null` when the auth mode isn't a raw-token mode, there's no stored token yet, or
 * the secret is shorter than 4 chars (don't reveal a whole short secret).
 */
export function credentialLast4(
  authMode: string,
  secret: string | null,
): string | null {
  if (!BEARER_AUTH_MODES.has(authMode)) return null;
  if (!secret || secret.length < 4) return null;
  return secret.slice(-4);
}

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
    environmentId: string,
    input: CreateConnectionInput,
  ): Promise<ConnectionView> {
    const row = await getPrisma().connection.create({
      data: {
        tenantId,
        environmentId,
        type: input.type,
        label: input.label,
        serverUrl: input.serverUrl,
        authMode: input.authMode,
        scopes: input.scopes ?? [],
      },
    });
    if (input.token) {
      // The secret lives in the SAME env as the connection, so resolvers can read it back off the
      // connection row's own environmentId without the run needing to thread its env.
      await this.store.put(
        tenantId,
        environmentId,
        connectionSecretKey(row.id),
        input.token,
      );
    }
    return toView(row);
  }

  async list(
    tenantId: string,
    environmentId: string,
  ): Promise<ConnectionView[]> {
    const rows = await getPrisma().connection.findMany({
      where: { tenantId, environmentId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(toView);
  }

  async remove(tenantId: string, id: string): Promise<void> {
    // The secret key `conn:<id>` is globally unique (a connection id can't collide across envs), so
    // purge it env-agnostically — no need to read the connection first, and it still cleans up even
    // if the connection row is already gone (no orphaned `conn:<id>` secret rows).
    await this.store.removeAllEnvs(tenantId, connectionSecretKey(id));
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

  /**
   * Persist a resolved serverUrl on the connection. Used by the Atlassian 3LO
   * callback to point the connection at its cloud-derived API base
   * (`https://api.atlassian.com/ex/jira/<cloudId>`) once consent resolves the site.
   * Tenant-scoped updateMany (Arch§3.7), same as {@link setStatus}. The value is a
   * public API host — never a secret.
   */
  async setServerUrl(
    tenantId: string,
    id: string,
    serverUrl: string,
  ): Promise<void> {
    await getPrisma().connection.updateMany({
      where: { id, tenantId },
      data: { serverUrl },
    });
  }

  /**
   * Map of connectionId → the last 4 chars of its stored credential (#471), for the Integrations
   * screen's "which key is this?" hint. Env-scoped. The secret is decrypted in memory here and only
   * the last-4 (a non-secret display fragment) ever leaves — the full token is NEVER returned or
   * logged (mirrors the ConnectionView "no token" invariant). `null` for non-bearer / tokenless /
   * short secrets, and — fail-safe — for any row whose secret can't be decrypted (a corrupt/rotated
   * ciphertext must not 500 the whole list). Decrypts run in parallel across the (small) connection
   * set.
   */
  async credentialLast4Map(
    tenantId: string,
    environmentId: string,
  ): Promise<Record<string, string | null>> {
    const rows = await getPrisma().connection.findMany({
      where: { tenantId, environmentId },
      select: { id: true, authMode: true },
    });
    const out: Record<string, string | null> = {};
    await Promise.all(
      rows.map(async (r) => {
        // Skip the decrypt entirely for non-raw-token modes (DB/SMTP connection strings, and
        // oauth/github_app which store a JSON grant blob rather than a bearer token).
        if (!BEARER_AUTH_MODES.has(r.authMode)) {
          out[r.id] = null;
          return;
        }
        try {
          const secret = await this.store.get(
            tenantId,
            environmentId,
            connectionSecretKey(r.id),
          );
          out[r.id] = credentialLast4(r.authMode, secret);
        } catch {
          out[r.id] = null; // undecryptable → no hint, never a hard failure
        }
      }),
    );
    return out;
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
    select: { type: true, environmentId: true },
  });
  if (!conn) throw new Error(`Unknown connection '${connectionId}'`);
  if (!DB_ENGINES.has(conn.type)) {
    throw new Error(
      `Connection '${connectionId}' is not a SQL database connection`,
    );
  }
  // The secret is stored in the connection's OWN env — read it there (§Slice 5).
  const dsn = await store.get(
    tenantId,
    conn.environmentId,
    connectionSecretKey(connectionId),
  );
  if (!dsn) throw new MissingConnectionTokenError(connectionId);
  return { engine: conn.type as DbEngine, dsn };
}

/**
 * A Kafka connection's broker list + credentials (#1086 slice 1).
 *
 * Stored as ONE encrypted JSON blob under the connection's secret, the same shape Firestore uses
 * for its service-account JSON. Kafka has no standard DSN — brokers, SASL mechanism, username,
 * password and TLS are independent knobs — so inventing a URL format here would be a parser we
 * would then have to keep bug-compatible with ourselves forever.
 */
export interface KafkaConnectionConfig {
  /** `host:port` list. At least one; the client discovers the rest of the cluster. */
  brokers: string[];
  ssl?: boolean;
  sasl?: {
    mechanism: "plain" | "scram-sha-256" | "scram-sha-512";
    username: string;
    password: string;
  };
  /** Sent to the broker for quota/logging attribution. */
  clientId?: string;
}

/**
 * Resolve a `kafka` connection's brokers + credentials. Same shape and invariants as
 * {@link resolveDbConnection}: read here, used IN-ACTIVITY only, never returned to a caller
 * boundary, never logged, never in workflow history (Tier-1 §4).
 */
export async function resolveKafkaConnection(
  tenantId: string,
  connectionId: string,
  store: SecretStore = new SecretStore(),
): Promise<KafkaConnectionConfig> {
  const conn = await getPrisma().connection.findFirst({
    where: { id: connectionId, tenantId },
    select: { type: true, environmentId: true },
  });
  if (!conn) throw new Error(`Unknown connection '${connectionId}'`);
  if (conn.type !== "kafka") {
    throw new Error(`Connection '${connectionId}' is not a Kafka connection`);
  }
  const raw = await store.get(
    tenantId,
    conn.environmentId,
    connectionSecretKey(connectionId),
  );
  if (!raw) throw new MissingConnectionTokenError(connectionId);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Deliberately does not echo `raw` — it is the credential. The operator knows which
    // connection they just saved; they do not need it read back to them to fix the JSON.
    throw new Error(
      `Connection '${connectionId}' has a malformed Kafka configuration (expected JSON).`,
    );
  }
  const cfg = parsed as KafkaConnectionConfig;
  if (!Array.isArray(cfg?.brokers) || cfg.brokers.length === 0) {
    throw new Error(
      `Connection '${connectionId}' has no Kafka brokers configured.`,
    );
  }
  // Validate the ENTRIES, not just the array. `{"brokers":[1]}` passes an Array check and then
  // dies deep in the activity with `broker.trim is not a function` — an error that names neither
  // the connection nor the real problem. Fail here, where we can say which.
  if (cfg.brokers.some((b) => typeof b !== "string" || b.trim() === "")) {
    throw new Error(
      `Connection '${connectionId}' has an invalid Kafka broker entry (each must be a non-empty "host:port" string).`,
    );
  }
  return cfg;
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
    select: { type: true, environmentId: true },
  });
  if (!conn) throw new Error(`Unknown connection '${connectionId}'`);
  if (conn.type !== "signing") {
    throw new Error(`Connection '${connectionId}' is not a signing connection`);
  }
  const key = await store.get(
    tenantId,
    conn.environmentId,
    connectionSecretKey(connectionId),
  );
  if (!key) throw new MissingConnectionTokenError(connectionId);
  return key;
}

/**
 * Resolve an `smtp` connection's secret SMTP URI (e.g. `smtps://user:pass@host:465`)
 * for the sendEmail node. Same shape + invariants as {@link resolveDbConnection}:
 * the URI (with credentials) is read here and used in-activity only — NEVER returned
 * to a caller boundary, logged, or put in workflow history.
 */
export async function resolveSmtpUri(
  tenantId: string,
  connectionId: string,
  store: SecretStore = new SecretStore(),
): Promise<string> {
  const conn = await getPrisma().connection.findFirst({
    where: { id: connectionId, tenantId },
    select: { type: true, environmentId: true },
  });
  if (!conn) throw new Error(`Unknown connection '${connectionId}'`);
  if (conn.type !== "smtp") {
    throw new Error(`Connection '${connectionId}' is not an smtp connection`);
  }
  const uri = await store.get(
    tenantId,
    conn.environmentId,
    connectionSecretKey(connectionId),
  );
  if (!uri) throw new MissingConnectionTokenError(connectionId);
  return uri;
}
