import { beforeEach, describe, expect, it } from "vitest";
import { __setObjectStore, MemoryObjectStore } from "@naary/storage";
import { callHtmlExtract } from "../src/temporal/activities";

const meta = { tenantId: "t-1", executionId: "e-1", nodeId: "n-1" };

const HTML = `
  <html><body>
    <h1>  Widget Pro  </h1>
    <span class="price">$42.00</span>
    <a class="more" href="/details">Details</a>
    <ul><li>a</li><li>b</li><li>c</li></ul>
  </body></html>`;

beforeEach(() => {
  __setObjectStore(new MemoryObjectStore());
});

describe("callHtmlExtract", () => {
  it("extracts text (trimmed), inner HTML, and attributes by CSS selector", async () => {
    const r = await callHtmlExtract(
      {
        extractions: [
          { key: "title", selector: "h1", return: "text" },
          { key: "price", selector: ".price", return: "text" },
          {
            key: "link",
            selector: "a.more",
            return: "attribute",
            attribute: "href",
          },
        ],
      },
      HTML,
      meta,
    );
    expect(r.status).toBe("ok");
    expect(r.result).toEqual({
      title: "Widget Pro",
      price: "$42.00",
      link: "/details",
    });
  });

  it("returns all matches as an array when `all` is set", async () => {
    const r = await callHtmlExtract(
      { extractions: [{ key: "items", selector: "li", all: true }] },
      HTML,
      meta,
    );
    expect(r.result.items).toEqual(["a", "b", "c"]);
  });

  it("yields null for a selector that matches nothing (not a throw)", async () => {
    const r = await callHtmlExtract(
      { extractions: [{ key: "missing", selector: ".nope" }] },
      HTML,
      meta,
    );
    expect(r.result).toEqual({ missing: null });
  });

  it("skips rows with an empty key or selector", async () => {
    const r = await callHtmlExtract(
      {
        extractions: [
          { key: "", selector: "h1" },
          { key: "t", selector: "" },
          { key: "ok", selector: "h1" },
        ],
      },
      HTML,
      meta,
    );
    expect(r.result).toEqual({ ok: "Widget Pro" });
  });
});
