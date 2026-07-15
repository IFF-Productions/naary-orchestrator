import { beforeEach, describe, expect, it, vi } from "vitest";
import { FormsAdminController } from "../src/forms/forms-admin.controller";

// Covers the ONE place env resolution runs at form registration (@EnvironmentSel() → resolveEnvId);
// the ingress/exec specs bypass it by reading endpoint.environmentId directly.
function makeController(resolved: string) {
  const forms = {
    createEndpoint: vi
      .fn()
      .mockResolvedValue({ formId: "f-1", formPath: "/forms/f-1" }),
  };
  const environments = { resolveEnvId: vi.fn().mockResolvedValue(resolved) };
  const controller = new FormsAdminController(
    forms as never,
    environments as never,
  );
  return { controller, forms, environments };
}

describe("FormsAdminController.register (env binding)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resolves the caller's env selector and binds the new form to it", async () => {
    const { controller, forms, environments } = makeController("env-uat");
    await controller.register("t-1", { workflowId: "wk" } as never, "env-uat");
    expect(environments.resolveEnvId).toHaveBeenCalledWith("t-1", "env-uat");
    // the RESOLVED env id reaches the service, not the raw selector/default
    expect(forms.createEndpoint).toHaveBeenCalledWith("t-1", "env-uat", "wk");
  });

  it("falls back to the tenant default when no env selector is present", async () => {
    const { controller, forms, environments } = makeController("env-default");
    await controller.register("t-1", { workflowId: "wk" } as never, undefined);
    expect(environments.resolveEnvId).toHaveBeenCalledWith("t-1", undefined);
    expect(forms.createEndpoint).toHaveBeenCalledWith(
      "t-1",
      "env-default",
      "wk",
    );
  });
});
