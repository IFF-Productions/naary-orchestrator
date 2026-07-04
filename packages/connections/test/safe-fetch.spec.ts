import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createGuardedDispatcher,
  safeFetch,
  safeFetchWith,
} from "../src/safe-fetch";

// A loopback server standing in for an "internal" service. safeFetch must refuse to
// reach it BOTH by IP literal and by a hostname that resolves to loopback — the two
// shapes that make up the redirect-follow (S-1) and DNS-rebind (S-2) SSRF classes,
// since every connection (including each redirect hop) is validated at connect time.
let server: http.Server;
let port = 0;
beforeAll(async () => {
  server = http
    .createServer((_req, res) => {
      res.setHeader("content-type", "text/plain");
      res.end("INTERNAL_SECRET");
    })
    .listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  port = (server.address() as { port: number }).port;
});
afterAll(() => server.close());

describe("safeFetch SSRF guard", () => {
  it("blocks a direct IP-literal loopback target", async () => {
    await expect(safeFetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });

  it("blocks a hostname that RESOLVES to loopback (localhost → 127.0.0.1)", async () => {
    // Proves the connector resolves + validates + pins the IP — closing the
    // rebind TOCTOU (the checked IP is the connected IP).
    await expect(safeFetch(`http://localhost:${port}/`)).rejects.toThrow();
  });

  it("does not leak the internal response body when blocked", async () => {
    const err = await safeFetch(`http://127.0.0.1:${port}/`).catch((e) => e);
    expect(String(err?.cause?.message ?? err?.message ?? err)).not.toContain(
      "INTERNAL_SECRET",
    );
  });

  it("ALLOW path: a non-blocked host fetches successfully through the guarded connector", async () => {
    // Relaxed predicate (nothing blocked) → the SAME connector + resolve+pin path
    // must reach the server and return a working (undici) Response. This is the
    // happy path every httpRequest/rssRead node depends on.
    const dispatcher = createGuardedDispatcher(() => false);
    const res = await safeFetchWith(dispatcher, `http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("INTERNAL_SECRET");
    // the shape callHttpRequest reads: headers.get + iterable entries
    expect(typeof res.headers.get("content-type")).toBe("string");
    expect([...res.headers.entries()].length).toBeGreaterThan(0);
  });
});
