import { describe, expect, it } from "vitest";
import {
  hasConcreteConfig,
  nodeConfigJsonSchema,
  nodeConfigSchema,
  type HttpRequestConfig,
} from "../src/registry";
import { NODE_TYPES } from "../src/node-catalog";
import type { HttpRequestNodeConfig } from "../src/types";

describe("node config registry (TYPED-DSL Phase 1)", () => {
  it("resolves a schema for EVERY node type (concrete or permissive fallback)", () => {
    for (const type of NODE_TYPES) {
      expect(() => nodeConfigSchema(type), type).not.toThrow();
    }
  });

  it("marks config-bearing nodes concrete and config-less nodes as fallback", () => {
    // every config-bearing node type now has a concrete, parity-guarded schema
    for (const t of NODE_TYPES) {
      const configLess =
        t === "webhookTrigger" || t === "errorTrigger" || t === "end";
      expect(hasConcreteConfig(t), t).toBe(!configLess);
    }
  });

  it("emits CONCRETE JSON Schema for a migrated node (the empty-{} bug, fixed at the source)", () => {
    const schema = nodeConfigJsonSchema("httpRequest") as {
      type?: string;
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(schema.type).toBe("object");
    // real properties — NOT an empty {} that Anthropic's validator rejects
    expect(Object.keys(schema.properties ?? {})).toEqual(
      expect.arrayContaining(["method", "url", "headers", "connectionId"]),
    );
    expect(schema.required).toEqual(expect.arrayContaining(["method", "url"]));
    // DEEP guard: not one empty `{}` sub-schema survives anywhere (Anthropic rejects those).
    const emptyObjects: string[] = [];
    const walk = (n: unknown, path: string) => {
      if (Array.isArray(n))
        return n.forEach((x, i) => walk(x, `${path}[${i}]`));
      if (n && typeof n === "object") {
        if (Object.keys(n as object).length === 0) emptyObjects.push(path);
        else
          for (const [k, v] of Object.entries(n as object))
            walk(v, `${path}.${k}`);
      }
    };
    walk(schema, "$");
    expect(emptyObjects, "empty {} sub-schemas present").toEqual([]);
  });

  it("ENFORCES config at runtime — valid parses, invalid rejects", () => {
    const good = {
      method: "GET",
      url: "https://api.example.com/x",
      headers: { "X-Trace": "1" },
    };
    expect(nodeConfigSchema("httpRequest").safeParse(good).success).toBe(true);

    // a typo the untyped `Record<string, unknown>` would have let through
    const bad = { methdo: "GET", url: 42 };
    expect(nodeConfigSchema("httpRequest").safeParse(bad).success).toBe(false);
  });

  it("the inferred type aligns with the hand-written interface (Phase-2 replacement is sound)", () => {
    // Compile-time cross-check: one value that satisfies BOTH the schema-inferred type
    // and the existing interface — proving the schema is a faithful port of the interface.
    const cfg = {
      method: "POST",
      url: "https://api.example.com",
      body: { hello: "world" },
    } satisfies HttpRequestConfig satisfies HttpRequestNodeConfig;
    expect(nodeConfigSchema("httpRequest").safeParse(cfg).success).toBe(true);
  });
});
