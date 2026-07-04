import { describe, expect, it } from "vitest";
import {
  defaultConfigFor,
  NODE_DESCRIPTION,
  NODE_KINDS,
} from "../src/lib/graph-model";

describe("node registry (simpler-UX metadata)", () => {
  it("every node kind has a non-empty, plain-language description", () => {
    for (const k of NODE_KINDS) {
      expect(k.description, k.type).toBeTruthy();
      expect(k.description.length, k.type).toBeGreaterThan(10);
    }
  });

  it("NODE_DESCRIPTION covers every kind in the palette", () => {
    for (const k of NODE_KINDS) {
      expect(NODE_DESCRIPTION[k.type]).toBe(k.description);
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
