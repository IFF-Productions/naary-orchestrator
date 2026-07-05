import { beforeEach, describe, expect, it } from "vitest";
import { __setObjectStore, MemoryObjectStore } from "@naary/storage";
import { callCsv } from "../src/temporal/activities";

const meta = { tenantId: "t-1", executionId: "e-1", nodeId: "n-1" };

beforeEach(() => {
  __setObjectStore(new MemoryObjectStore());
});

describe("callCsv", () => {
  it("parse: CSV text → rows keyed by header", async () => {
    const r = await callCsv(
      { operation: "parse" },
      "name,qty\nApple,3\nPear,5",
      meta,
    );
    expect(r.status).toBe("ok");
    expect(r.result).toEqual([
      { name: "Apple", qty: "3" },
      { name: "Pear", qty: "5" },
    ]);
  });

  it("parse without header → arrays; honors a custom delimiter", async () => {
    const r = await callCsv(
      { operation: "parse", header: false, delimiter: ";" },
      "a;b\nc;d",
      meta,
    );
    expect(r.result).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("build: rows → CSV text with a header row", async () => {
    const r = await callCsv(
      { operation: "build" },
      [
        { name: "Apple", qty: 3 },
        { name: "Pear", qty: 5 },
      ],
      meta,
    );
    expect((r.result as { csv: string }).csv).toBe(
      "name,qty\r\nApple,3\r\nPear,5",
    );
  });

  it("round-trips build → parse", async () => {
    const rows = [{ a: "1", b: "two" }];
    const built = await callCsv({ operation: "build" }, rows, meta);
    const parsed = await callCsv(
      { operation: "parse" },
      (built.result as { csv: string }).csv,
      meta,
    );
    expect(parsed.result).toEqual(rows);
  });

  it("quotes fields containing the delimiter (correct escaping)", async () => {
    const r = await callCsv(
      { operation: "build" },
      [{ note: "a,b", n: 1 }],
      meta,
    );
    expect((r.result as { csv: string }).csv).toContain('"a,b"');
  });
});
