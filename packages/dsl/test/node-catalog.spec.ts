import { describe, expect, it } from "vitest";
import {
  CONDITION_OPS,
  NODE_CATALOG,
  NODE_TYPES,
  nodeCatalogPrompt,
} from "../src/node-catalog";

describe("node catalog", () => {
  it("covers every node type (exhaustive) with a summary and a valid group", () => {
    expect(NODE_TYPES.length).toBeGreaterThanOrEqual(42);
    for (const [type, e] of Object.entries(NODE_CATALOG)) {
      expect(e.summary, `${type} summary`).toBeTruthy();
      expect(e.group, `${type} group`).toBeTruthy();
    }
    // exactly one entry group per graph — the entry flags exist
    const entries = NODE_TYPES.filter((t) => NODE_CATALOG[t].entry);
    expect(entries).toEqual(
      expect.arrayContaining([
        "start",
        "webhookTrigger",
        "errorTrigger",
        "pollTrigger",
        "scheduleTrigger",
      ]),
    );
  });

  it("includes the nodes the old hand-written list was missing", () => {
    for (const t of [
      "switch",
      "if",
      "csv",
      "json",
      "htmlExtract",
      "number",
      "encode",
      "hash",
      "random",
      "sqlExec",
      "text",
      "scheduleTrigger",
    ] as const) {
      expect(NODE_TYPES).toContain(t);
    }
  });

  it("exposes all 15 condition operators", () => {
    expect(CONDITION_OPS).toEqual(
      expect.arrayContaining([
        "eq",
        "neq",
        "in",
        "exists",
        "gt",
        "lt",
        "gte",
        "lte",
        "contains",
        "notContains",
        "startsWith",
        "endsWith",
        "regex",
        "isEmpty",
        "notEmpty",
      ]),
    );
    expect(CONDITION_OPS).toHaveLength(15);
  });

  it("nodeCatalogPrompt renders every node, marking entry nodes", () => {
    const prompt = nodeCatalogPrompt();
    for (const t of NODE_TYPES) expect(prompt).toContain(`"${t}"`);
    expect(prompt).toContain('"start" [entry]');
    expect(prompt).toContain('"switch"');
  });
});
