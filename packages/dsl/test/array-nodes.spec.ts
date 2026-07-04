import { describe, expect, it } from "vitest";
import { resolveAggregate, resolveFilter } from "../src/array-nodes";
import type { AggregateNodeConfig, FilterNodeConfig } from "../src/types";

const ctx = {
  users: {
    rows: [
      { name: "Ada", active: true, age: 36 },
      { name: "Bo", active: false, age: 20 },
      { name: "Cy", active: true, age: 41 },
    ],
  },
  scalar: { rows: 5 },
};

describe("resolveFilter", () => {
  it("keeps items whose per-item predicate holds (path is item-relative)", () => {
    const config: FilterNodeConfig = {
      from: "users",
      path: "rows",
      condition: { path: "active", op: "eq", value: true },
    };
    expect(resolveFilter(config, ctx)).toEqual([
      { name: "Ada", active: true, age: 36 },
      { name: "Cy", active: true, age: 41 },
    ]);
  });

  it("supports gt and returns [] for a non-array source", () => {
    expect(
      resolveFilter(
        {
          from: "users",
          path: "rows",
          condition: { path: "age", op: "gt", value: 30 },
        },
        ctx,
      ),
    ).toHaveLength(2);
    expect(
      resolveFilter(
        {
          from: "scalar",
          path: "rows",
          condition: { path: "x", op: "exists" },
        },
        ctx,
      ),
    ).toEqual([]);
  });
});

describe("resolveAggregate", () => {
  const base = { from: "users", path: "rows" } as const;

  it("collect (with and without field)", () => {
    expect(
      resolveAggregate({ ...base, operation: "collect", field: "name" }, ctx),
    ).toEqual({ result: ["Ada", "Bo", "Cy"] });
    expect(
      (
        resolveAggregate({ ...base, operation: "collect" }, ctx)
          .result as unknown[]
      ).length,
    ).toBe(3);
  });

  it("count / sum / first / last", () => {
    expect(resolveAggregate({ ...base, operation: "count" }, ctx)).toEqual({
      result: 3,
    });
    expect(
      resolveAggregate({ ...base, operation: "sum", field: "age" }, ctx),
    ).toEqual({ result: 97 });
    expect(
      resolveAggregate({ ...base, operation: "first", field: "name" }, ctx),
    ).toEqual({ result: "Ada" });
    expect(
      resolveAggregate({ ...base, operation: "last", field: "name" }, ctx),
    ).toEqual({ result: "Cy" });
  });

  it("min / max / avg over a numeric field (non-numeric ignored)", () => {
    expect(
      resolveAggregate({ ...base, operation: "min", field: "age" }, ctx),
    ).toEqual({ result: 20 });
    expect(
      resolveAggregate({ ...base, operation: "max", field: "age" }, ctx),
    ).toEqual({ result: 41 });
    expect(
      resolveAggregate({ ...base, operation: "avg", field: "age" }, ctx).result,
    ).toBeCloseTo(32.33, 2);
    // no numeric values → undefined
    expect(
      resolveAggregate({ ...base, operation: "min", field: "name" }, ctx),
    ).toEqual({ result: undefined });
  });

  it("guards a non-array source (count 0, collect [])", () => {
    expect(
      resolveAggregate(
        { from: "scalar", path: "rows", operation: "count" },
        ctx,
      ),
    ).toEqual({ result: 0 });
    expect(
      resolveAggregate(
        { from: "scalar", path: "rows", operation: "first" },
        ctx,
      ),
    ).toEqual({ result: undefined });
  });
});
