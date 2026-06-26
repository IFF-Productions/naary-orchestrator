import { type Connection, getPrisma } from "@naary/db";
import { SecretStore } from "@naary/secrets";

export type ConnectionType = "github" | "atlassian" | "custom";
export type AuthMode = "api_token" | "pat" | "oauth";
export type ConnectionStatus = "connected" | "needs_reauth" | "error";

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
