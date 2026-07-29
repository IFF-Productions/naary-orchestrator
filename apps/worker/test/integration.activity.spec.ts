import { beforeEach, describe, expect, it, vi } from "vitest";
import { __httpDeps, callIntegration } from "../src/temporal/activities";
import type { IntegrationNodeConfig } from "@naary/dsl";

const META = { tenantId: "t1", executionId: "exec-1", nodeId: "integ" };

/**
 * Minimal Response-like stub (status/statusText/headers/text) — what callIntegration reads.
 *
 * `headers` exposes BOTH `get` and `entries`: the failure capture (#916) iterates the response
 * headers, and a stub with only `get` would let the capture silently record `{}` while the test
 * still passed — proving nothing about the allowlist.
 */
function res(
  status: number,
  body: unknown,
  contentType = "application/json",
  extraHeaders: Record<string, string> = {},
): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const all: Record<string, string> = {
    "content-type": contentType,
    ...extraHeaders,
  };
  return {
    status,
    statusText: status === 404 ? "Not Found" : "",
    ok: status >= 200 && status < 300,
    headers: {
      get: (k: string) => all[k.toLowerCase()] ?? null,
      entries: () => Object.entries(all),
    },
    text: async () => text,
  } as unknown as Response;
}

const fetchMock = vi.fn();
const authMock = vi.fn();
const egressMock = vi.fn();
const connMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  authMock.mockReset().mockResolvedValue({ Authorization: "Bearer tok-123" });
  egressMock.mockReset().mockImplementation(async (u: string) => new URL(u));
  connMock.mockReset().mockResolvedValue({
    serverUrl: "https://acme.atlassian.net",
    authMode: "api_token",
  });
  __httpDeps.fetch = fetchMock as never;
  __httpDeps.resolveAuthHeader = authMock as never;
  __httpDeps.assertEgressAllowed = egressMock as never;
  __httpDeps.getConnection = connMock as never;
});

