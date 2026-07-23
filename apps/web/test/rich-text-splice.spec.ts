import { describe, expect, it } from "vitest";
import {
  fieldToken,
  insert,
  link,
  wrap,
  wrapList,
} from "../src/lib/rich-text-splice";

describe("wrap", () => {
  it("wraps the selection and keeps the inner text selected", () => {
    // "Hi world" — select "world" (3..8)
    const r = wrap("Hi world", 3, 8, "<strong>", "</strong>");
    expect(r.value).toBe("Hi <strong>world</strong>");
    // selection now brackets "world" (after the opening tag)
    expect(r.value.slice(r.selStart, r.selEnd)).toBe("world");
  });

  it("wraps an empty selection (caret) into empty tags", () => {
    const r = wrap("ab", 1, 1, "<em>", "</em>");
    expect(r.value).toBe("a<em></em>b");
    expect(r.selStart).toBe(r.selEnd); // still collapsed, between the tags
    expect(r.value.slice(0, r.selStart)).toBe("a<em>");
  });
});

describe("insert", () => {
  it("collapses the caret after the snippet without a select range", () => {
    const r = insert("ab", 1, 1, "X");
    expect(r.value).toBe("aXb");
    expect(r.selStart).toBe(2);
    expect(r.selEnd).toBe(2);
  });

  it("selects the given relative range within the snippet", () => {
    const r = insert("ab", 1, 1, "[url]", [1, 4]);
    expect(r.value).toBe("a[url]b");
    expect(r.value.slice(r.selStart, r.selEnd)).toBe("url");
  });

  it("replaces a non-empty selection", () => {
    const r = insert("a123b", 1, 4, "X");
    expect(r.value).toBe("aXb");
  });
});

describe("wrapList", () => {
  it("makes one <li> per selected line", () => {
    const r = wrapList("one\ntwo", 0, 7, "ul");
    expect(r.value).toBe("<ul>\n  <li>one</li>\n  <li>two</li>\n</ul>");
    // whole block selected
    expect(r.value.slice(r.selStart, r.selEnd)).toBe(r.value);
  });

  it("uses a placeholder item for an empty selection", () => {
    const r = wrapList("", 0, 0, "ol");
    expect(r.value).toBe("<ol>\n  <li>item</li>\n</ol>");
  });
});

describe("link", () => {
  it("wraps the selection as an <a> with the URL pre-selected", () => {
    const r = link("see here", 4, 8); // "here"
    expect(r.value).toBe('see <a href="https://example.com">here</a>');
    // the URL (not the label) is selected so the author types over it
    expect(r.value.slice(r.selStart, r.selEnd)).toBe("https://example.com");
  });

  it("uses 'link' as the label for an empty selection", () => {
    const r = link("", 0, 0);
    expect(r.value).toBe('<a href="https://example.com">link</a>');
  });
});

describe("fieldToken", () => {
  it("inserts {{ field }} with 'field' pre-selected", () => {
    const r = fieldToken("Hi ", 3, 3);
    expect(r.value).toBe("Hi {{ field }}");
    expect(r.value.slice(r.selStart, r.selEnd)).toBe("field");
  });
});
