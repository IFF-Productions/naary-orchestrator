import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type AuthDeps, resolveAuthHeader } from "./auth";
import { ConnectionService } from "./connection.service";
import { assertEgressAllowed } from "./egress";
import { safeFetch } from "./safe-fetch";

export interface McpCallInput {
  serverUrl: string;
  headers: Record<string, string>;
  tool: string;
  arguments: Record<string, unknown>;
}

export interface McpCallResult {
  content: unknown;
  isError: boolean;
}

/**
 * Open an MCP client over Streamable HTTP to `serverUrl`, invoke one tool, and
 * close. Auth rides in the transport's requestInit headers (never logged). The
 * client is always closed (finally) to avoid leaking the connection.
 */
export async function callMcpTool(input: McpCallInput): Promise<McpCallResult> {
  // SSRF guard at the egress point (defeats DNS rebinding): https + public host
  // only, before the tenant's bearer token is sent anywhere.
  const url = await assertEgressAllowed(input.serverUrl);
  const client = new Client(
    { name: "naary-orchestrator", version: "0.1.0" },
    { capabilities: {} },
  );
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: input.headers },
    // #592: the pre-check above validates only the FIRST hop; the SDK otherwise uses
    // global fetch, which re-resolves DNS (rebinding TOCTOU) and follows redirects
    // unchecked. Route every transport request through the pinning safeFetch dispatcher
    // so a mid-session rebind/redirect to a private IP is blocked with the token unsent.
    fetch: ((fetchUrl: unknown, init?: unknown) =>
      safeFetch(String(fetchUrl), init as never)) as unknown as typeof fetch,
  });
  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: input.tool,
      arguments: input.arguments,
    });
    return { content: result.content, isError: result.isError === true };
  } finally {
    await client.close();
  }
}

/** Resolve a connection to its MCP target (server URL + auth header). */
export async function resolveMcpTarget(
  tenantId: string,
  connectionId: string,
  deps: AuthDeps = {},
): Promise<{ serverUrl: string; headers: Record<string, string> }> {
  const connections = deps.connections ?? new ConnectionService();
  const conn = await connections.getById(tenantId, connectionId);
  if (!conn) {
    throw new Error(`Unknown connection '${connectionId}'`);
  }
  const headers = await resolveAuthHeader(tenantId, connectionId, {
    ...deps,
    connections,
  });
  return { serverUrl: conn.serverUrl, headers };
}
