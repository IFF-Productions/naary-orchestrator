import type { ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A fake StreamableHTTPServerTransport that models just enough of the SDK's session lifecycle to
// prove the controller's routing: the first POST (an `initialize`) mints a session id and fires
// onsessioninitialized; a DELETE fires onclose (session terminate); every call is recorded so a
// test can assert a request WAS or (for a rejected foreign session) WAS NOT dispatched to it.
// Defined via vi.hoisted so the class exists before the hoisted vi.mock factory references it.
const { createdTransports, FakeTransport, buildMcpServer } = vi.hoisted(() => {
  const created: FakeTransportInstance[] = [];
  interface FakeTransportInstance {
    sessionId: string | undefined;
    onclose: (() => void) | undefined;
    handled: { method: string; sessionId?: string }[];
  }
  class FakeTransport {
    public sessionId: string | undefined;
    public onclose: (() => void) | undefined;
    public readonly handled: { method: string; sessionId?: string }[] = [];

    constructor(
      private readonly opts: {
        sessionIdGenerator?: () => string;
        onsessioninitialized?: (sid: string) => void | Promise<void>;
      },
    ) {
      created.push(this);
    }

    async handleRequest(
      req: { method?: string; headers: Record<string, unknown> },
      res: {
        setHeader: (k: string, v: string) => void;
        writeHead: (s: number, h?: Record<string, string>) => unknown;
        end: (c?: string) => void;
      },
      _body?: unknown,
    ): Promise<void> {
      const method = req.method ?? "";
      this.handled.push({
        method,
        sessionId: req.headers["mcp-session-id"] as string | undefined,
      });
      // First POST for this transport == the initialize that opens the session.
      if (
        method === "POST" &&
        !this.sessionId &&
        this.opts.sessionIdGenerator
      ) {
        this.sessionId = this.opts.sessionIdGenerator();
        await this.opts.onsessioninitialized?.(this.sessionId);
        res.setHeader("mcp-session-id", this.sessionId);
      }
      if (method === "DELETE") {
        // The SDK terminates the session on DELETE and fires onclose.
        this.onclose?.();
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    }

    async close(): Promise<void> {
      this.onclose?.();
    }
  }
  return {
    createdTransports: created,
    FakeTransport,
    // The real server build pulls in @naary/dsl etc.; the controller only needs { connect, close }.
    buildMcpServer: vi.fn(() => ({ connect: vi.fn(), close: vi.fn() })),
  };
});

vi.mock("@modelcontextprotocol/sdk/server/streamableHttp.js", () => ({
  StreamableHTTPServerTransport: FakeTransport,
}));
vi.mock("../src/mcp/mcp.server", () => ({ buildMcpServer }));

import { McpController } from "../src/mcp/mcp.controller";

// A minimal ServerResponse stand-in capturing status + headers the controller writes directly.
class FakeRes {
  public statusCode = 0;
  public headers: Record<string, string> = {};
  public body = "";
  public ended = false;
  setHeader(k: string, v: string) {
    this.headers[k.toLowerCase()] = v;
  }
  writeHead(status: number, headers?: Record<string, string>) {
    this.statusCode = status;
    if (headers)
      for (const [k, v] of Object.entries(headers))
        this.headers[k.toLowerCase()] = v;
    return this;
  }
  end(chunk?: string) {
    if (chunk) this.body += chunk;
    this.ended = true;
  }
}

const INIT_BODY = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0.0" },
  },
};

type Req = {
  method: string;
  headers: Record<string, unknown>;
  body?: unknown;
};

const req = (
  method: string,
  {
    token = "nry_a",
    sessionId,
    body,
  }: { token?: string | null; sessionId?: string; body?: unknown } = {},
): Req => ({
  method,
  headers: {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
  },
  body,
});

