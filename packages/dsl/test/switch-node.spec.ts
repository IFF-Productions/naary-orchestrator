import { describe, expect, it } from "vitest";
import { resolveSwitch } from "../src/switch-node";
import type { SwitchNodeConfig } from "../src/types";

const cfg: SwitchNodeConfig = {
  rules: [
    { name: "urgent", condition: { path: "t.priority", op: "gte", value: 5 } },
    {
      name: "billing",
      condition: { path: "t.topic", op: "contains", value: "invoice" },
    },
  ],
  fallback: "other",
};

describe("resolveSwitch", () => {
  it("returns the FIRST matching rule's name (order matters)", () => {
    // matches both rules; first (urgent) wins
    expect(
      resolveSwitch(cfg, { t: { priority: 9, topic: "invoice #4" } }),
    ).toEqual({ matched: "urgent" });
  });

  it("falls through to a later rule when earlier ones miss", () => {
    expect(
      resolveSwitch(cfg, { t: { priority: 1, topic: "invoice #4" } }),
    ).toEqual({ matched: "billing" });
  });

  it("returns the fallback when no rule matches", () => {
    expect(resolveSwitch(cfg, { t: { priority: 1, topic: "hello" } })).toEqual({
      matched: "other",
    });
  });

  it("defaults the fallback to 'default' when unset, and handles no rules", () => {
    expect(resolveSwitch({ rules: [] }, {})).toEqual({ matched: "default" });
  });
});
