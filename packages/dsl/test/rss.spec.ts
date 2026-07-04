import { describe, expect, it } from "vitest";
import { resolveRss } from "../src/rss";
import type { RssReadNodeConfig } from "../src/types";

describe("resolveRss", () => {
  it("passes the static url through", () => {
    const config: RssReadNodeConfig = { url: "https://x.co/feed.xml" };
    expect(resolveRss(config, {})).toEqual({
      url: "https://x.co/feed.xml",
      timeoutMs: undefined,
    });
  });

  it("a urlBinding overrides the static url", () => {
    const config: RssReadNodeConfig = {
      url: "https://static.co/feed",
      urlBinding: { from: "trigger", path: "feedUrl" },
    };
    expect(
      resolveRss(config, { trigger: { feedUrl: "https://bound.co/rss" } }).url,
    ).toBe("https://bound.co/rss");
  });

  it("falls back to the static url when the binding is empty/non-string", () => {
    const config: RssReadNodeConfig = {
      url: "https://static.co/feed",
      urlBinding: { from: "trigger", path: "missing" },
    };
    expect(resolveRss(config, { trigger: {} }).url).toBe(
      "https://static.co/feed",
    );
  });
});