describe("McpController — Streamable HTTP session lifecycle (#469)", () => {
  let controller: McpController;
  // Map every nry_ token → its tenant so we can drive two tenants.
  const tokenTenant: Record<string, string> = {
    nry_a: "tenant-A",
    nry_b: "tenant-B",
  };

  const tokens = {
    verify: vi.fn(async (t: string) =>
      tokenTenant[t]
        ? { id: `id-${t}`, tenantId: tokenTenant[t], environmentId: null }
        : null,
    ),
  };
  const graphs = { list: vi.fn(async () => []) };
  const executions = {};
  const generator = {};
  const environments = { defaultEnvId: vi.fn(async () => "env-1") };
  const permissions = { isTenantEnforced: vi.fn(async () => false) };

  beforeEach(() => {
    createdTransports.length = 0;
    buildMcpServer.mockClear();
    controller = new McpController(
      tokens as never,
      graphs as never,
      executions as never,
      generator as never,
      environments as never,
      permissions as never,
    );
  });

  // Drive an initialize POST and return the minted session id.
  async function initSession(token = "nry_a"): Promise<string> {
    const res = new FakeRes();
    await controller.handle(
      req("POST", { token, body: INIT_BODY }) as never,
      res as unknown as ServerResponse,
    );
    const sid = res.headers["mcp-session-id"];
    expect(sid).toBeTruthy();
    return sid;
  }

  it("POST initialize opens a session (not 405) and builds the tenant-scoped server once", async () => {
    const res = new FakeRes();
    await controller.handle(
      req("POST", { body: INIT_BODY }) as never,
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers["mcp-session-id"]).toBeTruthy();
    expect(buildMcpServer).toHaveBeenCalledTimes(1);
    expect(createdTransports).toHaveLength(1);
  });

  it("GET with the session id streams (not 405) — dispatched to the SAME transport", async () => {
    const sid = await initSession();
    const transport = createdTransports[0];

    const res = new FakeRes();
    await controller.handle(
      req("GET", { sessionId: sid }) as never,
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(200);
    // No new server/transport built — reused the session's.
    expect(createdTransports).toHaveLength(1);
    expect(transport.handled.map((h) => h.method)).toEqual(["POST", "GET"]);
  });

  it("DELETE with the session id closes the session (not 405) and evicts it", async () => {
    const sid = await initSession();
    const transport = createdTransports[0];

    const del = new FakeRes();
    await controller.handle(
      req("DELETE", { sessionId: sid }) as never,
      del as unknown as ServerResponse,
    );
    expect(del.statusCode).toBe(200);
    expect(transport.handled.some((h) => h.method === "DELETE")).toBe(true);

    // The session is gone — a follow-up GET on the same id is now unknown (404).
    const after = new FakeRes();
    await controller.handle(
      req("GET", { sessionId: sid }) as never,
      after as unknown as ServerResponse,
    );
    expect(after.statusCode).toBe(404);
  });

  it("GET/DELETE with an unknown session id is 404 and never dispatched", async () => {
    for (const method of ["GET", "DELETE"]) {
      const res = new FakeRes();
      await controller.handle(
        req(method, { sessionId: "does-not-exist" }) as never,
        res as unknown as ServerResponse,
      );
      expect(res.statusCode).toBe(404);
    }
    expect(createdTransports).toHaveLength(0);
  });

  it("GET/DELETE without a session id is 400", async () => {
    const res = new FakeRes();
    await controller.handle(
      req("GET") as never,
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(400);
  });

  it("a non-initialize POST without a session id is 400", async () => {
    const res = new FakeRes();
    await controller.handle(
      req("POST", {
        body: { jsonrpc: "2.0", id: 2, method: "tools/list" },
      }) as never,
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(400);
    expect(createdTransports).toHaveLength(0);
  });

  it("TENANT ISOLATION: tenant B cannot use tenant A's session id (404, never reaches A's transport)", async () => {
    const sidA = await initSession("nry_a");
    const transportA = createdTransports[0];
    const dispatchedToABefore = transportA.handled.length;

    // Tenant B presents A's session id on both GET and DELETE.
    for (const method of ["GET", "DELETE"]) {
      const res = new FakeRes();
      await controller.handle(
        req(method, { token: "nry_b", sessionId: sidA }) as never,
        res as unknown as ServerResponse,
      );
      // Indistinguishable from an unknown session — never confirm it exists.
      expect(res.statusCode).toBe(404);
    }
    // The security proof: A's transport saw NONE of B's requests.
    expect(transportA.handled.length).toBe(dispatchedToABefore);

    // And A's own session still works afterward.
    const ok = new FakeRes();
    await controller.handle(
      req("GET", { token: "nry_a", sessionId: sidA }) as never,
      ok as unknown as ServerResponse,
    );
    expect(ok.statusCode).toBe(200);
  });

  it("no bearer token is 401 on every method", async () => {
    for (const method of ["POST", "GET", "DELETE"]) {
      const res = new FakeRes();
      await controller.handle(
        req(method, { token: null, body: INIT_BODY }) as never,
        res as unknown as ServerResponse,
      );
      expect(res.statusCode).toBe(401);
    }
  });

  it("an unsupported method (PUT) is still 405", async () => {
    const res = new FakeRes();
    await controller.handle(
      req("PUT", { body: INIT_BODY }) as never,
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(405);
  });
});
