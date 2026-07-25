import { describe, expect, it, vi } from "vitest";
import {
  isPublicEmbedPath,
  makePublicCors,
  originAllowed,
  originHostname,
  parsePublicEmbedPath,
  publicCors,
} from "../src/common/public-cors";

describe("isPublicEmbedPath (#617 Slice 3)", () => {
  it("matches the public form/chat submit ingress (:id only)", () => {
    expect(isPublicEmbedPath("/forms/abc123")).toBe(true);
    expect(isPublicEmbedPath("/chat/xyz")).toBe(true);
    expect(isPublicEmbedPath("/forms/abc123/")).toBe(true);
  });
  it("does NOT match the authed admin list / other routes", () => {
    expect(isPublicEmbedPath("/forms")).toBe(false);
    expect(isPublicEmbedPath("/chat")).toBe(false);
    expect(isPublicEmbedPath("/forms/abc/extra")).toBe(false);
    expect(isPublicEmbedPath("/executions")).toBe(false);
    expect(isPublicEmbedPath("/tenants/t1/credentials")).toBe(false);
  });
});

function res() {
  return {
    headers: {} as Record<string, string>,
    statusCode: 0,
    ended: false,
    header(k: string, v: string) {
      this.headers[k] = v;
    },
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    end() {
      this.ended = true;
    },
  };
}

