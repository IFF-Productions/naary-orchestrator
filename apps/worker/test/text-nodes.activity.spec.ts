import { beforeEach, describe, expect, it } from "vitest";
import { __setObjectStore, MemoryObjectStore } from "@naary/storage";
import { callCsv, callHtml, callMarkdown } from "../src/temporal/activities";

const meta = { tenantId: "t-1", executionId: "e-1", nodeId: "n-1" };
beforeEach(() => __setObjectStore(new MemoryObjectStore()));

describe("callHtml", () => {
  const html =
    '<ul><li class="x">A</li><li class="x">B</li></ul><a href="/z">z</a>';
  it("extracts text by selector", async () => {
    const r = await callHtml({ selector: "li.x" }, html, meta);
    expect(r.result).toEqual({ items: ["A", "B"] });
  });
  it("extracts an attribute", async () => {
    const r = await callHtml(
      { selector: "a", return: "attribute", attribute: "href" },
      html,
      meta,
    );
    expect(r.result).toEqual({ items: ["/z"] });
  });
});

describe("callMarkdown", () => {
  it("toHtml renders markdown", async () => {
    const r = await callMarkdown({ operation: "toHtml" }, "# Hi", meta);
    expect((r.result as { text: string }).text).toContain("<h1>Hi</h1>");
  });
  it("toMarkdown converts HTML", async () => {
    const r = await callMarkdown(
      { operation: "toMarkdown" },
      "<h1>Hi</h1>",
      meta,
    );
    expect((r.result as { text: string }).text).toContain("# Hi");
  });
});

describe("callCsv", () => {
  it("parse: CSV text → rows (header)", async () => {
    const r = await callCsv({ operation: "parse" }, "a,b\n1,2\n3,4", meta);
    expect(r.result).toEqual({
      rows: [
        { a: "1", b: "2" },
        { a: "3", b: "4" },
      ],
    });
  });
  it("build: rows → { csv }", async () => {
    const r = await callCsv(
      { operation: "build" },
      [
        { a: 1, b: 2 },
        { a: 3, b: 4 },
      ],
      meta,
    );
    expect((r.result as { csv: string }).csv).toBe("a,b\r\n1,2\r\n3,4");
  });
});
