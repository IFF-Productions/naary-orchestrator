import { describe, expect, it, vi } from "vitest";
import { isPublicEmbedPath, publicCors } from "../src/common/public-cors";

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
