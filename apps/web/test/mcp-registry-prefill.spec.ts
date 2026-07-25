// The pure registry → connect-form mapping (#578). Web specs run in a node environment, so this
// tests the extracted mapper, not the component.
import { describe, expect, it } from "vitest";
import type { McpRegistryServerRow } from "../src/lib/api";
import { prefillFor } from "../src/screens/app/integrations/mcp-registry-prefill";

const row = (
  over: Partial<McpRegistryServerRow> = {},
): McpRegistryServerRow => ({
  id: "curated:linear",
  name: "Linear",
  description: "Issues and projects.",
  transportUrl: "https://mcp.linear.app/mcp",
  transport: "http",
  authMode: "oauth",
  requiresAuth: true,
  trust: "curated",
  tags: ["issues"],
  ...over,
});

describe("prefillFor", () => {
  it("carries the transport URL + auth scheme onto the connect form", () => {
    expect(prefillFor(row())).toMatchObject({
      label: "Linear",
      serverUrl: "https://mcp.linear.app/mcp",
      type: "custom",
      authMode: "oauth",
    });
  });

  it("maps every registry auth mode onto a real Connection auth mode", () => {
    expect(prefillFor(row({ authMode: "api_token" })).authMode).toBe(
      "api_token",
    );
    expect(prefillFor(row({ authMode: "pat" })).authMode).toBe("pat");
    expect(prefillFor(row({ authMode: "oauth" })).authMode).toBe("oauth");
    // A Connection has no "none" mode — the token-based form is used with an optional (blank) token.
    expect(
      prefillFor(row({ authMode: "none", requiresAuth: false })).authMode,
    ).toBe("api_token");
  });

  it("tells the user when no credential is needed", () => {
    expect(
      prefillFor(row({ authMode: "none", requiresAuth: false })).note,
    ).toMatch(/needs no credential/);
    expect(prefillFor(row()).note).toMatch(/Supply the credential/);
  });

  it("always uses the generic `custom` connection type, even for a github-ish row", () => {
    // The `github`/`atlassian` connection types drive bespoke OAuth apps; an arbitrary registry row
    // must not be able to claim them.
    expect(prefillFor(row({ id: "x", name: "GitHub" })).type).toBe("custom");
  });
});
