import { describe, expect, it } from "vitest";
import { resolveHttpRequest } from "../src/http-request";
import type { HttpRequestNodeConfig } from "../src/types";

const ctx = {
  trigger: { userId: "u-7", host: "api.example.com" },
  agent: { output: { query: "refunds" } },
};

describe("resolveHttpRequest", () => {
  it("passes static config through unchanged when there are no bindings", () => {
    const config: HttpRequestNodeConfig = {
      method: "POST",
      url: "https://api.example.com/things",
      headers: { Accept: "application/json" },
      query: { page: "1" },
      body: { kind: "demo" },
      connectionId: "my-api",
      costUsd: 0.001,
    };
    expect(resolveHttpRequest(config, ctx)).toEqual({
      method: "POST",
      url: "https://api.example.com/things",
      headers: { Accept: "application/json" },
      query: { page: "1" },
      body: { kind: "demo" },
      connectionId: "my-api",
      failOnErrorStatus: undefined,
      timeoutMs: undefined,
      costUsd: 0.001,
    });
  });

  it("applies bindings at dotted field paths (url, body.*, query.*, headers.*)", () => {
    const config: HttpRequestNodeConfig = {
      method: "POST",
      url: "https://placeholder/",
      body: { static: true },
      argumentBindings: {
        "body.userId": { from: "trigger", path: "userId" },
        "query.q": { from: "agent", path: "output.query" },
        "headers.X-User": { from: "trigger", path: "userId" },
      },
    };
    const resolved = resolveHttpRequest(config, ctx);
    expect(resolved.body).toEqual({ static: true, userId: "u-7" });
    expect(resolved.query).toEqual({ q: "refunds" });
    expect(resolved.headers).toEqual({ "X-User": "u-7" });
  });

  it("lets a whole-field binding overwrite a static value (e.g. url)", () => {
    const config: HttpRequestNodeConfig = {
      method: "GET",
      url: "https://placeholder/",
      argumentBindings: {
        url: { from: "trigger", path: "host" },
      },
    };
    expect(resolveHttpRequest(config, ctx).url).toBe("api.example.com");
  });

  it("does not mutate the source config's headers/query/body objects", () => {
    const headers = { Accept: "application/json" };
    const body = { static: true };
    const config: HttpRequestNodeConfig = {
      method: "POST",
      url: "https://x/",
      headers,
      body,
      argumentBindings: {
        "headers.X-User": { from: "trigger", path: "userId" },
        "body.userId": { from: "trigger", path: "userId" },
      },
    };
    const resolved = resolveHttpRequest(config, ctx);
    expect(headers).toEqual({ Accept: "application/json" }); // original untouched
    expect(body).toEqual({ static: true }); // body binding must not write back
    expect(resolved.body).toEqual({ static: true, userId: "u-7" });
  });
});
