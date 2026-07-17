import { beforeEach, describe, expect, it, vi } from "vitest";
import { MissingConnectionTokenError } from "@naary/connections";
import {
  __setObjectStore,
  isClaimCheck,
  MemoryObjectStore,
  resolveClaimChecks,
} from "@naary/storage";
import { __mcpDeps, callMcpTool } from "../src/temporal/activities";

const META = { tenantId: "t1", executionId: "exec-1", nodeId: "mcp" };
const CFG = { connectionId: "conn-1", tool: "createIssue" };

const resolveMcpTarget = vi.fn();
const mcpCall = vi.fn();
const secretMock = vi.fn();
let store: MemoryObjectStore;

beforeEach(() => {
  resolveMcpTarget.mockReset();
  mcpCall.mockReset();
  secretMock.mockReset().mockResolvedValue(null); // no secret unless a test sets one
  __mcpDeps.resolveMcpTarget = resolveMcpTarget as never;
  __mcpDeps.callMcpTool = mcpCall as never;
  __mcpDeps.getSecret = secretMock as never;
  store = new MemoryObjectStore();
  __setObjectStore(store);
});

describe("callMcpTool activity", () => {
  it("resolves the target, invokes the tool, and returns its content", async () => {
    resolveMcpTarget.mockResolvedValue({
      serverUrl: "https://mcp.atlassian.com/v1/mcp",
      headers: { Authorization: "Bearer tok" },
    });
    mcpCall.mockResolvedValue({
      content: [{ type: "text", text: "ISSUE-1 created" }],
      isError: false,
    });

    const result = await callMcpTool(CFG, { summary: "bug" }, META);

    expect(result).toEqual({
      status: "ok",
      content: [{ type: "text", text: "ISSUE-1 created" }],
      costUsd: 0, // no per-call cost configured
    });
    expect(resolveMcpTarget).toHaveBeenCalledWith("t1", "conn-1");
    // the resolved server URL + auth header are passed to the MCP call
    expect(mcpCall.mock.calls[0][0]).toMatchObject({
      serverUrl: "https://mcp.atlassian.com/v1/mcp",
      headers: { Authorization: "Bearer tok" },
      tool: "createIssue",
    });
  });

  it("claim-checks a large result to object storage and returns a small reference (Arch§4.6)", async () => {
    resolveMcpTarget.mockResolvedValue({
      serverUrl: "https://x/mcp",
      headers: {},
    });
    const bigContent = [{ type: "text", text: "z".repeat(1_100_000) }]; // > 1MB
    mcpCall.mockResolvedValue({ content: bigContent, isError: false });

    const result = await callMcpTool(CFG, {}, META);

    // the returned content is a small claim-check reference, not the 1MB blob
    expect(isClaimCheck(result.content)).toBe(true);
    expect(JSON.stringify(result.content).length).toBeLessThan(500);
    // and it resolves back to the original content
    expect(await resolveClaimChecks(result.content, store)).toEqual(bigContent);
  });

  it("surfaces a tool-level error (isError) as a non-retryable failure, not success", async () => {
    resolveMcpTarget.mockResolvedValue({
      serverUrl: "https://mcp.atlassian.com/v1/mcp",
      headers: { Authorization: "Bearer tok" },
    });
    mcpCall.mockResolvedValue({
      content: [{ type: "text", text: "permission denied" }],
      isError: true,
    });

    await expect(
      callMcpTool(CFG, { summary: "bug" }, META),
    ).rejects.toMatchObject({ nonRetryable: true, type: "MCP_TOOL_ERROR" });
  });

  it("maps a missing/needs-reauth connection to a NON-retryable failure", async () => {
    resolveMcpTarget.mockRejectedValue(
      new MissingConnectionTokenError("conn-1"),
    );
    await expect(callMcpTool(CFG, {}, META)).rejects.toMatchObject({
      nonRetryable: true,
      type: "CONNECTION_REAUTH",
    });
    expect(mcpCall).not.toHaveBeenCalled();
  });

  it("rethrows transient errors for Temporal to retry", async () => {
    resolveMcpTarget.mockResolvedValue({ serverUrl: "u", headers: {} });
    mcpCall.mockRejectedValue(new Error("network blip"));
    await expect(callMcpTool(CFG, {}, META)).rejects.toThrow("network blip");
  });
});

describe("callMcpTool — $secrets in tool arguments (in-activity, Tier-1 §4)", () => {
  const SECRET = "sk-tool-secret";

  it("resolves `{{ $secrets.NAME }}` nested in arguments; the value is in the CALL, not the result", async () => {
    secretMock.mockResolvedValue(SECRET);
    resolveMcpTarget.mockResolvedValue({
      serverUrl: "https://mcp/x",
      headers: {},
    });
    mcpCall.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      isError: false,
    });

    const result = await callMcpTool(
      {
        connectionId: "conn-1",
        tool: "search",
        arguments: { auth: { apiKey: "{{ $secrets.SEARCH_KEY }}" }, q: "cats" },
      },
      {},
      { ...META, environmentId: "env-prod" },
    );

    // Fetched by NAME for the run's env, and inlined into the arguments SENT to the tool…
    expect(secretMock).toHaveBeenCalledWith("t1", "env-prod", "SEARCH_KEY");
    expect(mcpCall.mock.calls[0][0].arguments).toEqual({
      auth: { apiKey: SECRET },
      q: "cats",
    });
    // …but the plaintext never rides back in the result (which enters Temporal history).
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain("$secrets");
  });

  it("a missing secret is a non-retryable failure naming the NAME (no tool call)", async () => {
    secretMock.mockResolvedValue(null);
    resolveMcpTarget.mockResolvedValue({
      serverUrl: "https://mcp/x",
      headers: {},
    });

    await expect(
      callMcpTool(
        {
          connectionId: "conn-1",
          tool: "search",
          arguments: { key: "{{ $secrets.NOPE }}" },
        },
        {},
        { ...META, environmentId: "env-prod" },
      ),
    ).rejects.toMatchObject({
      nonRetryable: true,
      message: expect.stringContaining("NOPE"),
    });
    expect(mcpCall).not.toHaveBeenCalled();
  });
});
