import type { ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

/**
 * The two describes below are the STATEFUL contract, which #1065 moved behind
 * `MCP_SESSION_MODE=stateful`. They are pinned to it rather than rewritten: stateless is the
 * default now, but stateful is the documented recovery lever if a real MCP client turns out to
 * require the GET stream — and a lever with no tests is not a lever.
 */
function useStatefulMode(): void {
  const prev = process.env.MCP_SESSION_MODE;
  beforeEach(() => {
    process.env.MCP_SESSION_MODE = "stateful";
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.MCP_SESSION_MODE;
    else process.env.MCP_SESSION_MODE = prev;
  });
}

describe("McpController — Streamable HTTP session lifecycle (#469)", () => {
  useStatefulMode();
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

  it("a rejected BATCH echoes no id — one error cannot speak for N messages", async () => {
    // Echoing the first element's id would report "message #1 failed" when the rejection is
    // about the batch as a whole. null is what JSON-RPC reserves for an undeterminable id.
    const res = new FakeRes();
    await controller.handle(
      req("POST", {
        body: [
          { jsonrpc: "2.0", id: 11, method: "tools/list" },
          { jsonrpc: "2.0", id: 12, method: "tools/call" },
        ],
      }) as never,
      res as unknown as ServerResponse,
    );
    const body = JSON.parse(res.body) as { id: unknown };
    expect(body.id).toBeNull();
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

/**
 * Idle sweep + the truthful 404 (#1065).
 *
 * Before this, ONLY an explicit DELETE evicted a session: a client that simply went away left its
 * map entry AND its built `McpServer` alive until the process exited, and a user coming back to an
 * abandoned session got a bare "Unknown MCP session" with no way to tell a timeout from a bug.
 *
 * Fake timers drive both halves — `vi.useFakeTimers()` controls `Date.now()` (what `lastSeenAt` is
 * measured against) and `setInterval` (the janitor), so these assert the real clock arithmetic
 * rather than a seam invented for the test.
 *
 * NOT covered here, deliberately: the multi-instance half of #1065 (a session minted on one API
 * container and answered by another during `docker rollout`). That needs a shared store, and no
 * single-process test can stand in for it.
 */
describe("McpController — idle sessions are swept, and the 404 says why (#1065)", () => {
  useStatefulMode();
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
  const environments = { defaultEnvId: vi.fn(async () => "env-1") };
  const permissions = { isTenantEnforced: vi.fn(async () => false) };

  const IDLE_MS = 30 * 60_000;
  let controller: McpController;

  beforeEach(() => {
    vi.useFakeTimers();
    createdTransports.length = 0;
    harness.rejectInitialize = false;
    buildMcpServer.mockClear();
    controller = new McpController(
      tokens as never,
      graphs as never,
      {} as never,
      {} as never,
      environments as never,
      permissions as never,
    );
  });

  afterEach(() => {
    controller.onModuleDestroy();
    vi.useRealTimers();
  });

  async function initSession(token = "nry_a"): Promise<string> {
    const res = new FakeRes();
    await controller.handle(
      req("POST", { token, body: INIT_BODY }) as never,
      res as unknown as ServerResponse,
    );
    return res.headers["mcp-session-id"];
  }

  /** Send a request on an existing session id and return the response. */
  async function onSession(sid: string, token = "nry_a"): Promise<FakeRes> {
    const res = new FakeRes();
    await controller.handle(
      req("POST", {
        token,
        sessionId: sid,
        body: { jsonrpc: "2.0", id: 2, method: "tools/list" },
      }) as never,
      res as unknown as ServerResponse,
    );
    return res;
  }

  it("closes a session left untouched past the idle window — the leak, not just the map entry", async () => {
    const sid = await initSession();
    const transport = createdTransports[0];
    expect(transport.closed).toBe(false);

    await vi.advanceTimersByTimeAsync(IDLE_MS + 61_000);

    // The TRANSPORT is closed, which is what releases the built server — deleting the map entry
    // alone would have left the McpServer alive, i.e. fixed the symptom and kept the leak.
    expect(transport.closed).toBe(true);
    const res = await onSession(sid);
    expect(res.statusCode).toBe(404);
  });

  it("does NOT sweep a session that is still being used", async () => {
    const sid = await initSession();
    const transport = createdTransports[0];

    // Two thirds of the window, a request, then two thirds again: never idle for a full window,
    // though the session is now older than one. Age must not be the criterion.
    await vi.advanceTimersByTimeAsync((IDLE_MS * 2) / 3);
    expect((await onSession(sid)).statusCode).not.toBe(404);
    await vi.advanceTimersByTimeAsync((IDLE_MS * 2) / 3);

    expect(transport.closed).toBe(false);
    expect((await onSession(sid)).statusCode).not.toBe(404);
  });

  it("tells the OWNER its session expired, instead of a bare 'unknown'", async () => {
    const sid = await initSession("nry_a");
    await vi.advanceTimersByTimeAsync(IDLE_MS + 61_000);

    const res = await onSession(sid, "nry_a");
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain("expired");
    expect(res.body).toContain("30 minutes idle");
    expect(res.body).toContain("Re-initialize");
  });

  it("does NOT tell ANOTHER tenant that the id ever existed — the message must not become an oracle", async () => {
    const sid = await initSession("nry_a");
    await vi.advanceTimersByTimeAsync(IDLE_MS + 61_000);

    const foreign = await onSession(sid, "nry_b");
    const madeUp = await onSession(
      "00000000-0000-4000-8000-000000000000",
      "nry_b",
    );

    // Same status AND same prose: a stranger cannot distinguish a real expired id from one they
    // invented, which is the property the flat 404 exists to hold.
    expect(foreign.statusCode).toBe(404);
    expect(madeUp.statusCode).toBe(404);
    expect(foreign.body).toBe(madeUp.body);
    expect(foreign.body).not.toContain("expired after");
  });

  it("an id that never existed still names the causes a user can act on", async () => {
    const res = await onSession("00000000-0000-4000-8000-000000000000");
    expect(res.statusCode).toBe(404);
    // The deploy case is the one we can never observe (the process that held it is gone), so the
    // generic message has to name it rather than claim knowledge it doesn't have.
    expect(res.body).toContain("redeployed");
    expect(res.body).toContain("Re-initialize");
  });

  it("onModuleDestroy stops the janitor so a shutting-down process can exit", async () => {
    await initSession();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    controller.onModuleDestroy();
    expect(vi.getTimerCount()).toBe(0);
  });
});

/**
 * STATELESS mode — the default since #1065.
 *
 * The multi-instance problem it solves cannot be reproduced in a single-process test (it needs two
 * API containers and a rollout). What IS testable, and what these assert, is the property that
 * makes it survive one: **no request depends on state left by a previous request**. If that holds
 * in-process, it holds across containers, because there is nothing to be missing.
 */
describe("McpController — stateless mode (#1065, the default)", () => {
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
  const environments = { defaultEnvId: vi.fn(async () => "env-1") };
  const permissions = { isTenantEnforced: vi.fn(async () => false) };
  let controller: McpController;

  beforeEach(() => {
    delete process.env.MCP_SESSION_MODE; // unset ⇒ stateless, i.e. the shipped default
    createdTransports.length = 0;
    harness.rejectInitialize = false;
    buildMcpServer.mockClear();
    graphs.listMcpExposed.mockClear();
    controller = new McpController(
      tokens as never,
      graphs as never,
      {} as never,
      {} as never,
      environments as never,
      permissions as never,
    );
  });

  const post = async (body: unknown, opts: { sessionId?: string } = {}) => {
    const res = new FakeRes();
    await controller.handle(
      req("POST", { body, ...opts }) as never,
      res as unknown as ServerResponse,
    );
    return res;
  };

  it("answers an initialize WITHOUT minting a session id — there is no session to hand out", async () => {
    const res = await post(INIT_BODY);
    expect(res.statusCode).toBe(200);
    expect(res.headers["mcp-session-id"]).toBeUndefined();
  });

  it("accepts a tool call with NO session id — the 400 'initialize first' gate is gone", async () => {
    // This is the property that makes a rollout survivable: request two does not need request
    // one's state, so it does not matter which container answers it.
    const res = await post({ jsonrpc: "2.0", id: 7, method: "tools/list" });
    expect(res.statusCode).toBe(200);
  });

  it("ignores a stale mcp-session-id instead of 404ing it", async () => {
    // A client that previously spoke to a STATEFUL deployment keeps sending its old id. Rejecting
    // it would reproduce the exact 404 this mode exists to eliminate.
    const res = await post(
      { jsonrpc: "2.0", id: 8, method: "tools/list" },
      { sessionId: "00000000-0000-4000-8000-000000000000" },
    );
    expect(res.statusCode).toBe(200);
  });

  it("builds a FRESH transport and server per request, and closes both", async () => {
    await post(INIT_BODY);
    await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });

    // Reuse is not an option: the SDK throws "Stateless transport cannot be reused across
    // requests" because message ids would collide between concurrent clients.
    expect(createdTransports).toHaveLength(2);
    expect(buildMcpServer).toHaveBeenCalledTimes(2);
    // …and per-request construction must come with per-request teardown, or "no session leak"
    // becomes a per-REQUEST leak, which is strictly worse.
    expect(createdTransports.every((t) => t.closed)).toBe(true);
  });

  it("rebuilds the tool list per request — a newly opted-in workflow needs no reconnect", async () => {
    await post(INIT_BODY);
    await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    // The documented COST of this mode (a query per call) and its documented benefit (no stale
    // tool list) are the same fact; assert it once so neither can be quietly dropped.
    expect(graphs.listMcpExposed).toHaveBeenCalledTimes(2);
  });

  it("refuses GET with a message naming the mode, not a bare 405", async () => {
    const res = new FakeRes();
    await controller.handle(
      req("GET") as never,
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(405);
    expect(res.body).toContain("stateless");
    expect(res.body).toContain("POST");
  });

  it("treats DELETE as a no-op success — a client's disconnect cleanup must not report failure", async () => {
    const res = new FakeRes();
    await controller.handle(
      req("DELETE", { sessionId: "whatever" }) as never,
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(204);
  });

  it("still authenticates: no token is 401, never an anonymous server", async () => {
    const res = new FakeRes();
    await controller.handle(
      req("POST", { token: null, body: INIT_BODY }) as never,
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(401);
    expect(buildMcpServer).not.toHaveBeenCalled();
  });

  it("scopes each request to ITS OWN token's tenant", async () => {
    await post(INIT_BODY);
    const res = new FakeRes();
    await controller.handle(
      req("POST", { token: "nry_b", body: INIT_BODY }) as never,
      res as unknown as ServerResponse,
    );
    // Losing sessions must not lose tenant scoping — the server is rebuilt per request, so the
    // tenant comes from the token on THAT request.
    // The hoisted mock is declared argument-less (the controller only needs {connect, close}),
    // so its recorded calls type as an empty tuple — assert the shape we actually pass.
    const calls = buildMcpServer.mock.calls as unknown as [
      { tenantId: string },
    ][];
    const tenants = calls.map((c) => c[0].tenantId);
    expect(tenants).toEqual(["tenant-A", "tenant-B"]);
  });
});
