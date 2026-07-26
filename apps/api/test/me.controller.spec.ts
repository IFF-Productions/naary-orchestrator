import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { MeController } from "../src/auth/me.controller";

describe("MeController", () => {
  it("returns the authenticated principal (tenantId + subject)", () => {
    const c = new MeController();
    expect(c.me({ tenantId: "t-1", subject: "u-9" })).toEqual({
      tenantId: "t-1",
      subject: "u-9",
      // Platform-operator flag (PLATFORM_OPERATORS allowlist) — false here: unset in tests, and this
      // principal has no email anyway. Sent so the SPA can hide operator-only nav.
      isOperator: false,
    });
  });

  it("omits subject for API-token principals", () => {
    const c = new MeController();
    expect(c.me({ tenantId: "t-2" })).toEqual({
      tenantId: "t-2",
      subject: undefined,
      // An API-token principal carries no email, so it can never be an operator.
      isOperator: false,
    });
  });

  it("returns this tenant's flags at their code defaults when the provider is unconfigured", async () => {
    // No FLAGSMITH key ⇒ the OpenFeature Noop provider ⇒ every catalog flag = its safe default.
    const c = new MeController();
    const { flags } = await c.flags({ tenantId: "t-1" });
    expect(flags).toEqual({
      "chat-rag": false,
      "new-canvas-inspector": false,
      // Kill-switch: safe default is ON so the gated feature stays visible without a provider.
      "canvas-import-tools": true,
    });
  });
});
