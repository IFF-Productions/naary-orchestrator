/**
 * The anti-drift test for #701.
 *
 * "Test connection" only proves anything if it composes the *same* request the `integration` node
 * composes. So this spec captures the request the REAL activity emits (via the `__httpDeps.fetch`
 * seam) and asserts it is byte-for-byte what `planIntegrationCall` — called directly, from the
 * catalog — produces. If someone re-inlines the HTTP-Basic re-wrap, the custom-header placement, or
 * the header merge order back into the activity (or changes one side only), this fails.
 *
 * The matrix is every catalog provider × { api_token, oauth }. The `oauth` row is the one that earns
 * this test its keep: an OAuth access token IS a Bearer, so it must SKIP both scheme rewrites — the
 * exact branch a future edit is most likely to break, and one no single-provider unit test covers.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  INTEGRATION_PROVIDERS,
  type IntegrationAction,
  type IntegrationField,
  type IntegrationProvider,
  planIntegrationCall,
} from "@naary/dsl";
import { __httpDeps, callIntegration } from "../src/temporal/activities";

const META = { tenantId: "t1", executionId: "exec-1", nodeId: "integ" };
const TOKEN = "tok-abc123";
/** Server URL used for the 6 providers whose base comes from the connection. */
const SERVER_URL = "https://acme.example.com";

function res(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => "application/json" },
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** A plausible value per field type, so a required path/query/body field is always supplied and the
 *  built request is complete. Values are deliberately boring: this test compares two composers, it
 *  does not assert what any provider's API accepts. */
function sampleValue(f: IntegrationField): unknown {
  switch (f.type) {
    case "number":
      return 7;
    case "boolean":
      return true;
    case "string[]":
      return ["a", "b"];
    case "json":
      return { k: "v" };
    default:
      return `v-${f.key}`;
  }
}

function sampleFields(action: IntegrationAction): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of action.fields) {
    // `const` fields are injected by the catalog — a user value would be ignored.
    if (f.const !== undefined) continue;
    if (f.required) out[f.key] = sampleValue(f);
  }
  return out;
}

/** The READ action with the most fields — the widest path/query/header surface per provider, so the
 *  comparison exercises as much of the builder as that provider offers. Falls back to any action
 *  (Slack: every action writes). */
function widestAction(provider: IntegrationProvider): IntegrationAction {
  const reads = provider.actions.filter((a) => !a.write);
  const pool = reads.length > 0 ? reads : provider.actions;
  return [...pool].sort((a, b) => b.fields.length - a.fields.length)[0];
}

const fetchMock = vi.fn();
const authMock = vi.fn();
const egressMock = vi.fn();
const connMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue(res(200, { ok: true }));
  // The resolver ALWAYS hands back `Bearer <token>` regardless of scheme (see
  // packages/connections/src/auth.ts) — the per-provider rewrite is exactly what's under test.
  authMock.mockReset().mockResolvedValue({ Authorization: `Bearer ${TOKEN}` });
  egressMock.mockReset().mockImplementation(async (u: string) => new URL(u));
  connMock.mockReset();
  __httpDeps.fetch = fetchMock as never;
  __httpDeps.resolveAuthHeader = authMock as never;
  __httpDeps.assertEgressAllowed = egressMock as never;
  __httpDeps.getConnection = connMock as never;
});

const cases = INTEGRATION_PROVIDERS.flatMap((provider) =>
  (["api_token", "oauth"] as const).map((authMode) => ({
    provider,
    authMode,
    name: `${provider.key} over ${authMode}`,
  })),
);

