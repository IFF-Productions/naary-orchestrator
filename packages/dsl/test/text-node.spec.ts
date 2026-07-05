import { describe, expect, it } from "vitest";
import { resolveText } from "../src/text-node";
import type { TextNodeConfig } from "../src/types";

const ctx = {
  n: { s: "  Hello, World  ", list: ["a", "b", "c"], csv: "x,y,z" },
};
const run = (c: Partial<TextNodeConfig>) =>
  resolveText({ from: "n", ...c } as TextNodeConfig, ctx).result;

describe("resolveText", () => {
  it("upper / lower / trim / length", () => {
    expect(run({ operation: "upper", path: "s" })).toBe("  HELLO, WORLD  ");
    expect(run({ operation: "lower", path: "s" })).toBe("  hello, world  ");
    expect(run({ operation: "trim", path: "s" })).toBe("Hello, World");
    expect(run({ operation: "trim", path: "csv" })).toBe("x,y,z");
    expect(run({ operation: "length", path: "csv" })).toBe(5);
  });

  it("split / join", () => {
    expect(run({ operation: "split", path: "csv", separator: "," })).toEqual([
      "x",
      "y",
      "z",
    ]);
    expect(run({ operation: "join", path: "list", separator: "-" })).toBe(
      "a-b-c",
    );
  });

  it("substring", () => {
    expect(run({ operation: "substring", path: "csv", start: 2 })).toBe("y,z");
    expect(run({ operation: "substring", path: "csv", start: 0, end: 3 })).toBe(
      "x,y",
    );
  });

  it("replace (literal and regex, with group refs)", () => {
    expect(
      run({ operation: "replace", path: "csv", search: ",", replacement: "|" }),
    ).toBe("x|y|z");
    expect(
      run({
        operation: "replace",
        path: "s",
        search: "\\s+",
        replacement: "_",
        useRegex: true,
      }),
    ).toBe("_Hello,_World_");
  });

  it("regexExtract (whole match + capture group; no match → null)", () => {
    expect(
      run({ operation: "regexExtract", path: "csv", search: "[a-z]" }),
    ).toBe("x");
    expect(
      run({
        operation: "regexExtract",
        path: "s",
        search: "(\\w+), (\\w+)",
        group: 2,
      }),
    ).toBe("World");
    expect(
      run({ operation: "regexExtract", path: "csv", search: "\\d+" }),
    ).toBeNull();
  });

  it("invalid regex fails closed to null (never throws)", () => {
    expect(
      run({ operation: "regexExtract", path: "csv", search: "(" }),
    ).toBeNull();
    expect(
      run({
        operation: "replace",
        path: "csv",
        search: "(",
        replacement: "x",
        useRegex: true,
      }),
    ).toBeNull();
  });
});