describe("callIntegration activity", () => {
  it("GitHub create_issue → POST api.github.com with body, auth + provider headers, egress checked", async () => {
    fetchMock.mockResolvedValue(res(201, { number: 5 }));
    const cfg: IntegrationNodeConfig = {
      provider: "github",
      action: "create_issue",
      connectionId: "gh",
      fields: {
        owner: "octocat",
        repo: "hello",
        title: "It broke",
        labels: ["bug"],
      },
    };

    const result = await callIntegration(cfg, cfg.fields!, META);

    expect(result).toEqual({
      status: "ok",
      httpStatus: 201,
      ok: true,
      body: { number: 5 },
    });
    // Right URL + method.
    const [url, init] = fetchMock.mock.calls[0];
    expect(url.toString()).toBe(
      "https://api.github.com/repos/octocat/hello/issues",
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      title: "It broke",
      labels: ["bug"],
    });
    // Auth resolved in-activity + attached; GitHub's static Accept header present.
    expect(authMock).toHaveBeenCalledWith("t1", "gh");
    expect(init.headers.Authorization).toBe("Bearer tok-123");
    expect(init.headers.Accept).toBe("application/vnd.github+json");
    // SSRF egress guard ran on the final URL.
    expect(egressMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/octocat/hello/issues",
    );
  });

  it("Jira create_issue → base URL comes from the connection's serverUrl", async () => {
    fetchMock.mockResolvedValue(res(201, { key: "PROJ-9" }));
    const cfg: IntegrationNodeConfig = {
      provider: "jira",
      action: "create_issue",
      connectionId: "jira",
      fields: { projectKey: "PROJ", summary: "down", issueType: "Bug" },
    };

    await callIntegration(cfg, cfg.fields!, META);

    expect(connMock).toHaveBeenCalledWith("t1", "jira");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url.toString()).toBe("https://acme.atlassian.net/rest/api/2/issue");
    expect(JSON.parse(init.body)).toEqual({
      fields: {
        project: { key: "PROJ" },
        summary: "down",
        issuetype: { name: "Bug" },
      },
    });
  });

  it("Jira uses HTTP Basic — the resolved Bearer token is re-wrapped as base64(email:token)", async () => {
    authMock.mockResolvedValue({ Authorization: "Bearer me@acme.com:tok" });
    fetchMock.mockResolvedValue(res(200, { key: "PROJ-1" }));
    const cfg: IntegrationNodeConfig = {
      provider: "jira",
      action: "get_issue",
      connectionId: "jira",
      fields: { issueKey: "PROJ-1" },
    };
    await callIntegration(cfg, cfg.fields!, META);
    const [, init] = fetchMock.mock.calls[0];
    const expected = `Basic ${Buffer.from("me@acme.com:tok").toString("base64")}`;
    expect(init.headers.Authorization).toBe(expected);
  });

  it("Jira over OAuth keeps Bearer (an OAuth access token is not Basic-wrapped)", async () => {
    connMock.mockResolvedValue({
      serverUrl: "https://acme.atlassian.net",
      authMode: "oauth",
    });
    authMock.mockResolvedValue({ Authorization: "Bearer oauth-access-token" });
    fetchMock.mockResolvedValue(res(200, { key: "PROJ-1" }));
    const cfg: IntegrationNodeConfig = {
      provider: "jira",
      action: "get_issue",
      connectionId: "jira",
      fields: { issueKey: "PROJ-1" },
    };
    await callIntegration(cfg, cfg.fields!, META);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer oauth-access-token");
  });

  it("Shopify custom-header (#655): token → X-Shopify-Access-Token, no Authorization", async () => {
    connMock.mockResolvedValue({
      serverUrl: "https://shop.myshopify.com/admin/api/2024-01",
      authMode: "api_token",
    });
    authMock.mockResolvedValue({ Authorization: "Bearer shpat_xxx" });
    fetchMock.mockResolvedValue(res(200, { product: {} }));
    const cfg: IntegrationNodeConfig = {
      provider: "shopify",
      action: "get_product",
      connectionId: "shop",
      fields: { productId: "123" },
    };
    await callIntegration(cfg, cfg.fields!, META);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers["X-Shopify-Access-Token"]).toBe("shpat_xxx");
    expect(init.headers.Authorization).toBeUndefined();
  });

  it("Discord custom-header (#655): token → Authorization: Bot <token> (prefix applied)", async () => {
    connMock.mockResolvedValue({
      serverUrl: "https://discord.com/api/v10",
      authMode: "api_token",
    });
    authMock.mockResolvedValue({ Authorization: "Bearer bot-token" });
    fetchMock.mockResolvedValue(res(200, {}));
    const cfg: IntegrationNodeConfig = {
      provider: "discord",
      action: "get_channel",
      connectionId: "disc",
      fields: { channelId: "c1" },
    };
    await callIntegration(cfg, cfg.fields!, META);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bot bot-token");
  });

  it("Monday custom-header (#655): bare Authorization, no Bearer prefix", async () => {
    connMock.mockResolvedValue({
      serverUrl: "https://api.monday.com",
      authMode: "api_token",
    });
    authMock.mockResolvedValue({ Authorization: "Bearer monday-tok" });
    fetchMock.mockResolvedValue(res(200, { data: {} }));
    const cfg: IntegrationNodeConfig = {
      provider: "monday",
      action: "create_item",
      connectionId: "mon",
      fields: {
        query: "mutation { create_item { id } }",
        variables: { boardId: "1", itemName: "x" },
      },
    };
    await callIntegration(cfg, cfg.fields!, META);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe("monday-tok");
  });

  it("Discord over OAuth keeps a genuine Bearer (custom-header only for api_token)", async () => {
    connMock.mockResolvedValue({
      serverUrl: "https://discord.com/api/v10",
      authMode: "oauth",
    });
    authMock.mockResolvedValue({ Authorization: "Bearer oauth-access" });
    fetchMock.mockResolvedValue(res(200, {}));
    const cfg: IntegrationNodeConfig = {
      provider: "discord",
      action: "get_channel",
      connectionId: "disc",
      fields: { channelId: "c1" },
    };
    await callIntegration(cfg, cfg.fields!, META);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer oauth-access");
  });

  it("GitHub keeps Bearer (authScheme default)", async () => {
    fetchMock.mockResolvedValue(res(200, {}));
    const cfg: IntegrationNodeConfig = {
      provider: "github",
      action: "get_issue",
      connectionId: "gh",
      fields: { owner: "o", repo: "r", issueNumber: 1 },
    };
    await callIntegration(cfg, cfg.fields!, META);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer tok-123");
  });

  it("get_issue → GET, no body", async () => {
    fetchMock.mockResolvedValue(res(200, { number: 7 }));
    const cfg: IntegrationNodeConfig = {
      provider: "github",
      action: "get_issue",
      connectionId: "gh",
      fields: { owner: "o", repo: "r", issueNumber: 7 },
    };
    await callIntegration(cfg, cfg.fields!, META);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  });

  it("a READ action returns a non-2xx for the graph to branch on (does NOT throw)", async () => {
    fetchMock.mockResolvedValue(res(404, { message: "Not Found" }));
    const cfg: IntegrationNodeConfig = {
      provider: "github",
      action: "get_issue", // read: a 404 "not found" is a meaningful, branchable result
      connectionId: "gh",
      fields: { owner: "o", repo: "r", issueNumber: 9 },
    };
    const result = await callIntegration(cfg, cfg.fields!, META);
    expect(result.httpStatus).toBe(404);
    expect(result.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("a WRITE action FAILS loudly on a non-2xx (a POST that didn't happen isn't 'success')", async () => {
    fetchMock.mockResolvedValue(res(404, { message: "Not Found" }));
    const cfg: IntegrationNodeConfig = {
      provider: "github",
      action: "comment_issue", // write → hard fail, don't hand the 404 back as output
      connectionId: "gh",
      fields: { owner: "o", repo: "r", issueNumber: 9, body: "hi" },
    };
    // The failure names the status + resolved path + a GitHub token/private-repo hint.
    await expect(callIntegration(cfg, cfg.fields!, META)).rejects.toThrow(
      /comment_issue' failed: 404 Not Found.*\/repos\/o\/r\/issues\/9\/comments.*private/s,
    );
    expect(fetchMock).toHaveBeenCalledOnce(); // at-most-once: not retried
  });

  it("a failed WRITE carries the redacted request/response in its failure details (#916)", async () => {
    // Throwing means nothing reaches ctx, so the step card used to say "No output was recorded
    // for this step" at the one moment the user most needs the data. It rides `details` now.
    fetchMock.mockResolvedValue(
      res(404, { message: "Not Found" }, "application/json", {
        "x-ratelimit-remaining": "4999",
        "set-cookie": "sid=supersecretsession",
      }),
    );
    const cfg: IntegrationNodeConfig = {
      provider: "github",
      action: "comment_issue",
      connectionId: "gh",
      fields: { owner: "o", repo: "r", issueNumber: 9, body: "hi" },
    };

    const err = await callIntegration(cfg, cfg.fields!, META).catch((e) => e);
    const http = (err.details?.[0] as Record<string, unknown>)?.http as {
      request: {
        method: string;
        url: string;
        headers: Record<string, string>;
        body?: { text: string };
      };
      response: {
        status: number;
        headers: Record<string, string>;
        body?: { text: string };
      };
    };

    expect(err.type).toBe("INTEGRATION_WRITE_FAILED");
    expect(http.request.method).toBe("POST");
    expect(http.request.url).toBe(
      "https://api.github.com/repos/o/r/issues/9/comments",
    );
    expect(http.request.body?.text).toBe('{"body":"hi"}');
    expect(http.response.status).toBe(404);
    expect(http.response.body?.text).toBe('{"message":"Not Found"}');
    // The rate-limit header survives (diagnostic); the credential ones do not.
    expect(http.response.headers["x-ratelimit-remaining"]).toBe("4999");
    expect(http.response.headers["set-cookie"]).toBe("[REDACTED]");
    expect(http.request.headers.authorization).toBe("[REDACTED]");
    // The resolved connection token is what must never reach Temporal history.
    expect(JSON.stringify(err.details)).not.toContain("tok-123");
  });

  it("get_pull_request → sends the diff media type + returns the raw diff text", async () => {
    const diff = "diff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new\n";
    fetchMock.mockResolvedValue(res(200, diff, "application/vnd.github.diff"));
    const cfg: IntegrationNodeConfig = {
      provider: "github",
      action: "get_pull_request",
      connectionId: "gh",
      fields: { owner: "o", repo: "r", pullNumber: 237 },
    };
    const result = await callIntegration(cfg, cfg.fields!, META);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url.toString()).toBe("https://api.github.com/repos/o/r/pulls/237");
    // Per-action header override wins over the provider's default Accept.
    expect(init.headers.Accept).toBe("application/vnd.github.diff");
    // Non-JSON content-type → body is the raw diff text, ready to feed an agent.
    expect(result.body).toBe(diff);
    expect(result.ok).toBe(true);
  });

  /* ── batch 4: Mattermost · PagerDuty · Google Sheets · DeepL ── */

  it("Mattermost send_message → POST the connection's server URL with a Bearer token", async () => {
    connMock.mockResolvedValue({
      serverUrl: "https://chat.acme.com",
      authMode: "pat",
    });
    fetchMock.mockResolvedValue(res(201, { id: "p1" }));
    const cfg: IntegrationNodeConfig = {
      provider: "mattermost",
      action: "send_message",
      connectionId: "mm",
      fields: { channel_id: "c1", message: "deploy finished" },
    };
    const result = await callIntegration(cfg, cfg.fields!, META);
    expect(result.httpStatus).toBe(201);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url.toString()).toBe("https://chat.acme.com/api/v4/posts");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      channel_id: "c1",
      message: "deploy finished",
    });
    // Mattermost API v4 really does take a Bearer — no rewrite.
    expect(init.headers.Authorization).toBe("Bearer tok-123");
  });

  it("Mattermost get_channel_by_name → GET, no body, base from serverUrl", async () => {
    connMock.mockResolvedValue({
      serverUrl: "https://chat.acme.com/",
      authMode: "pat",
    });
    fetchMock.mockResolvedValue(res(200, { id: "c1" }));
    const cfg: IntegrationNodeConfig = {
      provider: "mattermost",
      action: "get_channel_by_name",
      connectionId: "mm",
      fields: { teamName: "acme", channelName: "town-square" },
    };
    await callIntegration(cfg, cfg.fields!, META);
    const [url, init] = fetchMock.mock.calls[0];
    // The trailing slash on the connection URL is trimmed, not doubled.
    expect(url.toString()).toBe(
      "https://chat.acme.com/api/v4/teams/name/acme/channels/name/town-square",
    );
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  });

  it("PagerDuty create_incident → 'Authorization: Token token=<key>' (NOT a Bearer) + v2 Accept + From header", async () => {
    connMock.mockResolvedValue({ serverUrl: null, authMode: "api_token" });
    authMock.mockResolvedValue({ Authorization: "Bearer pd-key" });
    fetchMock.mockResolvedValue(res(201, { incident: { id: "PT4KHLK" } }));
    const cfg: IntegrationNodeConfig = {
      provider: "pagerduty",
      action: "create_incident",
      connectionId: "pd",
      fields: {
        From: "oncall@acme.com",
        title: "Checkout is down",
        serviceId: "PW7YESS",
        urgency: "high",
      },
    };
    await callIntegration(cfg, cfg.fields!, META);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url.toString()).toBe("https://api.pagerduty.com/incidents");
    // PagerDuty's real scheme — the raw key after a literal `Token token=` prefix.
    expect(init.headers.Authorization).toBe("Token token=pd-key");
    expect(init.headers.Accept).toBe(
      "application/vnd.pagerduty+json;version=2",
    );
    // The `From` FIELD lands as a request header, not in the body.
    expect(init.headers.From).toBe("oncall@acme.com");
    expect(JSON.parse(init.body)).toEqual({
      incident: {
        type: "incident",
        title: "Checkout is down",
        service: { id: "PW7YESS", type: "service_reference" },
        urgency: "high",
      },
    });
  });

  it("PagerDuty resolve_incident → PUT with the const discriminators; a non-2xx write fails loudly", async () => {
    connMock.mockResolvedValue({ serverUrl: null, authMode: "api_token" });
    authMock.mockResolvedValue({ Authorization: "Bearer pd-key" });
    fetchMock.mockResolvedValue(res(403, { error: { message: "Forbidden" } }));
    const cfg: IntegrationNodeConfig = {
      provider: "pagerduty",
      action: "resolve_incident",
      connectionId: "pd",
      fields: { From: "oncall@acme.com", id: "PT4KHLK" },
    };
    await expect(callIntegration(cfg, cfg.fields!, META)).rejects.toThrow(
      /resolve_incident' failed: 403.*\/incidents\/PT4KHLK/s,
    );
    const [url, init] = fetchMock.mock.calls[0];
    expect(url.toString()).toBe("https://api.pagerduty.com/incidents/PT4KHLK");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({
      incident: { type: "incident_reference", status: "resolved" },
    });
    expect(fetchMock).toHaveBeenCalledOnce(); // at-most-once: not retried
  });

  it("a header FIELD can never clobber the resolved auth header", async () => {
    connMock.mockResolvedValue({ serverUrl: null, authMode: "api_token" });
    authMock.mockResolvedValue({ Authorization: "Bearer pd-key" });
    fetchMock.mockResolvedValue(res(201, {}));
    const cfg: IntegrationNodeConfig = {
      provider: "pagerduty",
      action: "create_incident",
      connectionId: "pd",
      fields: { title: "t", serviceId: "s" },
    };
    // A hostile/incorrect field value keyed like the auth header — the catalog's PD action
    // declares `From` only, so `Authorization` isn't even built; assert auth survives.
    await callIntegration(
      cfg,
      { ...cfg.fields!, Authorization: "Bearer attacker" },
      META,
    );
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe("Token token=pd-key");
    // …and the provider's own catalog header still wins over a field-built one.
    expect(init.headers.Accept).toBe(
      "application/vnd.pagerduty+json;version=2",
    );
  });

  it("a CR/LF in a header field fails NON-retryably and never reaches fetch", async () => {
    connMock.mockResolvedValue({ serverUrl: null, authMode: "api_token" });
    const cfg: IntegrationNodeConfig = {
      provider: "pagerduty",
      action: "create_incident",
      connectionId: "pd",
      fields: { title: "t", serviceId: "s" },
    };
    // `From` bound from run data that carries an injected header.
    await expect(
      callIntegration(
        cfg,
        { ...cfg.fields!, From: "a@b.com\r\nX-Injected: 1" },
        META,
      ),
    ).rejects.toMatchObject({
      nonRetryable: true,
      type: "INTEGRATION_INVALID_CONFIG",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Google Sheets append_row → POST with an OAuth Bearer, range in A1 notation, :append kept", async () => {
    fetchMock.mockResolvedValue(res(200, { updates: { updatedRows: 1 } }));
    const cfg: IntegrationNodeConfig = {
      provider: "googlesheets",
      action: "append_row",
      connectionId: "gs",
      fields: {
        spreadsheetId: "1AbC",
        range: "Sheet1!A1",
        valueInputOption: "USER_ENTERED",
        values: [["Ada", "ada@acme.com"]],
      },
    };
    await callIntegration(cfg, cfg.fields!, META);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url.toString()).toBe(
      "https://sheets.googleapis.com/v4/spreadsheets/1AbC/values/Sheet1!A1:append?valueInputOption=USER_ENTERED",
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      values: [["Ada", "ada@acme.com"]],
    });
    // Google Sheets takes an OAuth access token as a plain Bearer.
    expect(init.headers.Authorization).toBe("Bearer tok-123");
    // No connection lookup is needed (static base + bearer).
    expect(connMock).not.toHaveBeenCalled();
  });

  it("Google Sheets get_values → GET returns a non-2xx for the graph to branch on", async () => {
    fetchMock.mockResolvedValue(res(404, { error: { code: 404 } }));
    const cfg: IntegrationNodeConfig = {
      provider: "googlesheets",
      action: "get_values",
      connectionId: "gs",
      fields: { spreadsheetId: "1AbC", range: "Sheet1!A1:D20" },
    };
    const result = await callIntegration(cfg, cfg.fields!, META);
    expect(result.httpStatus).toBe(404);
    expect(result.ok).toBe(false);
    const [url] = fetchMock.mock.calls[0];
    expect(url.toString()).toBe(
      "https://sheets.googleapis.com/v4/spreadsheets/1AbC/values/Sheet1!A1%3AD20",
    );
  });

  it("DeepL translate_text → 'Authorization: DeepL-Auth-Key <key>' on the connection's host", async () => {
    connMock.mockResolvedValue({
      serverUrl: "https://api-free.deepl.com",
      authMode: "api_token",
    });
    authMock.mockResolvedValue({ Authorization: "Bearer deepl-key:fx" });
    fetchMock.mockResolvedValue(res(200, { translations: [] }));
    const cfg: IntegrationNodeConfig = {
      provider: "deepl",
      action: "translate_text",
      connectionId: "dl",
      fields: { text: ["Hello world!"], target_lang: "DE" },
    };
    await callIntegration(cfg, cfg.fields!, META);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url.toString()).toBe("https://api-free.deepl.com/v2/translate");
    expect(init.headers.Authorization).toBe("DeepL-Auth-Key deepl-key:fx");
    expect(JSON.parse(init.body)).toEqual({
      text: ["Hello world!"],
      target_lang: "DE",
    });
  });

  it("fails non-retryable on an invalid config (missing required field)", async () => {
    const cfg: IntegrationNodeConfig = {
      provider: "github",
      action: "create_issue",
      connectionId: "gh",
      fields: { owner: "o", repo: "r" }, // no title
    };
    await expect(callIntegration(cfg, cfg.fields!, META)).rejects.toThrow(
      /missing required field 'title'/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
