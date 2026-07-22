import type { GraphDef } from "@naary/dsl";
import { describe, expect, it } from "vitest";
import { extractMcpServerTool } from "../src/mcp/mcp-exposed";

// The pure opt-in check that turns a saved workflow into a hosted MCP tool (flavor B). This is
// the crux of AC #470 ("a serverTrigger NODE exposes tools") — proven here without any DB/SDK.
const graph = (startNodeId: string, nodes: GraphDef["nodes"]): GraphDef =>
  ({ startNodeId, nodes, edges: [] }) as GraphDef;

describe("extractMcpServerTool (MCP server-trigger opt-in)", () => {
  it("EXPOSES a workflow whose ENTRY node is an mcpServerTrigger, reading its tool config", () => {
    const g = graph("m", [
      {
        id: "m",
        type: "mcpServerTrigger",
        config: { toolName: "run_refund", description: "Process a refund." },
      },
      { id: "end", type: "end" },
    ]);
    expect(extractMcpServerTool(g)).toEqual({
      toolName: "run_refund",
      toolDescription: "Process a refund.",
    });
  });

  it("EXPOSES an un-configured node with an empty config (server derives the name later)", () => {
    const g = graph("m", [{ id: "m", type: "mcpServerTrigger", config: {} }]);
    expect(extractMcpServerTool(g)).toEqual({});
  });

  it("does NOT expose a workflow whose entry is a different trigger (opt-in, not expose-all)", () => {
    const g = graph("w", [
      { id: "w", type: "webhookTrigger" },
      { id: "end", type: "end" },
    ]);
    expect(extractMcpServerTool(g)).toBeNull();
  });

  it("matches the ENTRY node ONLY — an mcpServerTrigger that is not the start node is ignored", () => {
    const g = graph("w", [
      { id: "w", type: "webhookTrigger" },
      { id: "m", type: "mcpServerTrigger", config: { toolName: "sneaky" } },
    ]);
    expect(extractMcpServerTool(g)).toBeNull();
  });

  it("ignores non-string / blank config values (nothing unexpected becomes a tool name)", () => {
    const g = graph("m", [
      {
        id: "m",
        type: "mcpServerTrigger",
        config: { toolName: "   ", description: 42 as unknown as string },
      },
    ]);
    expect(extractMcpServerTool(g)).toEqual({});
  });
});
