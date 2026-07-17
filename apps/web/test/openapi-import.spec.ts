import type { ApiOperation, OpenApiSummary } from "@naary/dsl";
import { describe, expect, it } from "vitest";
import { joinUrl, toConfig } from "../src/canvas/openapi-import";

describe("joinUrl", () => {
  it("joins base + path without double slashes", () => {
    expect(joinUrl("https://api.x/v1", "/things")).toBe(
      "https://api.x/v1/things",
    );
    expect(joinUrl("https://api.x/v1/", "/things")).toBe(
      "https://api.x/v1/things",
    );
    expect(joinUrl("https://api.x/v1", "things")).toBe(
      "https://api.x/v1/things",
    );
  });
  it("returns the path alone when there is no base URL", () => {
    expect(joinUrl(undefined, "/things")).toBe("/things");
  });
});

const op = (over: Partial<ApiOperation> = {}): ApiOperation => ({
  method: "GET",
  path: "/things/{id}",
  parameters: [],
  hasBody: false,
  ...over,
});
const summary = (over: Partial<OpenApiSummary> = {}): OpenApiSummary => ({
  operations: [],
  ...over,
});

describe("toConfig", () => {
  it("applies method + full URL (base + path)", () => {
    const c = toConfig(summary({ baseUrl: "https://api.x/v1" }), op());
    expect(c.method).toBe("GET");
    expect(c.url).toBe("https://api.x/v1/things/{id}"); // path param kept as placeholder
  });

  it("seeds query + header params as BLANK keys, dropping path/body params", () => {
    const c = toConfig(
      summary({ baseUrl: "https://api.x" }),
      op({
        method: "POST",
        path: "/things/{id}",
        parameters: [
          { name: "id", in: "path", required: true },
          { name: "q", in: "query", required: false },
          { name: "verbose", in: "query", required: false },
          { name: "X-Trace", in: "header", required: false },
        ],
      }),
    );
    expect(c.query).toEqual({ q: "", verbose: "" });
    expect(c.headers).toEqual({ "X-Trace": "" });
    // `id` (path) is not a query/header key — it lives in the URL placeholder.
    expect(c.query).not.toHaveProperty("id");
  });

  it("omits query/headers entirely when the operation declares none", () => {
    const c = toConfig(summary({ baseUrl: "https://api.x" }), op());
    expect(c.query).toBeUndefined();
    expect(c.headers).toBeUndefined();
  });
});
