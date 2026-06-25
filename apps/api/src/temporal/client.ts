import { Client, Connection } from "@temporalio/client";

/**
 * Factory for a connected Temporal Client (used by the NestJS control plane).
 * Returns the connection too so the caller can close it on shutdown — connect
 * once at boot, not per request.
 */
export async function connectTemporal(): Promise<{
  client: Client;
  connection: Connection;
}> {
  const address = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
  const connection = await Connection.connect({ address });
  return { client: new Client({ connection }), connection };
}
