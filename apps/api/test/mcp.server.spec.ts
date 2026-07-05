import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { NODE_CATALOG } from "@naary/dsl";
import { beforeEach, describe, expect, it } from "vitest";
import { buildMcpServer } from "../src/mcp/mcp.server";

// Exercise the real MCP server through a real MCP client over an in-memory transport pair —
// the same client SDK the worker uses to CALL remote servers, now pointed at OUR server.
async function connect() {
  const server = buildMcpServer({ tenantId: "t-1" });
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, server };
}

describe("MCP server — list_node_types", () => {
  let client: Client;

  beforeEach(async () => {
    ({ client } = await connect());
  });

  it("advertises the list_node_types tool", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("list_node_types");
  });

  it("returns the full node catalog (every type, with group + summary)", async () => {
    const res = await client.callTool({
      name: "list_node_types",
      arguments: {},
    });
    const text = (res.content as { type: string; text: string }[])[0].text;
    const { nodes } = JSON.parse(text) as {
      nodes: { type: string; group: string; summary: string }[];
    };

    // one entry per catalogued node type
    expect(nodes).toHaveLength(Object.keys(NODE_CATALOG).length);
    const types = nodes.map((n) => n.type);
    for (const t of ["agent", "switch", "if", "random", "scheduleTrigger"]) {
      expect(types).toContain(t);
    }
    // shape is agent-usable: every node carries a group + a non-empty summary
    for (const n of nodes) {
      expect(n.group).toBeTruthy();
      expect(n.summary).toBeTruthy();
    }
  });
});
