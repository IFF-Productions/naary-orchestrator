import type { ExecutionContext } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import {
  isHooksIngressReq,
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

describe("isHooksIngressReq (webhook flood cap)", () => {
  it("true for POST /hooks/:endpointId (external webhook ingress)", () => {
    expect(
      isHooksIngressReq({
        method: "POST",
        originalUrl: "/hooks/whk_123",
        params: { endpointId: "whk_123" },
      }),
    ).toBe(true);
  });

  it("true for POST /hooks/resume/:workflowId (wait-webhook resume), query string ignored", () => {
    expect(
      isHooksIngressReq({
        method: "POST",
        originalUrl: "/hooks/resume/wf-1?token=abc",
        params: { workflowId: "wf-1" },
      }),
    ).toBe(true);
  });

  it("false for the authenticated webhook MANAGEMENT routes despite the same param name", () => {
    // POST /tenants/:id/webhooks/:endpointId/rotate-secret — same `endpointId` param,
    // different path: must NOT land in the public bucket.
    expect(
      isHooksIngressReq({
        method: "POST",
        originalUrl: "/tenants/t1/webhooks/whk_123/rotate-secret",
        params: { id: "t1", endpointId: "whk_123" },
      }),
    ).toBe(false);
  });

  it("false for authenticated run ops that carry a workflowId", () => {
    expect(
      isHooksIngressReq({
        method: "POST",
        originalUrl: "/tenants/t1/executions/wf-1/cancel",
        params: { id: "t1", workflowId: "wf-1" },
      }),
    ).toBe(false);
  });

  it("false for non-POST and for a missing param", () => {
    expect(
      isHooksIngressReq({
        method: "GET",
        originalUrl: "/hooks/whk_123",
        params: { endpointId: "whk_123" },
      }),
    ).toBe(false);
    expect(
      isHooksIngressReq({ method: "POST", originalUrl: "/hooks/", params: {} }),
    ).toBe(false);
    expect(isHooksIngressReq({ method: "POST" })).toBe(false);
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

  it("keys webhook ingress per endpointId / resume per workflowId", () => {
    expect(publicEndpointKey({ params: { endpointId: "whk_1" } })).toBe(
      "endpoint:whk_1",
    );
    expect(publicEndpointKey({ params: { workflowId: "wf-1" } })).toBe(
      "endpoint:wf-1",
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

  it("does NOT skip public webhook ingress (throttler applies)", () => {
    expect(
      skipUnlessPublicSubmit(
        ctx("http", {
          method: "POST",
          originalUrl: "/hooks/whk_1",
          params: { endpointId: "whk_1" },
        }),
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
