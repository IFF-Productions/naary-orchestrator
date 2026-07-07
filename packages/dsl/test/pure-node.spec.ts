import { describe, expect, it } from "vitest";
import type { NodeDef } from "../src/types";
import { isPureNode, runPureNode } from "../src/pure-node";

describe("isPureNode", () => {
  it("distinguishes pure nodes from activity/control nodes", () => {
    for (const t of ["set", "text", "if", "switch", "filter", "number"]) {
      expect(isPureNode(t)).toBe(true);
    }
    for (const t of [
      "agent",
      "httpRequest",
      "sqlQuery",
      "wait",
      "humanApproval",
    ]) {
      expect(isPureNode(t)).toBe(false);
    }
  });
});

describe("runPureNode", () => {
  it("runs a set node, resolving {{ templates }} + fieldBindings from ctx", () => {
    const ctx = { start: { name: "Alice" }, up: { output: { id: 7 } } };
    const node: NodeDef = {
      id: "s",
      type: "set",
      config: {
        fields: { greeting: "Hi {{ start.name }}" },
        fieldBindings: { ref: { from: "up", path: "output.id" } },
      },
    };
    expect(runPureNode(node, ctx)).toEqual({ greeting: "Hi Alice", ref: 7 });
  });

  it("throws for a non-pure node type", () => {
    expect(() => runPureNode({ id: "a", type: "agent" }, {})).toThrow(
      /not a pure node/,
    );
  });
});
