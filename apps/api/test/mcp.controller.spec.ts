import type { ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A fake StreamableHTTPServerTransport that models just enough of the SDK's session lifecycle to
// prove the controller's routing: the first POST (an `initialize`) mints a session id and fires
// onsessioninitialized; a DELETE fires onclose (session terminate); every call is recorded so a
// test can assert a request WAS or (for a rejected foreign session) WAS NOT dispatched to it.
// Defined via vi.hoisted so the class exists before the hoisted vi.mock factory references it.
const { createdTransports, FakeTransport, buildMcpServer, harness } =
  vi.hoisted(() => {
    const created: FakeTransportInstance[] = [];
    // `rejectInitialize` models the SDK REFUSING a malformed initialize: it answers the request
    // but never mints a session id, so `onsessioninitialized` never fires. Routing now lets such
    // a request reach openSession (#1063), which makes cleanup the controller's job.
    const harness = { rejectInitialize: false };
    interface FakeTransportInstance {
      sessionId: string | undefined;
      onclose: (() => void) | undefined;
      closed: boolean;
      handled: { method: string; sessionId?: string }[];
    }
    class FakeTransport {
      public sessionId: string | undefined;
      public onclose: (() => void) | undefined;
      public closed = false;
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
        // First POST for this transport == the initialize that opens the session, UNLESS the
        // harness is modelling an initialize the SDK rejects (no session id is ever minted).
        if (
          method === "POST" &&
          !this.sessionId &&
          !harness.rejectInitialize &&
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
        this.closed = true;
        this.onclose?.();
      }
    }
    return {
      createdTransports: created,
      FakeTransport,
      harness,
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
  const graphs = {
    list: vi.fn(async () => []),
    listMcpExposed: vi.fn(async () => []),
  };
  const executions = {};
  const generator = {};
  const environments = { defaultEnvId: vi.fn(async () => "env-1") };
  const permissions = { isTenantEnforced: vi.fn(async () => false) };

  beforeEach(() => {
    createdTransports.length = 0;
    harness.rejectInitialize = false;
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

  // #1063 — a real client could not connect at all: "Version negotiation probe failed".
  //
  // The gate was the SDK's `isInitializeRequest`, which is not a method check but a STRICT
  // full-schema parse requiring params.protocolVersion AND params.capabilities AND
  // params.clientInfo{name,version}. A version-negotiation probe is minimal by design, so it
  // failed that parse and we answered "send an `initialize` request first" — advice that is a
  // no-op, because the client had just sent one. Routing must key on the METHOD; strict
  // validation belongs to the SDK transport, which answers a malformed initialize with a
  // spec-compliant error naming the missing field.
  it.each([
    ["only protocolVersion (the probe)", { protocolVersion: "2025-06-18" }],
    ["no clientInfo", { protocolVersion: "2025-06-18", capabilities: {} }],
    [
      "clientInfo without a version",
      {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "probe" },
      },
    ],
    ["no params at all", undefined],
  ])("opens a session for an initialize with %s", async (_label, params) => {
    const res = new FakeRes();
    await controller.handle(
      req("POST", {
        body: {
          jsonrpc: "2.0",
          id: 0,
          method: "initialize",
          ...(params ? { params } : {}),
        },
      }) as never,
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers["mcp-session-id"]).toBeTruthy();
    expect(createdTransports).toHaveLength(1);
  });

  it("routes a JSON-RPC batch containing an initialize", async () => {
    // Batching is legal in protocol 2025-03-26 (dropped in 2025-06-18), and a batched
    // initialize is still an initialize as far as ROUTING is concerned.
    const res = new FakeRes();
    await controller.handle(
      req("POST", {
        body: [{ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }],
      }) as never,
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(200);
    expect(createdTransports).toHaveLength(1);
  });

  it("closes the transport + server when the SDK REJECTS the initialize (no session leak)", async () => {
    // Routing now admits a malformed initialize so the SDK can name the bad field — which means
    // a client retrying a bad handshake would otherwise allocate a server per attempt, because
    // `onsessioninitialized` never fires and the onclose teardown is never wired to anything.
    harness.rejectInitialize = true;
    const res = new FakeRes();
    await controller.handle(
      req("POST", {
        body: { jsonrpc: "2.0", id: 0, method: "initialize", params: {} },
      }) as never,
      res as unknown as ServerResponse,
    );
    expect(createdTransports).toHaveLength(1);
    expect(createdTransports[0].sessionId).toBeUndefined();
    expect(createdTransports[0].closed).toBe(true);
    const server = buildMcpServer.mock.results[0].value as {
      close: ReturnType<typeof vi.fn>;
    };
    expect(server.close).toHaveBeenCalled();
  });

  it("the session-less non-initialize error is spec-shaped: echoes the id, Invalid Request", async () => {
    // `id: null` is uncorrelatable, and -32000 is a server-defined code for what is squarely
    // JSON-RPC Invalid Request. Both are why the client could only report an opaque failure.
    const res = new FakeRes();
    await controller.handle(
      req("POST", {
        body: { jsonrpc: "2.0", id: 7, method: "tools/list" },
      }) as never,
      res as unknown as ServerResponse,
    );
    const body = JSON.parse(res.body) as {
      id: unknown;
      error: { code: number };
    };
    expect(body.id).toBe(7);
    expect(body.error.code).toBe(-32600);
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
