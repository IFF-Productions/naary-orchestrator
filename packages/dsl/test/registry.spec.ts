import { describe, expect, it } from "vitest";
import {
  hasConcreteConfig,
  nodeConfigJsonSchema,
  nodeConfigSchema,
  validateGraphConfigs,
  type HttpRequestConfig,
} from "../src/registry";
import { NODE_TYPES } from "../src/node-catalog";
import type { HttpRequestNodeConfig, NodeType } from "../src/types";

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

  it("is not fooled by prototype-chain keys in a hostile deserialized type", () => {
    // A graph parsed from untrusted JSON could carry type:"__proto__"/"constructor". These live
    // on Object.prototype, so `in`/`[type]` would report/return them — the own-property check must not.
    for (const evil of ["__proto__", "constructor", "toString"] as NodeType[]) {
      expect(hasConcreteConfig(evil), evil).toBe(false);
      // still returns a usable zod schema (the permissive fallback), never a prototype method
      expect(nodeConfigSchema(evil).safeParse({}).success, evil).toBe(true);
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

describe("validateGraphConfigs (save gate — lenient on missing, strict on present)", () => {
  const graph = (
    nodes: { id: string; type: NodeType; config?: Record<string, unknown> }[],
  ) => ({ nodes });

  it("passes an in-progress DRAFT with required fields still unfilled", () => {
    // httpRequest requires method+url at runtime, but a half-built node must still SAVE.
    const errs = validateGraphConfigs(
      graph([{ id: "h", type: "httpRequest", config: { method: "GET" } }]),
    );
    expect(errs).toEqual([]);
  });

  it("rejects a PRESENT value of the wrong type / bad enum", () => {
    const errs = validateGraphConfigs(
      graph([
        { id: "h", type: "httpRequest", config: { method: "FETCH", url: 42 } },
      ]),
    );
    expect(errs).toHaveLength(1);
    expect(errs[0].nodeId).toBe("h");
    expect(errs[0].issues.map((i) => i.path).sort()).toEqual(["method", "url"]);
  });

  it("does NOT reject unmodeled extra keys (strip-mode, no false positive)", () => {
    const errs = validateGraphConfigs(
      graph([
        {
          id: "h",
          type: "httpRequest",
          config: { method: "GET", url: "https://x", _uiNote: "draft" },
        },
      ]),
    );
    expect(errs).toEqual([]);
  });

  it("skips config-less nodes and reports nodeId/type on failure", () => {
    const errs = validateGraphConfigs(
      graph([
        { id: "e", type: "end" },
        { id: "w", type: "wait", config: { durationSeconds: "soon" } },
      ]),
    );
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatchObject({ nodeId: "w", nodeType: "wait" });
  });
});
