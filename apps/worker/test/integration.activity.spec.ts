import { beforeEach, describe, expect, it, vi } from "vitest";
import { __httpDeps, callIntegration } from "../src/temporal/activities";
import type { IntegrationNodeConfig } from "@naary/dsl";

const META = { tenantId: "t1", executionId: "exec-1", nodeId: "integ" };

/** Minimal Response-like stub (status/ok/headers/text) — what callIntegration reads. */
function res(
  status: number,
  body: unknown,
  contentType = "application/json",
): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (k: string) =>
        k.toLowerCase() === "content-type" ? contentType : null,
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
