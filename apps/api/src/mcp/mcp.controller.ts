import type { IncomingMessage, ServerResponse } from "node:http";
import { All, Controller, Req, Res } from "@nestjs/common";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ApiTokenService } from "../auth/api-token.service";
import { Public } from "../auth/public.decorator";
import { buildMcpServer } from "./mcp.server";

/** Nest/Express parses the JSON body onto the request; the transport wants that parsed value. */
type McpRequest = IncomingMessage & { body?: unknown };

/** A JSON-RPC 2.0 error envelope (what MCP speaks) for failures before the transport runs. */
function rpcError(
  status: number,
  code: number,
  message: string,
  res: ServerResponse,
): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(
    JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }),
  );
}

/**
 * The naary MCP server endpoint (design §3). Mounted OUTSIDE the global bearer AuthGuard
 * (`@Public()`) because MCP auth is handled here: an `Authorization: Bearer nry_…` token is
 * verified with the SAME ApiTokenService the guard uses, yielding the session's tenantId — the
 * one and only tenant scope for every tool call.
 *
 * Stateless (sessionIdGenerator: undefined): a fresh server + transport per POST, closed when
 * the response ends. The read-only tools need no server→client stream or session state, so GET
 * (SSE) / DELETE (session close) are 405 for now — a later slice enables them for streaming.
 *
 * Params are typed as Node's IncomingMessage/ServerResponse (what the SDK transport expects);
 * the Express objects Nest passes at runtime extend them.
 */
@Controller("mcp")
export class McpController {
  constructor(private readonly tokens: ApiTokenService) {}

  @Public()
  @All()
  async handle(
    @Req() req: McpRequest,
    @Res() res: ServerResponse,
  ): Promise<void> {
    if (req.method !== "POST") {
      rpcError(
        405,
        -32000,
        "Method not allowed — this MCP server is POST-only for now.",
        res,
      );
      return;
    }

    const tenantId = await this.authenticate(req);
    if (!tenantId) {
      rpcError(
        401,
        -32001,
        "Unauthorized — send Authorization: Bearer nry_… (an naary API token).",
        res,
      );
      return;
    }

    const server = buildMcpServer({ tenantId });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    // Tear down when the client disconnects — no lingering server/transport per request.
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }

  /** Resolve a `nry_` bearer token to its tenantId, or null if absent/invalid. */
  private async authenticate(req: McpRequest): Promise<string | null> {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) return null;
    return this.tokens.verify(header.slice("Bearer ".length).trim());
  }
}
