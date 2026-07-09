import { describe, expect, it } from "vitest";
import { __setObjectStore, MemoryObjectStore } from "@naary/storage";
import { callMarkdown, htmlToMarkdown } from "../src/temporal/activities";

describe("htmlToMarkdown (pure converter)", () => {
  it("renders headings, paragraphs, and inline emphasis", () => {
    const md = htmlToMarkdown(
      "<h1>Title</h1><p>Hello <strong>bold</strong> and <em>italic</em>.</p>",
    );
    expect(md).toBe("# Title\n\nHello **bold** and _italic_.");
  });

  it("renders links with href", () => {
    expect(htmlToMarkdown('<p>See <a href="/x">here</a></p>')).toBe(
      "See [here](/x)",
    );
  });

  it("renders unordered and ordered lists", () => {
    expect(htmlToMarkdown("<ul><li>a</li><li>b</li></ul>")).toBe("- a\n- b");
    expect(htmlToMarkdown("<ol><li>a</li><li>b</li></ol>")).toBe("1. a\n2. b");
  });

  it("renders inline code and fenced pre blocks", () => {
    expect(htmlToMarkdown("<p>run <code>npm i</code></p>")).toBe("run `npm i`");
    expect(htmlToMarkdown("<pre>line1\nline2</pre>")).toBe(
      "```\nline1\nline2\n```",
    );
  });

  it("renders blockquote and hr", () => {
    expect(htmlToMarkdown("<blockquote>quoted</blockquote>")).toBe("> quoted");
    expect(htmlToMarkdown("<hr>")).toBe("---");
  });

  it("collapses whitespace; div is a block, span/unknown tags stay inline", () => {
    const md = htmlToMarkdown(
      "<div>  a\n\n   b  </div><span>c</span><custom>d</custom>",
    );
    // <div> is a block (blank line after); <span> and the unknown <custom> fall through inline.
    expect(md).toBe("a b\n\ncd");
  });

  it("is total on empty / plain input", () => {
    expect(htmlToMarkdown("")).toBe("");
    expect(htmlToMarkdown("just text")).toBe("just text");
  });
});

describe("callMarkdown activity", () => {
  it("returns { markdown } and costs nothing", async () => {
    __setObjectStore(new MemoryObjectStore());
    const res = await callMarkdown("<h1>Hi</h1><p>there</p>", {
      tenantId: "t-1",
      executionId: "e-1",
      nodeId: "n-1",
    });
    expect(res.status).toBe("ok");
    expect(res.result).toEqual({ markdown: "# Hi\n\nthere" });
    expect(res.costUsd).toBe(0);
  });
});
