import { describe, expect, it } from "vitest";
import { prettyJson, shortTime, table, usd } from "../src/format";

describe("table", () => {
  it("returns '' for no rows", () => {
    expect(table([], [["A", "a"]])).toBe("");
  });
  it("renders a header, a rule, and aligned columns", () => {
    const out = table(
      [
        { id: "r1", status: "running" },
        { id: "r22", status: "ok" },
      ],
      [
        ["ID", "id"],
        ["STATUS", "status"],
      ],
    );
    const lines = out.split("\n");
    expect(lines[0]).toBe("ID   STATUS");
    expect(lines[1]).toMatch(/^-+ +-+$/);
    expect(lines[2]).toContain("r1");
    expect(lines[3]).toContain("r22");
  });
  it("renders blank for missing keys", () => {
    // `b` is declared but absent from the row — that is the case under test. Declaring it
    // optional on T is what lets the column list stay well-typed; the old `as Array<[string,
    // "a" | "b"]>` cast was a type error (T inferred as `{ a: string }`, so `"b"` is not
    // `keyof T`) that nothing checked before #1099.
    const out = table<{ a: string; b?: string }>(
      [{ a: "x" }],
      [
        ["A", "a"],
        ["B", "b"],
      ],
    );
    expect(out.split("\n")[2].trim()).toBe("x");
  });
});

describe("prettyJson", () => {
  it("pretty-prints and treats undefined as null", () => {
    expect(prettyJson({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(prettyJson(undefined)).toBe("null");
  });
});

describe("shortTime / usd", () => {
  it("drops milliseconds from an ISO timestamp", () => {
    expect(shortTime("2026-07-16T10:20:30.123Z")).toBe("2026-07-16T10:20:30Z");
  });
  it("returns '' for missing time/cost", () => {
    expect(shortTime(undefined)).toBe("");
    expect(usd(undefined)).toBe("");
  });
  it("formats USD to 4 decimals", () => {
    expect(usd(0.5)).toBe("$0.5000");
  });
});
