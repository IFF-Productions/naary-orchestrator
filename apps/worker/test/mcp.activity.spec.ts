import { beforeEach, describe, expect, it, vi } from "vitest";
import { MissingConnectionTokenError } from "@naary/connections";
import { __mcpDeps, callMcpTool } from "../src/temporal/activities";

const META = { tenantId: "t1", executionId: "exec-1", nodeId: "mcp" };
const CFG = { connectionId: "conn-1", tool: "createIssue" };

const resolveMcpTarget = vi.fn();
const mcpCall = vi.fn();

beforeEach(() => {
  resolveMcpTarget.mockReset();
  mcpCall.mockReset();
  __mcpDeps.resolveMcpTarget = resolveMcpTarget as never;
  __mcpDeps.callMcpTool = mcpCall as never;
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
    });
    expect(resolveMcpTarget).toHaveBeenCalledWith("t1", "conn-1");
    // the resolved server URL + auth header are passed to the MCP call
    expect(mcpCall.mock.calls[0][0]).toMatchObject({
      serverUrl: "https://mcp.atlassian.com/v1/mcp",
      headers: { Authorization: "Bearer tok" },
      tool: "createIssue",
    });
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
