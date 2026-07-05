import { describe, expect, it } from "vitest";
import { resolveNumber } from "../src/number-node";
import type { NumberNodeConfig } from "../src/types";

const ctx = { n: { x: 10, y: 3, price: 19.99 } };
const run = (c: Partial<NumberNodeConfig>) =>
  resolveNumber(c as NumberNodeConfig, ctx).result;

describe("resolveNumber", () => {
  it("binary ops on static operands", () => {
    expect(run({ operation: "add", a: 2, b: 3 })).toBe(5);
    expect(run({ operation: "subtract", a: 10, b: 4 })).toBe(6);
    expect(run({ operation: "multiply", a: 6, b: 7 })).toBe(42);
    expect(run({ operation: "divide", a: 9, b: 2 })).toBe(4.5);
    expect(run({ operation: "modulo", a: 10, b: 3 })).toBe(1);
    expect(run({ operation: "power", a: 2, b: 10 })).toBe(1024);
  });

  it("resolves operands from upstream bindings (override static)", () => {
    expect(
      run({
        operation: "multiply",
        aBinding: { from: "n", path: "x" },
        bBinding: { from: "n", path: "y" },
      }),
    ).toBe(30);
    // binding wins over static
    expect(
      run({
        operation: "add",
        a: 100,
        aBinding: { from: "n", path: "x" },
        b: 5,
      }),
    ).toBe(15);
  });

  it("unary ops (round honors precision)", () => {
    expect(
      run({ operation: "round", aBinding: { from: "n", path: "price" } }),
    ).toBe(20);
    expect(
      run({
        operation: "round",
        aBinding: { from: "n", path: "price" },
        precision: 1,
      }),
    ).toBe(20);
    expect(run({ operation: "floor", a: 4.9 })).toBe(4);
    expect(run({ operation: "ceil", a: 4.1 })).toBe(5);
    expect(run({ operation: "abs", a: -7 })).toBe(7);
  });

  it("divide-by-zero → Infinity; non-numeric → NaN (propagates)", () => {
    expect(run({ operation: "divide", a: 1, b: 0 })).toBe(Infinity);
    expect(Number.isNaN(run({ operation: "add", a: 1 }))).toBe(true); // b undefined → NaN
  });
});
