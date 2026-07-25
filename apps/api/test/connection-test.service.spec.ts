/**
 * "Test connection" (#701).
 *
 * NO REAL PROVIDER IS CALLED ANYWHERE IN THIS FILE. The happy/sad paths run against a real
 * `node:http` server started in-process on 127.0.0.1: a genuine socket, genuine request headers,
 * genuine status codes — but our own. That is what lets us assert the *exact* bytes the probe puts
 * on the wire (including the auth header scheme) without any credential.
 *
 * `assertEgressAllowed` is seam-relaxed for the loopback target (it is https-only and rejects
 * private addresses by design, which is correct in production and unusable for a local server).
 * Its real behaviour is covered by the egress specs; what this file proves is that the probe
 * (a) calls the right action, (b) sends the right headers, (c) never writes, and (d) sets
 * `Connection.status` correctly.
 */
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  INTEGRATION_PROVIDERS,
  getIntegrationAction,
  pickConnectionTestAction,
} from "@naary/dsl";
import {
  ConnectionTestService,
  __connTestDeps,
} from "../src/connections/connection-test.service";

interface Captured {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

let server: Server;
let origin = "";
let captured: Captured[] = [];
/** What the fake provider answers next. */
let reply = { status: 200, body: JSON.stringify({ ok: true }) };

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += String(c);
    });
    req.on("end", () => {
      captured.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body,
      });
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(reply.body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const getById = vi.fn();
const setStatus = vi.fn();
const svc = new ConnectionTestService({ getById, setStatus } as never);

const realDeps = { ...__connTestDeps };

beforeEach(() => {
  captured = [];
  reply = { status: 200, body: JSON.stringify({ ok: true }) };
  getById.mockReset();
  setStatus.mockReset();
  __connTestDeps.resolveAuthHeader = realDeps.resolveAuthHeader;
  __connTestDeps.assertEgressAllowed = realDeps.assertEgressAllowed;
  __connTestDeps.fetch = realDeps.fetch;
});

/** Point the probe at the local server: the SSRF guard is relaxed for this one target and every
 *  provider base URL is rewritten onto the loopback origin (path + query preserved verbatim, so
 *  the assertions still see the real catalog path). */
function useLocalProvider(token = "tok-abc123"): void {
  __connTestDeps.resolveAuthHeader = vi
    .fn()
    .mockResolvedValue({ Authorization: `Bearer ${token}` }) as never;
  __connTestDeps.assertEgressAllowed = (async (url: string) => {
    const u = new URL(url);
    return new URL(`${origin}${u.pathname}${u.search}`);
  }) as never;
  __connTestDeps.fetch = ((url: string, init: RequestInit) =>
    fetch(url, init)) as never;
}

const CONN = {
  id: "c1",
  authMode: "api_token",
  serverUrl: "https://acme.example.com",
};

describe("ConnectionTestService — a passing probe", () => {
  it("calls the catalog's zero-arg read, names it, and flips status to connected", async () => {
    useLocalProvider();
    getById.mockResolvedValue(CONN);

    const out = await svc.test("t1", "c1", "calendly");

    expect(out.ok).toBe(true);
    expect(out.status).toBe("ok");
    expect(out.httpStatus).toBe(200);
    expect(out.checkedAction).toBe("calendly.get_me");
    expect(out.connectionStatus).toBe("connected");
    // A real request reached a real socket: GET /users/me with the resolved Bearer.
    expect(captured).toHaveLength(1);
    expect(captured[0].method).toBe("GET");
    expect(captured[0].url).toBe("/users/me");
    expect(captured[0].headers.authorization).toBe("Bearer tok-abc123");
    expect(setStatus).toHaveBeenCalledWith("t1", "c1", "connected");
  });

  it("never leaks the token into the response body", async () => {
    useLocalProvider("super-secret-token");
    getById.mockResolvedValue(CONN);

    const out = await svc.test("t1", "c1", "calendly");

    expect(JSON.stringify(out)).not.toContain("super-secret-token");
  });

  it("sends the provider's custom auth header, not a Bearer (pagerduty)", async () => {
    useLocalProvider();
    getById.mockResolvedValue(CONN);

    const out = await svc.test("t1", "c1", "pagerduty");

    expect(out.checkedAction).toBe("pagerduty.list_incidents");
    // `Token token=<key>` — the scheme a wrong-header bug would break for 100% of calls.
    expect(captured[0].headers.authorization).toBe("Token token=tok-abc123");
  });

  it("HTTP-Basic-wraps an api_token connection (zendesk)", async () => {
    useLocalProvider("alice@acme.com:api-tok");
    getById.mockResolvedValue(CONN);

    const out = await svc.test("t1", "c1", "zendesk");

    expect(out.checkedAction).toBe("zendesk.list_tickets");
    expect(captured[0].headers.authorization).toBe(
      "Basic YWxpY2VAYWNtZS5jb206YXBpLXRvaw==",
    );
  });

  it("leaves an OAuth connection's token as a genuine Bearer (zendesk over oauth)", async () => {
    useLocalProvider("oauth-access");
    getById.mockResolvedValue({ ...CONN, authMode: "oauth" });

    await svc.test("t1", "c1", "zendesk");

    // The Basic re-wrap is guarded on auth mode — this is the branch that differs per mode.
    expect(captured[0].headers.authorization).toBe("Bearer oauth-access");
  });
});

describe("ConnectionTestService — a failing probe", () => {
  it("401 → ok:false with the provider's status, and flips OFF connected", async () => {
    useLocalProvider();
    getById.mockResolvedValue(CONN);
    reply = { status: 401, body: JSON.stringify({ message: "Invalid token" }) };

    const out = await svc.test("t1", "c1", "calendly");

    expect(out.ok).toBe(false);
    expect(out.status).toBe("failed");
    expect(out.httpStatus).toBe(401);
    expect(out.checkedAction).toBe("calendly.get_me");
    expect(out.connectionStatus).toBe("needs_reauth");
    expect(out.message).toContain("401");
    expect(setStatus).toHaveBeenCalledWith("t1", "c1", "needs_reauth");
  });

  it("403 → needs_reauth as well (the credential is the problem)", async () => {
    useLocalProvider();
    getById.mockResolvedValue(CONN);
    reply = { status: 403, body: "forbidden" };

    const out = await svc.test("t1", "c1", "calendly");

    expect(out.connectionStatus).toBe("needs_reauth");
  });

  it.each([404, 429, 500])(
    "%d → error, NOT needs_reauth (the token may be fine)",
    async (status) => {
      useLocalProvider();
      getById.mockResolvedValue(CONN);
      reply = { status, body: "nope" };

      const out = await svc.test("t1", "c1", "calendly");

      expect(out.ok).toBe(false);
      expect(out.httpStatus).toBe(status);
      expect(out.connectionStatus).toBe("error");
      expect(setStatus).toHaveBeenCalledWith("t1", "c1", "error");
    },
  );
});

describe("ConnectionTestService — declines to probe (`unknown`)", () => {
  it("Slack reports unknown and NEVER posts (all 3 catalog actions write)", async () => {
    useLocalProvider();
    getById.mockResolvedValue(CONN);

    const out = await svc.test("t1", "c1", "slack");

    expect(out.status).toBe("unknown");
    expect(out.ok).toBe(false);
    expect(out.checkedAction).toBeNull();
    expect(out.message).toMatch(/every slack action/i);
    // The load-bearing assertion: nothing was sent, so no scratch channel got a message.
    expect(captured).toHaveLength(0);
    // And an `unknown` learned nothing about the token, so it must not overwrite the status.
    expect(setStatus).not.toHaveBeenCalled();
    expect(out.connectionStatus).toBeNull();
  });

  it("GitHub reports unknown, naming the fields its cheapest read needs", async () => {
    useLocalProvider();
    getById.mockResolvedValue(CONN);

    const out = await svc.test("t1", "c1", "github");

    expect(out.status).toBe("unknown");
    expect(out.message).toContain("owner");
    expect(out.message).toContain("single-node Test");
    expect(captured).toHaveLength(0);
  });

  it("an unknown provider key is rejected without resolving a secret", async () => {
    const resolve = vi.fn();
    __connTestDeps.resolveAuthHeader = resolve as never;

    const out = await svc.test("t1", "c1", "not-a-provider");

    expect(out.status).toBe("unknown");
    expect(resolve).not.toHaveBeenCalled();
    expect(getById).not.toHaveBeenCalled();
  });
});

describe("ConnectionTestService — a baseUrl-less provider with no Server URL", () => {
  // Six catalog providers have no `baseUrl` and need the connection's Server URL. Only THREE of
  // them are probeable at all (deepl/shopify/zendesk have a zero-arg read); for mattermost,
  // mailchimp and jira the "no safe read" answer comes first and dominates — see below.
  it.each(["deepl", "shopify", "zendesk"])(
    "%s with an empty serverUrl gets a distinct 'set a Server URL' error, not a 404",
    async (providerKey) => {
      useLocalProvider();
      getById.mockResolvedValue({ ...CONN, serverUrl: "   " });

      const out = await svc.test("t1", "c1", providerKey);

      expect(out.ok).toBe(false);
      expect(out.httpStatus).toBeNull(); // nothing was called
      expect(captured).toHaveLength(0);
      expect(out.message).toContain("Server URL");
      // Re-authorizing cannot fix a missing URL, so this must never read as needs_reauth.
      expect(out.connectionStatus).toBe("error");
      expect(setStatus).toHaveBeenCalledWith("t1", "c1", "error");
    },
  );

  it.each(["mattermost", "mailchimp", "jira"])(
    "%s reports `unknown` first — 'no safe read' outranks a missing Server URL",
    async (providerKey) => {
      useLocalProvider();
      getById.mockResolvedValue({ ...CONN, serverUrl: "   " });

      const out = await svc.test("t1", "c1", providerKey);

      // Deliberate ordering: if we can't probe the provider AT ALL, telling the user to fill in a
      // Server URL would send them to fix something that wouldn't help.
      expect(out.status).toBe("unknown");
      expect(out.message).toMatch(/no zero-argument read action/);
      expect(captured).toHaveLength(0);
      expect(setStatus).not.toHaveBeenCalled();
    },
  );

  it("a Server URL that IS set is used verbatim as the base (zendesk)", async () => {
    useLocalProvider();
    getById.mockResolvedValue({
      ...CONN,
      serverUrl: "https://acme.zendesk.com/api/v2",
    });

    const out = await svc.test("t1", "c1", "zendesk");

    expect(out.ok).toBe(true);
    // The catalog path is appended to the connection's base — /api/v2 + /tickets.json.
    expect(captured[0].url).toBe("/api/v2/tickets.json");
  });
});

describe("the probe can only ever be a safe read (catalog-derived)", () => {
  it("every provider's picked action is non-write and needs no user input", () => {
    for (const provider of INTEGRATION_PROVIDERS) {
      const probe = pickConnectionTestAction(provider.key);
      if (probe.kind === "unknown") {
        expect(probe.reason.length).toBeGreaterThan(0);
        continue;
      }
      const action = getIntegrationAction(provider.key, probe.action)!;
      expect(action.write).toBe(false);
      expect(
        action.fields.filter((f) => f.required && f.const === undefined),
      ).toEqual([]);
      // No `{placeholder}` can survive in the path when there are no required path fields.
      expect(action.pathTemplate).not.toMatch(/\{[^}]+\}/);
    }
  });

  it("is honest about coverage: 14 of the 38 providers have a zero-arg read", () => {
    // A tripwire, not a target. If a catalog entry gains or loses a zero-argument read this fails
    // and the number in docs/integrations/VERIFICATION.md must be updated with it.
    const probes = INTEGRATION_PROVIDERS.map((p) =>
      pickConnectionTestAction(p.key),
    );
    expect(probes.filter((p) => p.kind === "read")).toHaveLength(14);
    expect(probes.filter((p) => p.kind === "unknown")).toHaveLength(24);
  });
});
