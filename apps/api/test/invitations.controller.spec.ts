import "reflect-metadata";
import { ForbiddenException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthModule } from "../src/auth/auth.module";
import {
  AcceptInvitationController,
  InvitationsController,
} from "../src/invitations/invitations.controller";
import { InvitationsModule } from "../src/invitations/invitations.module";
import { MembershipModule } from "../src/membership/membership.module";
import { InvitationsService } from "../src/invitations/invitations.service";
import type { Principal } from "../src/auth/tenant.decorator";

const create = vi.fn();
const accept = vi.fn();
function makeControllers() {
  const svc = { create, accept } as unknown as InvitationsService;
  return {
    admin: new InvitationsController(svc),
    acceptCtl: new AcceptInvitationController(svc),
  };
}

beforeEach(() => {
  create.mockReset().mockResolvedValue({ id: "inv-1", token: "raw" });
  accept.mockReset().mockResolvedValue({ tenantId: "t-1", role: "member" });
});

describe("InvitationsController (create)", () => {
  it("passes the inviter's role + uid through to the service", async () => {
    const principal: Principal = {
      tenantId: "t-1",
      userId: "u-admin",
      role: "admin",
    };
    await makeControllers().admin.create(
      "t-1",
      { email: "a@b.co", role: "member" },
      principal,
    );
    expect(create).toHaveBeenCalledWith(
      "t-1",
      "a@b.co",
      "member",
      "admin",
      "u-admin",
    );
  });
});

describe("AcceptInvitationController", () => {
  it("403s an API-token principal (no user identity to attach the membership to)", async () => {
    const principal: Principal = { tenantId: "t-1", role: "owner" }; // no userId
    await expect(
      makeControllers().acceptCtl.accept({ token: "x".repeat(24) }, principal),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(accept).not.toHaveBeenCalled();
  });

  it("forwards the user's identity + verified flag to the service", async () => {
    const principal: Principal = {
      tenantId: "",
      userId: "u-9",
      email: "a@b.co",
      emailVerified: true,
    };
    await makeControllers().acceptCtl.accept(
      { token: "x".repeat(24) },
      principal,
    );
    expect(accept).toHaveBeenCalledWith("x".repeat(24), "u-9", "a@b.co", true);
  });
});

describe("InvitationsModule DI wiring", () => {
  it("compiles with InvitationsService resolving MembershipService across modules", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MembershipModule, AuthModule, InvitationsModule],
    }).compile();
    expect(moduleRef.get(InvitationsService)).toBeInstanceOf(
      InvitationsService,
    );
  });
});
