import { temporalConnectionConfig } from "@naary/temporal-config";
import { Client, Connection } from "@temporalio/client";

/**
 * Factory for a connected Temporal Client (used by the NestJS control plane).
 * Returns the connection too so the caller can close it on shutdown — connect
 * once at boot, not per request.
 *
 * Connection options come from env (TLS / API-key / namespace), defaulting to the
 * local dev server — so Temporal Cloud needs only env, no code change. See
 * @naary/temporal-config.
 */
export async function connectTemporal(): Promise<{
  client: Client;
  connection: Connection;
}> {
  const { address, namespace, tls, apiKey, metadata } =
    temporalConnectionConfig();
  const connection = await Connection.connect({
    address,
    tls,
    apiKey,
    metadata,
  });
  return { client: new Client({ connection, namespace }), connection };
}
