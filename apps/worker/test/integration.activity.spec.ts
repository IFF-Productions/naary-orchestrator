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
const connUrlMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  authMock.mockReset().mockResolvedValue({ Authorization: "Bearer tok-123" });
  egressMock.mockReset().mockImplementation(async (u: string) => new URL(u));
  connUrlMock.mockReset().mockResolvedValue("https://acme.atlassian.net");
  __httpDeps.fetch = fetchMock as never;
  __httpDeps.resolveAuthHeader = authMock as never;
  __httpDeps.assertEgressAllowed = egressMock as never;
  __httpDeps.getConnectionServerUrl = connUrlMock as never;
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

    expect(connUrlMock).toHaveBeenCalledWith("t1", "jira");
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

  it("returns a non-2xx for the graph to branch on (does NOT throw)", async () => {
    fetchMock.mockResolvedValue(res(422, { message: "Validation Failed" }));
    const cfg: IntegrationNodeConfig = {
      provider: "github",
      action: "create_issue",
      connectionId: "gh",
      fields: { owner: "o", repo: "r", title: "t" },
    };
    const result = await callIntegration(cfg, cfg.fields!, META);
    expect(result.httpStatus).toBe(422);
    expect(result.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
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
