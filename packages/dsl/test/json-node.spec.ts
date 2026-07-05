import { describe, expect, it } from "vitest";
import { resolveJson } from "../src/json-node";
import type { JsonNodeConfig } from "../src/types";

const ctx = {
  a: { text: '{"x":1,"y":[2,3]}', obj: { x: 1, y: [2, 3] }, bad: "{nope" },
};
const run = (c: Partial<JsonNodeConfig>) =>
  resolveJson({ from: "a", ...c } as JsonNodeConfig, ctx);

describe("resolveJson", () => {
  it("parse: JSON text → value", () => {
    expect(run({ operation: "parse", path: "text" })).toEqual({
      x: 1,
      y: [2, 3],
    });
  });

  it("stringify: value → { json } (compact by default, indent when set)", () => {
    expect(run({ operation: "stringify", path: "obj" })).toEqual({
      json: '{"x":1,"y":[2,3]}',
    });
    const pretty = run({ operation: "stringify", path: "obj", indent: 2 }) as {
      json: string;
    };
    expect(pretty.json).toContain("\n");
    expect(JSON.parse(pretty.json)).toEqual({ x: 1, y: [2, 3] });
  });

  it("round-trips stringify → parse", () => {
    const s = run({ operation: "stringify", path: "obj" }) as { json: string };
    expect(
      resolveJson({ operation: "parse", from: "s" } as JsonNodeConfig, {
        s: s.json,
      }),
    ).toEqual({ x: 1, y: [2, 3] });
  });

  it("parse throws on malformed JSON (a handleable node failure)", () => {
    expect(() => run({ operation: "parse", path: "bad" })).toThrow();
  });
});
