import { describe, expect, it } from "vitest";
import { resolveSet } from "../src/set-node";
import type { SetNodeConfig } from "../src/types";

const ctx = {
  trigger: { userId: "u-7", nested: { count: 3 } },
  agent: { output: { category: "billing" } },
};

describe("resolveSet", () => {
  it("returns the static fields verbatim when there are no bindings", () => {
    const config: SetNodeConfig = {
      fields: { status: "reviewed", n: 1, tags: ["a", "b"] },
    };
    expect(resolveSet(config, ctx)).toEqual({
      status: "reviewed",
      n: 1,
      tags: ["a", "b"],
    });
  });

  it("returns {} when there are no fields and no bindings", () => {
    expect(resolveSet({}, ctx)).toEqual({});
  });

  it("fills fields from upstream outputs via dotted bindings", () => {
    const config: SetNodeConfig = {
      fields: { status: "new" },
      fieldBindings: {
        userId: { from: "trigger", path: "userId" },
        category: { from: "agent", path: "output.category" },
      },
    };
    expect(resolveSet(config, ctx)).toEqual({
      status: "new",
      userId: "u-7",
      category: "billing",
    });
  });

  it("a binding overrides a static field of the same name", () => {
    const config: SetNodeConfig = {
      fields: { userId: "STATIC" },
      fieldBindings: { userId: { from: "trigger", path: "userId" } },
    };
    expect(resolveSet(config, ctx)).toEqual({ userId: "u-7" });
  });

  it("writes nested paths, creating intermediate objects", () => {
    const config: SetNodeConfig = {
      fieldBindings: {
        "meta.count": { from: "trigger", path: "nested.count" },
      },
    };
    expect(resolveSet(config, ctx)).toEqual({ meta: { count: 3 } });
  });

  it("a missing upstream path resolves to undefined (never throws)", () => {
    const config: SetNodeConfig = {
      fieldBindings: { x: { from: "trigger", path: "does.not.exist" } },
    };
    expect(resolveSet(config, ctx)).toEqual({ x: undefined });
  });

  it("does not mutate the source config.fields (deep clone)", () => {
    const fields = { nested: { keep: 1 } };
    const config: SetNodeConfig = {
      fields,
      fieldBindings: { "nested.added": { from: "trigger", path: "userId" } },
    };
    resolveSet(config, ctx);
    expect(fields).toEqual({ nested: { keep: 1 } }); // original untouched
  });
});

describe("resolveSet — prototype pollution guard (#591)", () => {
  it("never walks a __proto__ / constructor / prototype path segment", () => {
    const before = ({} as Record<string, unknown>).polluted;
    const out = resolveSet(
      {
        fieldBindings: {
          "__proto__.polluted": { from: "up", path: "v" },
          "constructor.prototype.x": { from: "up", path: "v" },
        },
      } as unknown as SetNodeConfig,
      { up: { v: "PWNED" } },
    );
    // Object.prototype is untouched — the classic assertion.
    expect(({} as Record<string, unknown>).polluted).toBe(before);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // And the malicious keys produced no own-property output either.
    expect(Object.keys(out)).not.toContain("__proto__");
  });

  it("still resolves a legitimate nested path", () => {
    const out = resolveSet(
      { fieldBindings: { "a.b": { from: "up", path: "v" } } } as unknown as SetNodeConfig,
      { up: { v: 7 } },
    );
    expect(out).toEqual({ a: { b: 7 } });
  });
});
