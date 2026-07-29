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

/** One tool a server advertises, as `tools/list` returns it (raw — the API sanitizes). */
export interface McpToolDescriptor {
  name: string;
  description?: string;
  /** JSON Schema for the tool's arguments. Servers are supposed to send an object schema. */
  inputSchema?: Record<string, unknown>;
}

/** Hard ceilings on a `tools/list` walk. A remote server controls both the page count and the page
 *  size, so an unbounded cursor loop is a remote-controlled loop in our own process. */
const MAX_TOOL_PAGES = 10;
const MAX_TOOLS = 500;

/**
 * Open an MCP client over Streamable HTTP to `serverUrl`, run `fn`, and close.
 *
 * Every MCP session in this repo goes through here so the egress hardening cannot drift between
 * the calls that use it: the SSRF pre-check runs before the tenant's bearer token is sent
 * anywhere, the transport's fetch is pinned, and the client is always closed.
 */
async function withMcpSession<T>(
  serverUrl: string,
  headers: Record<string, string>,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  // SSRF guard at the egress point (defeats DNS rebinding): https + public host
  // only, before the tenant's bearer token is sent anywhere.
  const url = await assertEgressAllowed(serverUrl);
  const client = new Client(
    { name: "naary-orchestrator", version: "0.1.0" },
    { capabilities: {} },
  );
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers },
    // #592: the pre-check above validates only the FIRST hop; the SDK otherwise uses
    // global fetch, which re-resolves DNS (rebinding TOCTOU) and follows redirects
    // unchecked. Route every transport request through the pinning safeFetch dispatcher
    // so a mid-session rebind/redirect to a private IP is blocked with the token unsent.
    fetch: ((fetchUrl: unknown, init?: unknown) =>
      safeFetch(String(fetchUrl), init as never)) as unknown as typeof fetch,
  });
  try {
    await client.connect(transport);
    return await fn(client);
  } finally {
    await client.close();
  }
}

/** Invoke one tool over a fresh MCP session. Auth rides in the transport headers (never logged). */
export async function callMcpTool(input: McpCallInput): Promise<McpCallResult> {
  return withMcpSession(input.serverUrl, input.headers, async (client) => {
    const result = await client.callTool({
      name: input.tool,
      arguments: input.arguments,
    });
    return { content: result.content, isError: result.isError === true };
  });
}

/**
 * Ask a server which tools it offers (`tools/list`), so the canvas can OFFER an author the real
 * tool names + argument names instead of asking them to retype something they cannot see. A typo
 * in either place fails at RUN time, not at save.
 *
 * Authoring-time read only — nothing here writes, and the tenant's token never leaves the session.
 * The walk is bounded (`MAX_TOOL_PAGES` / `MAX_TOOLS`): the cursor and page size are both chosen by
 * the remote server, so an unbounded loop would be a remote-controlled loop in our process.
 * Sanitizing the returned strings/schemas is the CALLER's job — this is raw remote data.
 */
export async function listMcpTools(input: {
  serverUrl: string;
  headers: Record<string, string>;
}): Promise<McpToolDescriptor[]> {
  return withMcpSession(input.serverUrl, input.headers, async (client) => {
    const out: McpToolDescriptor[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      const res = await client.listTools(cursor ? { cursor } : undefined);
      for (const t of res.tools ?? []) {
        out.push({
          name: t.name,
          ...(t.description ? { description: t.description } : {}),
          ...(t.inputSchema
            ? { inputSchema: t.inputSchema as Record<string, unknown> }
            : {}),
        });
        if (out.length >= MAX_TOOLS) return out;
      }
      const next = (res as { nextCursor?: unknown }).nextCursor;
      if (typeof next !== "string" || !next) break;
      cursor = next;
    }
    return out;
  });
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
