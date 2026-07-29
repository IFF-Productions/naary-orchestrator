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
import { NotFoundException } from "@nestjs/common";
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

  it("scrubs the token even when the PROVIDER echoes it back in its error body", async () => {
    // Real providers do this ("Invalid token: sk-abc…"). The excerpt lands in an API response body,
    // so an echoed credential would reach a browser console / Sentry breadcrumb / screenshot.
    useLocalProvider("super-secret-token");
    getById.mockResolvedValue(CONN);
    reply = {
      status: 401,
      body: JSON.stringify({
        error: "Invalid token: super-secret-token — check your key",
      }),
    };

    const out = await svc.test("t1", "c1", "calendly");

    expect(out.connectionStatus).toBe("needs_reauth");
    expect(JSON.stringify(out)).not.toContain("super-secret-token");
    // The useful part of the provider's message survives.
    expect(out.message).toContain("[redacted]");
    expect(out.message).toContain("check your key");
  });

  it("scrubs the base64 form too (a Basic-scheme provider echoing the header value)", async () => {
    useLocalProvider("alice@acme.com:api-tok");
    getById.mockResolvedValue(CONN);
    const b64 = "YWxpY2VAYWNtZS5jb206YXBpLXRvaw==";
    reply = { status: 401, body: `rejected credential ${b64}` };

    const out = await svc.test("t1", "c1", "zendesk");

    expect(JSON.stringify(out)).not.toContain(b64);
    expect(JSON.stringify(out)).not.toContain("alice@acme.com:api-tok");
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

  /**
   * GitHub, the provider the whole of #835 turns on, and the one place where the auth mode changes
   * WHICH endpoint is safe rather than just how the token is wrapped. Verified against the real
   * api.github.com before these entries landed: a PAT gets 200 from `/user` and 403 from
   * `/installation/repositories`; a GitHub App installation token gets exactly the reverse. Probing
   * an App connection with `/user` would therefore report a working connection as broken — the one
   * outcome worse than reporting nothing at all.
   */
  it("probes a GitHub PAT connection with GET /user", async () => {
    useLocalProvider();
    getById.mockResolvedValue({ ...CONN, authMode: "pat" });

    const out = await svc.test("t1", "c1", "github");

    expect(out.ok).toBe(true);
    expect(out.checkedAction).toBe("github.get_authenticated_user");
    expect(captured[0].method).toBe("GET");
    expect(captured[0].url).toBe("/user");
  });

  it("probes a GitHub APP connection with GET /installation/repositories instead", async () => {
    useLocalProvider();
    getById.mockResolvedValue({ ...CONN, authMode: "github_app" });

    const out = await svc.test("t1", "c1", "github");

    expect(out.ok).toBe(true);
    expect(out.checkedAction).toBe("github.list_installation_repositories");
    expect(captured[0].method).toBe("GET");
    expect(captured[0].url).toBe("/installation/repositories");
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
    // The catalog's own `unprobeableReason` (#835): Slack DOES have an argument-free `auth.test`,
    // and the reason we still decline is the one thing the user could not guess — it answers 200
    // with `{"ok": false}` for a dead token, so probing it would report a pass.
    expect(out.message).toMatch(/HTTP 200/);
    expect(out.message).toMatch(/single-node Test/);
    // The load-bearing assertion: nothing was sent, so no scratch channel got a message.
    expect(captured).toHaveLength(0);
    // And an `unknown` learned nothing about the token, so it must not overwrite the status.
    expect(setStatus).not.toHaveBeenCalled();
    expect(out.connectionStatus).toBeNull();
  });

  it.each(["googlesheets", "linear", "monday", "dropbox", "msgraph"])(
    "%s reports unknown with the catalog's declared reason, and calls nothing",
    async (providerKey) => {
      useLocalProvider();
      getById.mockResolvedValue(CONN);

      const out = await svc.test("t1", "c1", providerKey);

      expect(out.status).toBe("unknown");
      expect(out.checkedAction).toBeNull();
      // A reason a person can act on, not "no zero-argument read action".
      expect(out.message).toMatch(/single-node Test/);
      expect(captured).toHaveLength(0);
      expect(setStatus).not.toHaveBeenCalled();
    },
  );

  it("an unknown CONNECTION id is a 404, not an `unknown` result", async () => {
    // `unknown` is a verdict about the provider ("nothing safe to call"). A bad id is a bad path —
    // and the route advertises 404, like the sibling connection routes.
    useLocalProvider();
    getById.mockResolvedValue(null);

    await expect(svc.test("t1", "nope", "calendly")).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(captured).toHaveLength(0);
    expect(setStatus).not.toHaveBeenCalled();
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
  // Six catalog providers have no `baseUrl` and need the connection's Server URL. Since #835 ALL
  // SIX are probeable (jira/mailchimp/mattermost gained an identity read), so all six reach this
  // branch — where three of them used to report "no safe read" before the URL was ever looked at.
  it.each(["deepl", "shopify", "zendesk", "jira", "mailchimp", "mattermost"])(
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

  it("an unprobeable provider still reports `unknown` first, not 'set a Server URL'", async () => {
    // Deliberate ordering, and it still matters for the providers that stay unprobed: if we can't
    // probe the provider AT ALL, telling the user to fill in a Server URL sends them to fix
    // something that wouldn't help. Google Sheets has a fixed baseUrl, so this is asserted with the
    // ordering that remains observable — nothing is called and no status is written.
    useLocalProvider();
    getById.mockResolvedValue({ ...CONN, serverUrl: "   " });

    const out = await svc.test("t1", "c1", "googlesheets");

    expect(out.status).toBe("unknown");
    expect(captured).toHaveLength(0);
    expect(setStatus).not.toHaveBeenCalled();
  });

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

/** Every `Connection.authMode` in the schema, plus "the caller didn't say" — the probe must be safe
 *  for all of them, not just the default. */
const AUTH_MODES = [
  undefined,
  "api_token",
  "pat",
  "oauth",
  "github_app",
  "connection_string",
] as const;

describe("the probe can only ever be a safe read (catalog-derived)", () => {
  it("every provider's picked action, for EVERY auth mode, is a non-write GET needing no user input", () => {
    // Swept across auth modes since #835: the auth mode now changes WHICH action is picked
    // (GitHub), so a rule that was safe for the default mode is no longer evidence it is safe for
    // the others. This is the property that must not regress — a dry run may never fire a write.
    for (const provider of INTEGRATION_PROVIDERS) {
      for (const authMode of AUTH_MODES) {
        const where = `${provider.key} (authMode=${authMode ?? "none"})`;
        const probe = pickConnectionTestAction(provider.key, { authMode });
        if (probe.kind === "unknown") {
          expect(probe.reason.length, where).toBeGreaterThan(0);
          continue;
        }
        const action = getIntegrationAction(provider.key, probe.action)!;
        expect(action, where).toBeDefined();
        expect(action.write, where).toBe(false);
        expect(action.method, where).toBe("GET");
        expect(
          action.fields.filter((f) => f.required && f.const === undefined),
          where,
        ).toEqual([]);
        // No `{placeholder}` can survive in the path when there are no required path fields.
        expect(action.pathTemplate, where).not.toMatch(/\{[^}]+\}/);
      }
    }
  });

  it("every action DECLARING itself a probe satisfies the same gate", () => {
    // The declaration narrows the choice; it must never be a way to smuggle something past the
    // rule. Asserted on the catalog directly so a `probe: true` on a write fails here even if the
    // selection code would have filtered it out.
    const offenders: string[] = [];
    for (const p of INTEGRATION_PROVIDERS) {
      for (const a of p.actions) {
        if (!a.probe) continue;
        const bad =
          a.write ||
          a.method !== "GET" ||
          a.fields.some((f) => f.required && f.const === undefined) ||
          /\{[^}]+\}/.test(a.pathTemplate);
        if (bad)
          offenders.push(`${p.key}.${a.key} (${a.method} ${a.pathTemplate})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no non-GET action is marked write:false unless it is a known POST-style READ", () => {
    // #701 makes the catalog's `write` flag load-bearing for safety: it is the ONLY thing standing
    // between this route and a mutation. A mutating action mismarked `write: false` is therefore a
    // security bug, not a metadata slip — discord.add_reaction (a PUT that adds a reaction) was
    // exactly that. The allowlist below is the set of genuinely read-only non-GETs: GraphQL/RPC
    // endpoints that take their query in a POST body, and DeepL's translate (a transform, not a
    // mutation — billable, which is why it is never probe-selected: it has required fields).
    const POST_READS = new Set([
      "linear.get_issue",
      "linear.list_issues",
      "monday.get_item",
      "monday.list_items",
      "notion.query_database",
      "dropbox.list_folder",
      "dropbox.get_metadata",
      "deepl.translate_text",
    ]);
    const offenders: string[] = [];
    for (const p of INTEGRATION_PROVIDERS) {
      for (const a of p.actions) {
        const key = `${p.key}.${a.key}`;
        if (!a.write && a.method !== "GET" && !POST_READS.has(key)) {
          offenders.push(`${key} (${a.method} ${a.pathTemplate})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every action the probe can select is a GET", () => {
    // Belt to the `write` flag's braces: even a mismarked POST-read can't be probed.
    for (const p of INTEGRATION_PROVIDERS) {
      const probe = pickConnectionTestAction(p.key);
      if (probe.kind === "read") expect(probe.method).toBe("GET");
    }
  });

  it("is honest about coverage: 32 of the 38 providers can be probed, and names the other 6", () => {
    // A tripwire, not a target (it was 14/24 before #835). If a catalog entry gains or loses a
    // safe probe this fails, and the number in docs/integrations/VERIFICATION.md, the dry-run
    // service docblock and apps/web must be updated with it.
    const probes = INTEGRATION_PROVIDERS.map((p) =>
      pickConnectionTestAction(p.key),
    );
    expect(probes.filter((p) => p.kind === "read")).toHaveLength(32);
    // Named rather than counted: each of these is a decision with a reason, and the reason is
    // shown to the user. A provider joining this list silently is the bug #835 was about.
    expect(
      INTEGRATION_PROVIDERS.filter(
        (p) => pickConnectionTestAction(p.key).kind === "unknown",
      )
        .map((p) => p.key)
        .sort(),
    ).toEqual([
      "dropbox", // POST-only RPC
      "googlesheets", // no identity endpoint on sheets.googleapis.com
      "linear", // GraphQL POST
      "monday", // GraphQL POST
      "msgraph", // /me is delegated-token-only
      "slack", // answers 200 {"ok":false} to a dead token
    ]);
  });

  it("every unprobeable provider explains itself in words the user can act on", () => {
    for (const p of INTEGRATION_PROVIDERS) {
      const probe = pickConnectionTestAction(p.key);
      if (probe.kind !== "unknown") continue;
      // The point of #835: a skipped credential check must SAY it was skipped and why — never
      // read as a pass, and never be a shrug.
      expect(probe.reason, p.key).toMatch(/single-node Test/);
      expect(probe.reason.length, p.key).toBeGreaterThan(60);
    }
  });
});
