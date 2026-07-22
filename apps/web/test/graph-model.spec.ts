import { describe, expect, it } from "vitest";
import {
  defaultConfigFor,
  NODE_DESCRIPTION,
  NODE_KINDS,
  nodeDisplayLabel,
} from "../src/lib/graph-model";

describe("nodeDisplayLabel (custom name overrides the derived label)", () => {
  it("uses a trimmed config __name when set, else the derived type label", () => {
    expect(nodeDisplayLabel("agent", { __name: "  Classify ticket " })).toBe(
      "Classify ticket",
    );
    // Blank/whitespace or absent __name → the derived label, not an empty title.
    expect(nodeDisplayLabel("agent", { __name: "   " })).toBe(
      nodeDisplayLabel("agent"),
    );
    expect(nodeDisplayLabel("agent")).toBeTruthy();
    // A custom name overrides even the provider-derived integration label.
    expect(
      nodeDisplayLabel("integration", {
        provider: "github",
        __name: "Open issue",
      }),
    ).toBe("Open issue");
  });
});

describe("node registry (simpler-UX metadata)", () => {
  it("every node kind has a non-empty, plain-language description", () => {
    for (const k of NODE_KINDS) {
      expect(k.description, k.type).toBeTruthy();
      expect(k.description.length, k.type).toBeGreaterThan(10);
    }
  });

  it("NODE_DESCRIPTION covers every kind in the palette", () => {
    // A NodeType may have MULTIPLE palette tiles (e.g. `integration` → GitHub + Jira),
    // so NODE_DESCRIPTION (keyed by type) holds one of them; the palette renders each
    // tile's own `description`. Assert every type resolves to a real description.
    const byType = new Set(NODE_KINDS.map((k) => k.type));
    for (const type of byType) {
      const descs = NODE_KINDS.filter((k) => k.type === type).map(
        (k) => k.description,
      );
      expect(descs, type).toContain(NODE_DESCRIPTION[type]);
    }
  });

  it("defaultConfigFor returns a FRESH clone (canvas edits can't mutate the registry)", () => {
    const a = defaultConfigFor("agent");
    expect(a).toMatchObject({ provider: "anthropic" });
    // mutate the returned copy; the registry default must be untouched
    (a as Record<string, unknown>).provider = "mutated";
    expect(defaultConfigFor("agent")).toMatchObject({ provider: "anthropic" });
  });

  it("nodes without config default to undefined (e.g. start/end)", () => {
    expect(defaultConfigFor("start")).toBeUndefined();
    expect(defaultConfigFor("end")).toBeUndefined();
  });

  it("common data/action nodes ship with working example config (no blank first field)", () => {
    for (const type of [
      "agent",
      "httpRequest",
      "sqlQuery",
      "rssRead",
      "wait",
      "humanApproval",
    ] as const) {
      const cfg = defaultConfigFor(type);
      expect(cfg, type).toBeTruthy();
      expect(Object.keys(cfg ?? {}).length, type).toBeGreaterThan(0);
    }
  });
});
