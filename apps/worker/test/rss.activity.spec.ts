import { beforeEach, describe, expect, it, vi } from "vitest";
import { BlockedEgressError } from "@naary/connections";
import { __rssDeps, callRssRead } from "../src/temporal/activities";

const meta = { tenantId: "t-1", executionId: "e-1", nodeId: "n-1" };

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Feed</title>
  <item><title>First</title><link>https://x.co/1</link><description>one</description><guid>g1</guid><pubDate>Mon, 01 Jan 2024</pubDate></item>
  <item><title>Second</title><link>https://x.co/2</link><description>two</description><guid>g2</guid></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry><title>Alpha</title><link href="https://x.co/a"/><summary>a</summary><id>id-a</id><updated>2024</updated></entry>
</feed>`;

const fetchMock = vi.fn();
const assertEgressAllowed = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  assertEgressAllowed.mockReset().mockResolvedValue(new URL("https://x.co/f"));
  __rssDeps.fetch = fetchMock as never;
  __rssDeps.assertEgressAllowed = assertEgressAllowed as never;
});

describe("callRssRead", () => {
  it("parses RSS 2.0 into normalized items (egress checked first)", async () => {
    fetchMock.mockResolvedValue({ text: async () => RSS });
    const r = await callRssRead(
      { url: "https://x.co/feed.xml" },
      undefined,
      meta,
    );
    expect(assertEgressAllowed).toHaveBeenCalledWith("https://x.co/feed.xml");
    expect(r.status).toBe("ok");
    expect(r.count).toBe(2);
    expect(r.items[0]).toEqual({
      title: "First",
      link: "https://x.co/1",
      summary: "one",
      published: "Mon, 01 Jan 2024",
      id: "g1",
    });
  });

  it("parses Atom (link href, summary, id)", async () => {
    fetchMock.mockResolvedValue({ text: async () => ATOM });
    const r = await callRssRead({ url: "https://x.co/atom" }, undefined, meta);
    expect(r.count).toBe(1);
    expect(r.items[0]).toMatchObject({
      title: "Alpha",
      link: "https://x.co/a",
      id: "id-a",
    });
  });

  it("a blocked host (SSRF) → non-retryable, never fetches", async () => {
    assertEgressAllowed.mockRejectedValue(
      new BlockedEgressError("host resolves to a private/reserved address"),
    );
    const err = await callRssRead(
      { url: "http://169.254.169.254/latest" },
      undefined,
      meta,
    ).catch((e) => e);
    expect(err.nonRetryable).toBe(true);
    expect(err.type).toBe("EGRESS_BLOCKED");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
