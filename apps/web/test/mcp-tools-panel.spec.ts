// The MCP panel must not advertise tools the server does not expose (#1063).
//
// It listed a `run_<key>` row for EVERY saved workflow. The server exposes a workflow only when
// its graph's START node is an `mcpServerTrigger` (apps/api/src/mcp/mcp-exposed.ts). So a user
// connected a real client, saw only the six base tools, and reasonably concluded the MCP server
// was broken — the panel had promised tools that were never going to exist.
import { describe, expect, it } from "vitest";
import {
  exposedWorkflowTools,
  MCP_TRIGGER_TYPE,
  workflowToolName,
} from "../src/screens/app/integrations/mcp-tools";

const wf = (workflowKey: string, entryType: string | null) => ({
  workflowKey,
  entryType,
});

describe("exposedWorkflowTools — only what the server actually exposes", () => {
  it("lists ONLY workflows whose entry node is an mcpServerTrigger", () => {
    expect(
      exposedWorkflowTools([
        wf("triage", MCP_TRIGGER_TYPE),
        wf("nightly-sync", "scheduleTrigger"),
        wf("contact-form", "formTrigger"),
        wf("ops-bot", MCP_TRIGGER_TYPE),
      ]),
      // Hyphens SURVIVE — the server's character class is [^A-Za-z0-9_-], so `-` is legal in a
      // tool name and must not be rewritten to `_` here or the panel would show a name no
      // client will ever see.
    ).toEqual(["run_triage", "run_ops-bot"]);
  });

  it("lists nothing when no workflow has opted in — even with many saved workflows", () => {
    // The exact situation that produced the bug report: a populated workspace, zero opt-ins.
    expect(
      exposedWorkflowTools([
        wf("a", "webhookTrigger"),
        wf("b", "scheduleTrigger"),
        wf("c", null),
      ]),
    ).toEqual([]);
  });

  it("treats an unresolvable entry type as not exposed", () => {
    // `entryType: null` means the summary could not resolve the entry node. Absence of proof
    // is not proof of opt-in — advertising it would repeat the original defect.
    expect(exposedWorkflowTools([wf("mystery", null)])).toEqual([]);
  });

  it("slugifies the key the way the server's toolNamesFor does", () => {
    expect(workflowToolName("invoice-sync")).toBe("run_invoice-sync");
    expect(workflowToolName("weird key.v2")).toBe("run_weird_key_v2");
  });
});
