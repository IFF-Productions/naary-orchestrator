import { beforeAll, describe, expect, it, vi } from "vitest";
import { UnauthorizedException } from "@nestjs/common";
import { ApprovalsPublicController } from "../src/executions/approvals-public.controller";
import { mintApprovalToken } from "../src/executions/approval-token";

beforeAll(() => {
  process.env.ENCRYPTION_KEY = "0".repeat(64);
});

function make() {
  const executions = {
    promptByWorkflowId: vi
      .fn()
      .mockResolvedValue({
        awaiting: true,
        title: "Ship it?",
        instructions: null,
      }),
    decideByToken: vi.fn().mockResolvedValue(undefined),
  };
  return {
    controller: new ApprovalsPublicController(executions as never),
    executions,
  };
}

describe("ApprovalsPublicController (public, token-authed)", () => {
  it("GET returns the prompt when the token is valid", async () => {
    const { controller } = make();
    const out = await controller.prompt("wf-1", mintApprovalToken("wf-1"));
    expect(out).toMatchObject({ awaiting: true, title: "Ship it?" });
  });

  it("GET 401s on a bad/missing token (no state read)", async () => {
    const { controller, executions } = make();
    await expect(controller.prompt("wf-1", "bad")).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(executions.promptByWorkflowId).not.toHaveBeenCalled();
  });

  it("POST decide=approve signals approved with the reason", async () => {
    const { controller, executions } = make();
    const out = await controller.decide("wf-1", {
      token: mintApprovalToken("wf-1"),
      decision: "approve",
      comment: "lgtm",
    });
    expect(out).toEqual({ status: "approved" });
    expect(executions.decideByToken).toHaveBeenCalledWith("wf-1", true, "lgtm");
  });

  it("POST decide=reject signals NOT approved", async () => {
    const { controller, executions } = make();
    const out = await controller.decide("wf-1", {
      token: mintApprovalToken("wf-1"),
      decision: "reject",
    });
    expect(out).toEqual({ status: "rejected" });
    expect(executions.decideByToken).toHaveBeenCalledWith(
      "wf-1",
      false,
      undefined,
    );
  });

  it("POST 401s on a bad token — never signals the run", async () => {
    const { controller, executions } = make();
    await expect(
      controller.decide("wf-1", { token: "bad", decision: "approve" }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(executions.decideByToken).not.toHaveBeenCalled();
  });
});
