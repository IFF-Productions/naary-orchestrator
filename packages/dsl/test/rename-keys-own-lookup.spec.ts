import { describe, expect, it } from "vitest";
import { resolveRenameKeys } from "../src/rename-keys";

/**
 * #766 — `resolveRenameKeys` read the PROTOTYPE CHAIN when resolving a rename target.
 *
 * `rename` is a plain object from graph config, so `rename["constructor"]` doesn't miss: it returns
 * `Object.prototype.constructor`, a FUNCTION, which stringifies into an output key of
 * `"function Object() { [native code] }"`. No hostile config required — any upstream object carrying a
 * literal `constructor` field triggers it, and arbitrary API responses do (`{"constructor": "Acme Ltd"}`
 * is an ordinary record).
 *
 * The fix is OPT-IN because this function runs in deterministic workflow code; the caller gates it on
 * `wf.patched("rename-keys-own-lookup-v1")` so in-flight runs replay on the old path. Both branches are
 * therefore tested: the legacy one to pin what histories still depend on, the fixed one for new runs.
 */
const ctxWith = (value: unknown) => ({ n1: value });

/** Source objects are built with JSON.parse: in an object LITERAL, `__proto__:` is special-cased by
 *  the spec and sets the prototype instead of creating an own key, so a literal would test nothing. */
const parse = (json: string) => JSON.parse(json) as Record<string, unknown>;

describe("the legacy path (what in-flight histories replay)", () => {
  /** Pinned, not endorsed: this is the buggy output the gate exists to preserve for old runs. */
  it("mangles a `constructor` source key into a stringified function", () => {
    const out = resolveRenameKeys(
      { from: "n1" },
      ctxWith(parse('{"constructor":"Acme Ltd"}')),
    );
    expect(Object.keys(out)).toHaveLength(1);
    expect(Object.keys(out)[0]).toMatch(/function Object/);
    expect(out.constructor).not.toBe("Acme Ltd");
  });

  it("still renames and drops ordinary keys correctly", () => {
    const out = resolveRenameKeys(
      { from: "n1", rename: { a: "alpha" }, drop: ["b"] },
      ctxWith({ a: 1, b: 2, c: 3 }),
    );
    expect(out).toEqual({ alpha: 1, c: 3 });
  });
});

describe("the fixed path (ownRenameLookup)", () => {
  const fix = { ownRenameLookup: true };

  it("passes a `constructor` source key straight through", () => {
    const out = resolveRenameKeys(
      { from: "n1" },
      ctxWith(parse('{"constructor":"Acme Ltd"}')),
      fix,
    );
    // Own-key read, so the value survives under its real name.
    expect(Object.keys(out)).toEqual(["constructor"]);
    expect(JSON.parse(JSON.stringify(out))).toEqual({
      constructor: "Acme Ltd",
    });
  });

  it.each(["__proto__", "prototype", "constructor"])(
    "passes the source key %s through without consulting the prototype chain",
    (key) => {
      const out = resolveRenameKeys(
        { from: "n1" },
        ctxWith(parse(`{"${key}":"kept"}`)),
        fix,
      );
      // Round-tripped, because that's how the value reaches Temporal and the next node.
      expect(JSON.parse(JSON.stringify(out))).toEqual({ [key]: "kept" });
    },
  );

  /**
   * The accumulator is null-prototype, so a rename TARGET of `__proto__` creates an own key instead of
   * setting the prototype and silently discarding the value. (The save gate from #761 now rejects such
   * a target for NEW graphs; this covers one saved before it.)
   */
  it("does not discard a value renamed TO __proto__", () => {
    const out = resolveRenameKeys(
      { from: "n1", rename: { a: "__proto__" } },
      ctxWith({ a: "kept" }),
      fix,
    );
    // The EXPECTED side must also be built with JSON.parse — `{ __proto__: "kept" }` as a literal sets
    // the prototype and creates no key, so it would compare against `{}`. The same trap this fix is about.
    expect(JSON.parse(JSON.stringify(out))).toEqual(
      parse('{"__proto__":"kept"}'),
    );
    expect(Object.keys(out)).toEqual(["__proto__"]);
  });

  it("renames and drops ordinary keys exactly as before", () => {
    const out = resolveRenameKeys(
      { from: "n1", rename: { a: "alpha" }, drop: ["b"] },
      ctxWith({ a: 1, b: 2, c: 3 }),
      fix,
    );
    expect({ ...out }).toEqual({ alpha: 1, c: 3 });
  });

  it("keeps drop winning over rename", () => {
    const out = resolveRenameKeys(
      { from: "n1", rename: { a: "alpha" }, drop: ["a"] },
      ctxWith({ a: 1, c: 3 }),
      fix,
    );
    expect({ ...out }).toEqual({ c: 3 });
  });

  it("still yields {} for a non-object source", () => {
    for (const bad of [null, 42, "str", [1, 2]]) {
      expect({
        ...resolveRenameKeys({ from: "n1" }, ctxWith(bad), fix),
      }).toEqual({});
    }
  });

  /** Building the output must not leak into Object.prototype. */
  it("leaves Object.prototype untouched", () => {
    resolveRenameKeys(
      { from: "n1", rename: { a: "__proto__" } },
      ctxWith({ a: { polluted: true } }),
      fix,
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("the two paths differ ONLY on prototype-chain keys", () => {
  /**
   * The property that makes the patch gate safe to remove eventually: for ordinary data the fixed path
   * is byte-identical to the legacy one, so the only histories that can diverge are those whose source
   * data actually contained one of these names.
   */
  it("agrees on ordinary data", () => {
    const cases: Record<string, unknown>[] = [
      { a: 1, b: "two", c: null },
      { nested: { x: 1 }, list: [1, 2, 3] },
      {},
    ];
    for (const src of cases) {
      const legacy = resolveRenameKeys(
        { from: "n1", rename: { a: "alpha" } },
        ctxWith(src),
      );
      const fixed = resolveRenameKeys(
        { from: "n1", rename: { a: "alpha" } },
        ctxWith(src),
        { ownRenameLookup: true },
      );
      expect({ ...fixed }).toEqual({ ...legacy });
    }
  });
});
