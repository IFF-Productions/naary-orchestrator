/**
 * Listing an MCP connection's tools for the canvas.
 *
 * NO NETWORK. `listMcpTools` is substituted at the `__mcpToolsDeps` seam (the same pattern as
 * `__connTestDeps`), so what this file proves is everything AROUND the MCP session — which is where
 * the risk lives:
 *
 *  - the resolved auth header must never appear in the response;
 *  - a tool name/description/schema is authored by whoever runs that server, so it is
 *    control-character-stripped, length-capped, list-capped, and an over-large schema is dropped;
 *  - a connection that isn't an MCP kind, or has no Server URL, is refused BEFORE a secret is
 *    resolved or a socket is opened;
 *  - a transport failure surfaces as a clean 503 whose message is ours, not the transport's (a
 *    transport error can carry the request headers, i.e. the token).
 */
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MissingConnectionTokenError } from "@naary/connections";
import {
  MAX_INPUT_SCHEMA_BYTES,
  MAX_TOOLS,
  MAX_TOOL_DESCRIPTION_CHARS,
  MAX_TOOL_NAME_CHARS,
  McpToolsService,
  __mcpToolsDeps,
} from "../src/connections/mcp-tools.service";

const SECRET = "Bearer super-secret-tenant-token";

function makeService(conn: Record<string, unknown> | null) {
  const connections = {
    getById: vi.fn(async () => conn),
    // biome-ignore lint/suspicious/noExplicitAny: only getById is exercised here
  } as any;
  return new McpToolsService(connections);
}

const MCP_CONN = {
  id: "c1",
  type: "custom",
  label: "Acme MCP",
  serverUrl: "https://mcp.example.com/v1",
};

beforeEach(() => {
  __mcpToolsDeps.resolveMcpTarget = vi.fn(async () => ({
    serverUrl: "https://mcp.example.com/v1",
    headers: { Authorization: SECRET },
  }));
});