describe("publicCors", () => {
  it("sets ACAO:* on a public GET and calls next", () => {
    const r = res();
    const next = vi.fn();
    publicCors(
      { path: "/forms/abc", method: "GET" } as never,
      r as never,
      next,
    );
    expect(r.headers["Access-Control-Allow-Origin"]).toBe("*");
    expect(next).toHaveBeenCalled();
    expect(r.ended).toBe(false);
  });

  it("answers an OPTIONS preflight with 204 (no next)", () => {
    const r = res();
    const next = vi.fn();
    publicCors(
      { path: "/chat/abc", method: "OPTIONS" } as never,
      r as never,
      next,
    );
    expect(r.statusCode).toBe(204);
    expect(r.ended).toBe(true);
    expect(next).not.toHaveBeenCalled();
  });

  it("leaves non-public routes untouched (falls through to the app allowlist)", () => {
    const r = res();
    const next = vi.fn();
    publicCors(
      { path: "/executions", method: "GET" } as never,
      r as never,
      next,
    );
    expect(r.headers["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });
});

// ── #617: per-tenant embed-origin allowlist ────────────────────────────────────────────────
describe("parsePublicEmbedPath / originHostname / originAllowed (#617)", () => {
  it("parses the kind + opaque id (and nothing else)", () => {
    expect(parsePublicEmbedPath("/forms/abc")).toEqual({
      kind: "form",
      id: "abc",
    });
    expect(parsePublicEmbedPath("/chat/xyz/")).toEqual({
      kind: "chat",
      id: "xyz",
    });
    expect(parsePublicEmbedPath("/forms")).toBeNull();
    expect(parsePublicEmbedPath("/executions/abc")).toBeNull();
  });

  it("reduces an Origin to a lowercase hostname, rejecting non-http(s)", () => {
    expect(originHostname("https://Example.com")).toBe("example.com");
    expect(originHostname("http://example.com:3000")).toBe("example.com");
    expect(originHostname("null")).toBeNull();
    expect(originHostname("file:///tmp/x.html")).toBeNull();
    expect(originHostname("not a url")).toBeNull();
  });

  it("matches on hostname only — scheme/port are ignored (documented)", () => {
    const allow = ["example.com", "forms.example.com"];
    expect(originAllowed("https://example.com", allow)).toBe(true);
    expect(originAllowed("http://example.com:8080", allow)).toBe(true);
    expect(originAllowed("https://forms.example.com", allow)).toBe(true);
    // no wildcard/suffix matching — the same rule Turnstile's solved-hostname check uses
    expect(originAllowed("https://evil.com", allow)).toBe(false);
    expect(originAllowed("https://sub.example.com", allow)).toBe(false);
    expect(originAllowed("https://example.com.evil.com", allow)).toBe(false);
    expect(originAllowed(undefined, allow)).toBe(false);
  });
});

/** Drive the async (resolver-backed) middleware and let its microtasks settle. */
async function run(
  handler: ReturnType<typeof makePublicCors>,
  req: { path: string; method: string; headers?: Record<string, unknown> },
  r: ReturnType<typeof res>,
): Promise<{ next: ReturnType<typeof vi.fn> }> {
  const next = vi.fn();
  handler({ headers: {}, ...req } as never, r as never, next);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { next };
}

describe("makePublicCors with a per-tenant resolver (#617)", () => {
  const configured = makePublicCors(async () => ["example.com"]);

  it("reflects a CONFIGURED origin (never `*`) and always sets Vary: Origin", async () => {
    const r = res();
    const { next } = await run(
      configured,
      {
        path: "/forms/abc",
        method: "GET",
        headers: { origin: "https://example.com" },
      },
      r,
    );
    expect(r.headers["Access-Control-Allow-Origin"]).toBe(
      "https://example.com",
    );
    expect(r.headers.Vary).toBe("Origin");
    expect(next).toHaveBeenCalled();
  });

  it("REFUSES a non-allowlisted origin — no ACAO header at all (browser blocks)", async () => {
    const r = res();
    const { next } = await run(
      configured,
      {
        path: "/forms/abc",
        method: "GET",
        headers: { origin: "https://evil.com" },
      },
      r,
    );
    expect(r.headers["Access-Control-Allow-Origin"]).toBeUndefined();
    // Still Vary: Origin, so a cache can't serve the allowed origin's ACAO to this one.
    expect(r.headers.Vary).toBe("Origin");
    // The request itself is NOT blocked here: CORS is browser-side enablement, and Turnstile
    // + rate limits + the budget cap are what actually protect the endpoint.
    expect(next).toHaveBeenCalled();
  });

  it("refuses the preflight of a non-allowlisted origin (204, no ACAO)", async () => {
    const r = res();
    const { next } = await run(
      configured,
      {
        path: "/chat/abc",
        method: "OPTIONS",
        headers: { origin: "https://evil.com" },
      },
      r,
    );
    expect(r.statusCode).toBe(204);
    expect(r.ended).toBe(true);
    expect(r.headers["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(next).not.toHaveBeenCalled();
  });

  it("answers an allowlisted preflight with the reflected origin", async () => {
    const r = res();
    await run(
      configured,
      {
        path: "/chat/abc",
        method: "OPTIONS",
        headers: { origin: "http://example.com:5173" },
      },
      r,
    );
    expect(r.statusCode).toBe(204);
    expect(r.headers["Access-Control-Allow-Origin"]).toBe(
      "http://example.com:5173",
    );
  });

  it("NO configuration ⇒ permissive `*`, exactly as before (nothing breaks)", async () => {
    const none = makePublicCors(async () => []);
    const r = res();
    const { next } = await run(
      none,
      {
        path: "/forms/abc",
        method: "GET",
        headers: { origin: "https://anywhere.example" },
      },
      r,
    );
    expect(r.headers["Access-Control-Allow-Origin"]).toBe("*");
    expect(next).toHaveBeenCalled();
  });

  it("a resolver failure fails PERMISSIVE (a DB blip must not break live embeds)", async () => {
    const broken = makePublicCors(async () => {
      throw new Error("db down");
    });
    const r = res();
    const { next } = await run(
      broken,
      {
        path: "/forms/abc",
        method: "GET",
        headers: { origin: "https://anywhere.example" },
      },
      r,
    );
    expect(r.headers["Access-Control-Allow-Origin"]).toBe("*");
    expect(next).toHaveBeenCalled();
  });

  it("a request with NO Origin gets no ACAO when the tenant configured domains", async () => {
    // Server-to-server / curl: there is no origin to reflect, and reflecting `*` would widen
    // what the tenant asked for. CORS is irrelevant to such a caller anyway.
    const r = res();
    const { next } = await run(
      configured,
      {
        path: "/forms/abc",
        method: "GET",
      },
      r,
    );
    expect(r.headers["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });

  it("ignores an opaque `null` origin (sandboxed iframe / file://)", async () => {
    const r = res();
    await run(
      configured,
      {
        path: "/forms/abc",
        method: "GET",
        headers: { origin: "null" },
      },
      r,
    );
    expect(r.headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  it("never consults the resolver for a non-embed path", async () => {
    const resolve = vi.fn(async () => ["example.com"]);
    const r = res();
    const { next } = await run(
      makePublicCors(resolve),
      {
        path: "/executions",
        method: "GET",
        headers: { origin: "https://example.com" },
      },
      r,
    );
    expect(resolve).not.toHaveBeenCalled();
    expect(r.headers["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });
});
