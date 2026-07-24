import type { ExecutionContext } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import {
  isPublicSubmitReq,
  publicEndpointKey,
  skipUnlessPublicSubmit,
} from "../src/throttle/public-endpoint-throttler";

describe("isPublicSubmitReq (#616)", () => {
  it("true for POST /forms/:formId and POST /chat/:chatId", () => {
    expect(
      isPublicSubmitReq({ method: "POST", params: { formId: "f1" } }),
    ).toBe(true);
    expect(
      isPublicSubmitReq({ method: "POST", params: { chatId: "c1" } }),
    ).toBe(true);
  });

  it("false for GET (definition) even with the param", () => {
    expect(isPublicSubmitReq({ method: "GET", params: { formId: "f1" } })).toBe(
      false,
    );
  });

  it("false for a POST with no form/chat param (any other route)", () => {
    expect(isPublicSubmitReq({ method: "POST", params: { id: "x" } })).toBe(
      false,
    );
    expect(isPublicSubmitReq({ method: "POST", params: {} })).toBe(false);
    expect(isPublicSubmitReq({ method: "POST" })).toBe(false);
  });
});

describe("publicEndpointKey", () => {
  it("keys per endpoint id (distinct forms → distinct buckets)", () => {
    expect(publicEndpointKey({ params: { formId: "f1" } })).toBe("endpoint:f1");
    expect(publicEndpointKey({ params: { chatId: "c9" } })).toBe("endpoint:c9");
    expect(publicEndpointKey({ params: { formId: "f1" } })).not.toBe(
      publicEndpointKey({ params: { formId: "f2" } }),
    );
  });
});

describe("skipUnlessPublicSubmit", () => {
  const ctx = (type: string, req: unknown): ExecutionContext =>
    ({
      getType: () => type,
      switchToHttp: () => ({ getRequest: () => req }),
    }) as unknown as ExecutionContext;

  it("does NOT skip a public form/chat submit (throttler applies)", () => {
    expect(
      skipUnlessPublicSubmit(
        ctx("http", { method: "POST", params: { formId: "f1" } }),
      ),
    ).toBe(false);
  });

  it("SKIPS every other route (the per-endpoint throttler is scoped)", () => {
    expect(
      skipUnlessPublicSubmit(
        ctx("http", { method: "GET", params: { formId: "f1" } }),
      ),
    ).toBe(true);
    expect(
      skipUnlessPublicSubmit(ctx("http", { method: "POST", params: {} })),
    ).toBe(true);
  });

  it("SKIPS a non-http context", () => {
    expect(skipUnlessPublicSubmit(ctx("ws", {}))).toBe(true);
  });
});