describe("McpToolsService.list", () => {
  it("returns the server's tools with their schemas — the whole point of the route", async () => {
    __mcpToolsDeps.listMcpTools = vi.fn(async () => [
      {
        name: "create_issue",
        description: "Create an issue.",
        inputSchema: {
          type: "object",
          properties: { owner: { type: "string" }, repo: { type: "string" } },
          required: ["owner"],
        },
      },
    ]);
    const out = await makeService(MCP_CONN).list("t1", "c1");
    expect(out).toEqual([
      {
        name: "create_issue",
        description: "Create an issue.",
        inputSchema: {
          type: "object",
          properties: { owner: { type: "string" }, repo: { type: "string" } },
          required: ["owner"],
        },
      },
    ]);
  });

  it("never lets the resolved credential into the response, even when the server echoes it", async () => {
    // The one leak this route could plausibly have: `resolveMcpTarget` hands back
    // `{ serverUrl, headers }`, and only the tool list may cross the boundary (Tier-1 rule 4).
    // "The server put it there, not us" is not an exemption — a description or a schema `default`
    // echoing the header would put the tenant's token in a browser console. Asserted on the
    // SERIALIZED response so a nested field can't hide it.
    __mcpToolsDeps.listMcpTools = vi.fn(async () => [
      {
        name: `echo_${SECRET}`,
        description: `you sent ${SECRET}`,
        inputSchema: {
          type: "object",
          properties: { seen: { type: "string", default: SECRET } },
        },
      },
    ]);
    const out = await makeService(MCP_CONN).list("t1", "c1");
    expect(JSON.stringify(out)).not.toContain("super-secret");
    // Redacted, not dropped: the tool is still listable and still named.
    expect(out[0].name).toContain("echo_");
    expect(out[0].description).toContain("[redacted]");
  });

  it("strips control characters and caps the strings a server can make us relay", async () => {
    // ESCAPES, never raw bytes: a literal control byte in a source file hides the line from grep
    // and trips `pnpm check:control-bytes` (#810).
    __mcpToolsDeps.listMcpTools = vi.fn(async () => [
      {
        name: `a\u0000b\u001fc${"x".repeat(400)}`,
        description: `line1\nline2${"y".repeat(1000)}`,
      },
    ]);
    const out = await makeService(MCP_CONN).list("t1", "c1");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting they are gone is the point
    expect(out[0].name).not.toMatch(/[\u0000-\u001f]/);
    expect(out[0].name.length).toBeLessThanOrEqual(MAX_TOOL_NAME_CHARS);
    expect(out[0].description).not.toContain("\n");
    expect(out[0].description.length).toBeLessThanOrEqual(
      MAX_TOOL_DESCRIPTION_CHARS,
    );
  });

  it("drops an over-large input schema but keeps the tool — the author can still type the names", async () => {
    const fat: Record<string, unknown> = {};
    for (let i = 0; i < 20_000; i++) fat[`p${i}`] = { type: "string" };
    __mcpToolsDeps.listMcpTools = vi.fn(async () => [
      { name: "huge", inputSchema: { type: "object", properties: fat } },
      { name: "small", inputSchema: { type: "object", properties: {} } },
    ]);
    const out = await makeService(MCP_CONN).list("t1", "c1");
    expect(
      JSON.stringify({ type: "object", properties: fat }).length,
    ).toBeGreaterThan(MAX_INPUT_SCHEMA_BYTES);
    expect(out.find((t) => t.name === "huge")?.inputSchema).toBeUndefined();
    expect(out.find((t) => t.name === "small")?.inputSchema).toBeDefined();
  });

  it("caps the list, drops nameless tools, de-duplicates, and sorts by name", async () => {
    __mcpToolsDeps.listMcpTools = vi.fn(async () => [
      { name: "zeta" },
      { name: "" },
      { name: "alpha" },
      { name: "alpha" },
      ...Array.from({ length: MAX_TOOLS + 50 }, (_, i) => ({
        name: `t${String(i).padStart(4, "0")}`,
      })),
    ]);
    const out = await makeService(MCP_CONN).list("t1", "c1");
    expect(out.length).toBe(MAX_TOOLS);
    expect(out.filter((t) => t.name === "alpha").length).toBe(1);
    expect(out.some((t) => t.name === "")).toBe(false);
    expect([...out].sort((a, b) => a.name.localeCompare(b.name))).toEqual(out);
  });

  it("404s an unknown connection", async () => {
    __mcpToolsDeps.listMcpTools = vi.fn(async () => []);
    await expect(makeService(null).list("t1", "nope")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("refuses a non-MCP connection kind before resolving a secret or opening a socket", async () => {
    // A postgres row's `serverUrl` is a display host, not an endpoint. Without this check it would
    // reach assertEgressAllowed as garbage and come back as a baffling egress error.
    const listMcpTools = vi.fn(async () => []);
    __mcpToolsDeps.listMcpTools = listMcpTools;
    const svc = makeService({ ...MCP_CONN, type: "postgres" });
    await expect(svc.list("t1", "c1")).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(listMcpTools).not.toHaveBeenCalled();
    expect(__mcpToolsDeps.resolveMcpTarget).not.toHaveBeenCalled();
  });

  it("refuses a connection with no Server URL, saying so", async () => {
    __mcpToolsDeps.listMcpTools = vi.fn(async () => []);
    const svc = makeService({ ...MCP_CONN, serverUrl: "  " });
    await expect(svc.list("t1", "c1")).rejects.toThrow(/no Server URL/);
  });

  it("turns a missing token into 'authorize this connection', not a transport error", async () => {
    __mcpToolsDeps.resolveMcpTarget = vi.fn(async () => {
      throw new MissingConnectionTokenError("c1");
    });
    __mcpToolsDeps.listMcpTools = vi.fn(async () => []);
    await expect(makeService(MCP_CONN).list("t1", "c1")).rejects.toThrow(
      /authorized/,
    );
  });

  it("never echoes a transport error's message — it can carry the request headers", async () => {
    __mcpToolsDeps.listMcpTools = vi.fn(async () => {
      throw new Error(`fetch failed: headers={Authorization: ${SECRET}}`);
    });
    const err = await makeService(MCP_CONN)
      .list("t1", "c1")
      .catch((e: unknown) => e);
    expect(String(err)).not.toContain("super-secret");
    expect(String(err)).toMatch(/Could not list tools/);
  });
});