describe("integration node ↔ planIntegrationCall cannot drift (#701)", () => {
  it.each(cases)(
    "$name — the activity emits exactly what planIntegrationCall composes",
    async ({ provider, authMode }) => {
      const action = widestAction(provider);
      const fields = sampleFields(action);
      const baseUrl = provider.baseUrl ?? SERVER_URL;
      connMock.mockResolvedValue({ serverUrl: SERVER_URL, authMode });

      // What the SHARED composer says the request should be — computed straight from the catalog,
      // with no involvement from the activity or the API service.
      const expected = planIntegrationCall({
        provider: provider.key,
        action: action.key,
        fields,
        baseUrl,
        authHeaders: { Authorization: `Bearer ${TOKEN}` },
        authMode,
      });

      // What the REAL activity actually put on the wire.
      await callIntegration(
        {
          provider: provider.key,
          action: action.key,
          connectionId: "c1",
          fields,
        },
        fields,
        META,
      ).catch(() => {
        // A write action returning non-2xx throws by design; we only care about the captured
        // request, and the 200 stub means this shouldn't fire — but never let it mask the compare.
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
      expect(String(url)).toBe(expected.url);
      expect(init.method).toBe(expected.method);
      expect(init.headers).toEqual(expected.headers);
      expect(init.body ?? undefined).toBe(expected.body);
      // The egress guard ran on the very URL that was fetched (no unchecked host).
      expect(egressMock).toHaveBeenCalledWith(expected.url);
    },
  );
});

describe("the auth-scheme rewrites the shared composer owns", () => {
  it("basic scheme + api_token → HTTP Basic (independently computed base64)", () => {
    const plan = planIntegrationCall({
      provider: "jira",
      action: "get_issue",
      fields: { issueKey: "PROJ-1" },
      baseUrl: SERVER_URL,
      authHeaders: { Authorization: "Bearer alice@acme.com:api-tok" },
      authMode: "api_token",
    });
    // Hard-coded expectation, not `Buffer.from(...)` — an independent check of the encoder
    // (@naary/dsl ships without @types/node, so it reaches base64 through globalThis).
    expect(plan.headers.Authorization).toBe(
      "Basic YWxpY2VAYWNtZS5jb206YXBpLXRvaw==",
    );
  });

  it("basic scheme + oauth → the access token stays a genuine Bearer", () => {
    const plan = planIntegrationCall({
      provider: "jira",
      action: "get_issue",
      fields: { issueKey: "PROJ-1" },
      baseUrl: SERVER_URL,
      authHeaders: { Authorization: "Bearer oauth-access" },
      authMode: "oauth",
    });
    expect(plan.headers.Authorization).toBe("Bearer oauth-access");
  });

  it.each([
    ["shopify", "X-Shopify-Access-Token", TOKEN],
    ["discord", "Authorization", `Bot ${TOKEN}`],
    ["clickup", "Authorization", TOKEN],
    ["monday", "Authorization", TOKEN],
    ["deepl", "Authorization", `DeepL-Auth-Key ${TOKEN}`],
    ["pagerduty", "Authorization", `Token token=${TOKEN}`],
  ])(
    "%s + api_token → %s carries the token with its literal prefix",
    (providerKey, header, expected) => {
      const provider = INTEGRATION_PROVIDERS.find(
        (p) => p.key === providerKey,
      )!;
      const action = widestAction(provider);
      const plan = planIntegrationCall({
        provider: providerKey,
        action: action.key,
        fields: sampleFields(action),
        baseUrl: provider.baseUrl ?? SERVER_URL,
        authHeaders: { Authorization: `Bearer ${TOKEN}` },
        authMode: "api_token",
      });
      expect(plan.headers[header]).toBe(expected);
      if (header !== "Authorization") {
        // The Bearer must be REMOVED, not left alongside the custom header.
        expect(plan.headers.Authorization).toBeUndefined();
      }
    },
  );

  it("custom-header scheme + oauth → stays a Bearer, custom header absent", () => {
    const plan = planIntegrationCall({
      provider: "shopify",
      action: "list_products",
      fields: {},
      baseUrl: SERVER_URL,
      authHeaders: { Authorization: "Bearer oauth-access" },
      authMode: "oauth",
    });
    expect(plan.headers.Authorization).toBe("Bearer oauth-access");
    expect(plan.headers["X-Shopify-Access-Token"]).toBeUndefined();
  });

  it("never mutates the caller's authHeaders object (the credential is borrowed, not owned)", () => {
    const authHeaders = { Authorization: `Bearer ${TOKEN}` };
    planIntegrationCall({
      provider: "shopify",
      action: "list_products",
      fields: {},
      baseUrl: SERVER_URL,
      authHeaders,
      authMode: "api_token",
    });
    expect(authHeaders).toEqual({ Authorization: `Bearer ${TOKEN}` });
  });

  it("auth wins over an action/provider header that tries to claim Authorization", () => {
    // PagerDuty has an `in:"header"` FIELD (`From`) — a value that can come from run data. It must
    // land in the request but must never be able to displace the resolved credential.
    const plan = planIntegrationCall({
      provider: "pagerduty",
      action: "create_incident",
      fields: {
        title: "t",
        service_id: "s",
        From: "ops@acme.com",
        Authorization: "attacker",
      },
      baseUrl: "https://api.pagerduty.com",
      authHeaders: { Authorization: `Bearer ${TOKEN}` },
      authMode: "api_token",
    });
    expect(plan.headers.From).toBe("ops@acme.com");
    expect(plan.headers.Authorization).toBe(`Token token=${TOKEN}`);
  });
});
