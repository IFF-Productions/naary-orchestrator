import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebhooksController } from "../src/webhooks/webhooks.controller";

// The admin `register` path is the ONE place env RESOLUTION runs at registration time
// (@EnvironmentSel() → resolveEnvId). The ingress/exec unit tests bypass it by reading
// endpoint.environmentId directly, so cover it explicitly here.
function makeController(resolved: string) {
  const webhooks = {
    createEndpoint: vi
      .fn()
      .mockResolvedValue({ endpointId: "ep-1", ingressPath: "/hooks/ep-1" }),
  };
  const environments = {
    resolveEnvId: vi.fn().mockResolvedValue(resolved),
  };
  const controller = new WebhooksController(
    webhooks as never,
    environments as never,
  );
  return { controller, webhooks, environments };
}

describe("WebhooksController.register (env binding)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resolves the caller's env selector and binds the new endpoint to it", async () => {
    const { controller, webhooks, environments } = makeController("env-uat");
    // @EnvironmentSel() yields the principal's selector — for a UAT-bound token, "env-uat".
    await controller.register(
      "t-1",
      { workflowId: "wk", provider: "github" } as never,
      "env-uat",
    );
    expect(environments.resolveEnvId).toHaveBeenCalledWith("t-1", "env-uat");
    // the RESOLVED env id is what reaches the service — not the tenant default
    expect(webhooks.createEndpoint).toHaveBeenCalledWith(
      "t-1",
      "env-uat",
      "wk",
      "github",
    );
  });

  it("falls back to the tenant default when no env selector is present", async () => {
    // resolveEnvId(_, undefined) → the tenant's default env (its documented contract).
    const { controller, webhooks, environments } =
      makeController("env-default");
    await controller.register(
      "t-1",
      { workflowId: "wk", provider: "github" } as never,
      undefined,
    );
    expect(environments.resolveEnvId).toHaveBeenCalledWith("t-1", undefined);
    expect(webhooks.createEndpoint).toHaveBeenCalledWith(
      "t-1",
      "env-default",
      "wk",
      "github",
    );
  });
});
