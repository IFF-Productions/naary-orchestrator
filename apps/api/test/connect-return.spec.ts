import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectReturnUrl } from "../src/connections/connect-return";

// The return URL is built ONLY from server config (APP_BASE_URL / CORS_ORIGINS), never a request
// param — these tests pin that (open-redirect safety) plus the success/error query shape.
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ["APP_BASE_URL", "CORS_ORIGINS"]) saved[k] = process.env[k];
  delete process.env.APP_BASE_URL;
  delete process.env.CORS_ORIGINS;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("connectReturnUrl", () => {
  it("uses APP_BASE_URL and flags success", () => {
    process.env.APP_BASE_URL = "https://app.example.com";
    expect(connectReturnUrl({ ok: true, tab: "apps" })).toBe(
      "https://app.example.com/app/integrations?tab=apps&connected=1",
    );
  });

  it("flags failure with a coarse error code", () => {
    process.env.APP_BASE_URL = "https://app.example.com/";
    expect(
      connectReturnUrl({ ok: false, tab: "providers", error: "oauth" }),
    ).toBe(
      "https://app.example.com/app/integrations?tab=providers&connect_error=oauth",
    );
  });

  it("falls back to the first http(s) CORS origin when APP_BASE_URL is unset", () => {
    process.env.CORS_ORIGINS = "not-a-url,https://spa.example.com,http://x";
    expect(connectReturnUrl({ ok: true, tab: "apps" })).toBe(
      "https://spa.example.com/app/integrations?tab=apps&connected=1",
    );
  });

  it("emits a same-origin RELATIVE redirect when no base is configured", () => {
    expect(connectReturnUrl({ ok: true, tab: "apps" })).toBe(
      "/app/integrations?tab=apps&connected=1",
    );
  });

  it("defaults the error code to 1 when unspecified", () => {
    expect(connectReturnUrl({ ok: false, tab: "apps" })).toBe(
      "/app/integrations?tab=apps&connect_error=1",
    );
  });
});
