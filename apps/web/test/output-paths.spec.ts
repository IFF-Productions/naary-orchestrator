/**
 * The inspector's single path enumerator: INPUT DATA rows (`flattenOutput`) and the
 * Parameters "References" chips (`leafPaths`) must offer the SAME paths. The bug this
 * guards: chips stopped at an array (`{{ n.body.incidents }}`) while the panel beside
 * them displayed `body.incidents.0.id`, so the picker could not produce the path the
 * author needed.
 */
import { describe, expect, it } from "vitest";
import { getByPath, resolveTemplateString } from "@naary/dsl";
import { flattenOutput, leafPaths } from "../src/screens/canvas/output-fields";

describe("leafPaths — arrays", () => {
  it("offers the reported PagerDuty path (acceptance)", () => {
    // The real report: wiring `acknowledge_incident` needed the incident id, and the
    // chips only offered the whole array.
    const pin = {
      status: 200,
      body: { incidents: [{ id: "PABC123", title: "API down" }] },
    };
    const paths = leafPaths(pin);
    expect(paths).toContain("body.incidents.0.id");
    // The array itself stays on offer — binding a whole array (forEach/splitOut) is legitimate.
    expect(paths).toContain("body.incidents");
    expect(paths).toContain("body.incidents.0.title");
    // And the offered path actually resolves against the same value the runtime reads.
    expect(getByPath(pin, "body.incidents.0.id")).toBe("PABC123");
  });

  it("enumerates an array of scalars", () => {
    expect(leafPaths({ tags: ["urgent", "p1"] })).toEqual(["tags", "tags.0"]);
  });

  it("emits no index for an empty array", () => {
    expect(leafPaths({ incidents: [] })).toEqual(["incidents"]);
  });

  it("descends nested arrays, index 0 at each level", () => {
    expect(leafPaths({ rows: [[{ v: 1 }]] })).toEqual([
      "rows",
      "rows.0",
      "rows.0.0.v",
    ]);
  });

  it("offers index 0 ONLY — a big array does not become a big chip list", () => {
    const items = Array.from({ length: 500 }, (_, i) => ({ id: `i-${i}` }));
    expect(leafPaths({ items })).toEqual(["items", "items.0.id"]);
  });

  it("stays bounded on a deeply nested object", () => {
    // 12 levels deep — depth-capped, so the walk stops well short of the leaf.
    let deep: unknown = { leaf: 1 };
    for (let i = 0; i < 12; i++) deep = { [`d${i}`]: deep };
    const paths = leafPaths(deep);
    expect(paths).toHaveLength(1);
    expect(paths[0].split(".").length).toBeLessThanOrEqual(6);
  });

  it("caps the total count and still reaches siblings after an array", () => {
    // Array expansion spends chip budget — a key declared AFTER an array must survive.
    const paths = leafPaths({
      incidents: [{ id: "P1", title: "t" }],
      after: "still-here",
    });
    expect(paths).toContain("incidents.0.id");
    expect(paths).toContain("after");
    // The cap is a hard stop on the walk, not a slice of a fully built list.
    expect(
      leafPaths({ incidents: Array.from({ length: 9 }, () => 1) }, 2),
    ).toHaveLength(2);
  });

  it("never suggests a prototype-chain key a pinned JSON sample can carry", () => {
    const pin = JSON.parse('{"ok":true,"__proto__":{"polluted":1}}');
    expect(leafPaths(pin)).toEqual(["ok"]);
  });

  it("is total: a scalar/array/null root yields no dotted path", () => {
    // The whole output IS the value — there is no honest path segment to invent, and the
    // References block falls back to a bare `{{ node }}` chip.
    expect(leafPaths("just a string")).toEqual([]);
    expect(leafPaths([{ id: 1 }])).toEqual([]);
    expect(leafPaths(null)).toEqual([]);
    expect(leafPaths(undefined)).toEqual([]);
  });
});

describe("flattenOutput ↔ leafPaths agree", () => {
  const pin = {
    status: 200,
    body: {
      incidents: [{ id: "PABC123", service: { name: "api" } }],
      count: 1,
    },
  };

  it("the chips offer every path the INPUT DATA rows display", () => {
    // INPUT DATA passes cap 8 (useDockDerivations); chips pass 24 — so the row set is a
    // prefix of the chip set, and every displayed row has a chip.
    const rows = flattenOutput(pin, "", 0, [], 8).map((r) => r.path);
    const chips = leafPaths(pin);
    expect(rows.length).toBeGreaterThan(0);
    for (const p of rows) expect(chips).toContain(p);
  });

  it("keeps the type chip for the array itself", () => {
    const rows = flattenOutput(pin);
    expect(rows.find((r) => r.path === "body.incidents")?.type).toBe(
      "array(1)",
    );
  });

  it("still labels a non-object root `output` for the dock", () => {
    // The dock's rows are a display of the value; only the copy-paste-able chips
    // (rootKey: null) must refuse to invent a segment.
    expect(flattenOutput("hello").map((r) => r.path)).toEqual(["output"]);
  });

  it("the dock's real cap (8) still reaches a key after two scalar arrays", () => {
    // Arrays of scalars now spend TWO rows (`tags` + `tags.0`) where they used to spend
    // one, and the dock walks at cap 8 — so the budget is the thing that could regress
    // it. A trailing top-level key must still be displayed.
    const rows = flattenOutput(
      { tags: ["a", "b"], labels: ["x"], id: 7, after: "still-here" },
      "",
      0,
      [],
      8,
    ).map((r) => r.path);
    expect(rows).toEqual([
      "tags",
      "tags.0",
      "labels",
      "labels.0",
      "id",
      "after",
    ]);
  });
});

describe("an offered path resolves the way a config field resolves it", () => {
  // The chip's promise is literally "put {{ node.path }} in any field", so assert against
  // the RUNTIME string-template resolver, not just `getByPath` underneath it.
  const ctx = {
    pagerduty: { body: { incidents: [{ id: "PABC123", urgency: "high" }] } },
  };

  it("resolves every chip the References block offers", () => {
    for (const path of leafPaths(ctx.pagerduty)) {
      expect(
        resolveTemplateString(`{{ pagerduty.${path} }}`, ctx),
      ).toBeDefined();
    }
  });

  it("resolves the reported indexed path, whole and embedded", () => {
    expect(
      resolveTemplateString("{{ pagerduty.body.incidents.0.id }}", ctx),
    ).toBe("PABC123");
    expect(
      resolveTemplateString("ack {{ pagerduty.body.incidents.0.id }} now", ctx),
    ).toBe("ack PABC123 now");
  });
});
