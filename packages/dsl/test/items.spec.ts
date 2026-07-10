import { describe, expect, it } from "vitest";
import { type Item, itemsJson, toItems } from "../src/items";

describe("toItems (normalize a legacy output into the items view)", () => {
  it("wraps a plain object as ONE item", () => {
    expect(toItems({ a: 1, b: 2 })).toEqual([{ json: { a: 1, b: 2 } }]);
  });

  it("wraps an ARRAY as one item whose json IS the array (does NOT split into N items)", () => {
    // Splitting an array into items is an explicit later concern (splitOut/aggregate), never an
    // implicit guess — this is the semantics the whole model depends on.
    expect(toItems([1, 2, 3])).toEqual([{ json: [1, 2, 3] }]);
  });

  it("wraps primitives and null/undefined uniformly (always length 1)", () => {
    expect(toItems("hi")).toEqual([{ json: "hi" }]);
    expect(toItems(42)).toEqual([{ json: 42 }]);
    expect(toItems(null)).toEqual([{ json: null }]);
    expect(toItems(undefined)).toEqual([{ json: undefined }]);
  });

  it("does NOT auto-detect an already-item-shaped array (always wraps)", () => {
    // A legacy output that happens to look like Item[] is still wrapped as one item — no detection.
    const looksLikeItems = [{ json: "a" }, { json: "b" }];
    expect(toItems(looksLikeItems)).toEqual([{ json: looksLikeItems }]);
  });
});

describe("itemsJson (project items → their json, order-preserving)", () => {
  it("maps a MULTI-item array to its json values (the case the program targets)", () => {
    // Constructed directly (not via toItems) so the multi-item path is actually exercised.
    const items: Item[] = [
      { json: { id: 1 } },
      { json: { id: 2 } },
      { json: 3 },
    ];
    expect(itemsJson(items)).toEqual([{ id: 1 }, { id: 2 }, 3]);
  });

  it("preserves order and is empty-safe", () => {
    expect(itemsJson([])).toEqual([]);
    expect(itemsJson([{ json: "x" }])).toEqual(["x"]);
  });

  it("round-trips a single value: itemsJson(toItems(x))[0] is x", () => {
    for (const x of [{ a: 1 }, [1, 2], "s", 0, null]) {
      expect(itemsJson(toItems(x))).toEqual([x]);
    }
  });
});
