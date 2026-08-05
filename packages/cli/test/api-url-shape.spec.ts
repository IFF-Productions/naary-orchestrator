import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiClient, ApiError, buildUrl } from "../src/client";
import { DEFAULT_API_URL } from "../src/config";

/**
 * The CLI's default `apiUrl` has to compose with the prefix the client appends, against the
 * routes the server actually serves. `client.spec.ts` can't see that: it asserts the URL the
 * client *builds*, with no server to be right or wrong against, so it stayed green while the
 * default (`http://localhost:3000`, the API's own port) produced `/api/v1/runs` — a path
 * nothing serves. This spec closes that seam with real sockets: the fixtures below reproduce
 * the two deployment shapes, and the client talks to them over real HTTP.
 *
 * The route table is the load-bearing part, so it mirrors production exactly:
 *   - `apps/api/src/v1/*.controller.ts` declare `@Controller("v1/runs")` — no `/api`;
 *   - `apps/api/src/main.ts` calls no `setGlobalPrefix`, so nothing adds one at boot.
 * Hence the "API" fixture serves `/v1/runs` and 404s everything else, and the "web" fixture
 * applies the same rewrite as `apps/web/nginx.conf` (`^/api/(.*)` → `/$1`) before dispatching
 * to that identical table.
 */
function dispatch(pathname: string): { status: number; body: string } {
  if (pathname === "/v1/runs") {
    return { status: 200, body: JSON.stringify({ items: [{ id: "r1" }] }) };
  }
  return { status: 404, body: JSON.stringify({ message: "Cannot GET" }) };
}

/** A server standing in for the API container: serves `/v1/*` verbatim, no rewriting. */
function directApiServer(): http.Server {
  return http.createServer((req, res) => {
    const { status, body } = dispatch(
      new URL(req.url ?? "/", "http://x").pathname,
    );
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body);
  });
}

/** A server standing in for nginx in front of the SPA: strips a leading `/api`, then dispatches. */
function proxyServer(): http.Server {
  return http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://x").pathname;
    const rewritten = pathname.replace(/^\/api(?=\/|$)/, "");
    const { status, body } = dispatch(rewritten);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body);
  });
}

/** Listen on an ephemeral port — a fixed one would collide on the shared CI runner. */
async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe("the /api/v1 prefix only resolves behind a stripping proxy", () => {
  const api = directApiServer();
  const web = proxyServer();
  let apiOrigin = "";
  let webOrigin = "";

  beforeAll(async () => {
    apiOrigin = await listen(api);
    webOrigin = await listen(web);
  });
  afterAll(async () => {
    await new Promise<void>((r) => api.close(() => r()));
    await new Promise<void>((r) => web.close(() => r()));
  });

  it("reaches a real 200 when apiUrl is a web origin (the shape the prefix assumes)", async () => {
    const client = new ApiClient({ apiUrl: webOrigin, token: "nry_test" });
    await expect(client.request("/runs")).resolves.toEqual({
      items: [{ id: "r1" }],
    });
  });

  /**
   * This is the regression itself, pinned as behaviour rather than as a string: aimed straight
   * at the API — with no proxy to strip `/api` — every request 404s. Any future default that
   * points at the API's own port therefore cannot work, and this test says why.
   */
  it("404s when apiUrl is the API itself, because nothing strips the /api segment", async () => {
    const client = new ApiClient({ apiUrl: apiOrigin, token: "nry_test" });
    const err = await client.request("/runs").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
    // The route the API *does* serve, proving the fixture is not simply serving nothing.
    const res = await fetch(`${apiOrigin}/v1/runs`);
    expect(res.status).toBe(200);
  });

  it("ships a default that lands on the local web origin, not the API port", () => {
    // 8081 is the `web` (nginx) service in docker-compose.yml, documented in the root README
    // as the local web app URL. 3000 is the API — the value that made the default unusable.
    expect(DEFAULT_API_URL).toBe("http://localhost:8081");
    expect(buildUrl(DEFAULT_API_URL, "/runs")).toBe(
      "http://localhost:8081/api/v1/runs",
    );
  });
});
