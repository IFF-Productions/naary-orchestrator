import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatAdminController } from "../src/chat/chat-admin.controller";

// Covers the ONE place env resolution runs at chat registration (@EnvironmentSel() → resolveEnvId);
// the ingress/exec specs bypass it by reading endpoint.environmentId directly.
function makeController(resolved: string) {
  const chats = {
    createEndpoint: vi
      .fn()
      .mockResolvedValue({ chatId: "c-1", chatPath: "/c/c-1" }),
  };
  const environments = { resolveEnvId: vi.fn().mockResolvedValue(resolved) };
  const controller = new ChatAdminController(
    chats as never,
    environments as never,
  );
  return { controller, chats, environments };
}

describe("ChatAdminController.register (env binding)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resolves the caller's env selector and binds the new chat to it", async () => {
    const { controller, chats, environments } = makeController("env-uat");
    await controller.register("t-1", { workflowId: "wk" } as never, "env-uat");
    expect(environments.resolveEnvId).toHaveBeenCalledWith("t-1", "env-uat");
    // the RESOLVED env id reaches the service, not the raw selector/default
    expect(chats.createEndpoint).toHaveBeenCalledWith("t-1", "env-uat", "wk");
  });

  it("falls back to the tenant default when no env selector is present", async () => {
    const { controller, chats, environments } = makeController("env-default");
    await controller.register("t-1", { workflowId: "wk" } as never, undefined);
    expect(environments.resolveEnvId).toHaveBeenCalledWith("t-1", undefined);
    expect(chats.createEndpoint).toHaveBeenCalledWith(
      "t-1",
      "env-default",
      "wk",
    );
  });
});
