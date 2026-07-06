import "reflect-metadata";
import { ForbiddenException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "../src/auth/tenant.decorator";
import type { MembershipService } from "../src/membership/membership.service";
import { WorkspacesController } from "../src/membership/workspaces.controller";

const listForUser = vi.fn();
const ensureMembership = vi.fn();
const createWorkspace = vi.fn();
const workspaceNames = vi.fn();
function makeController(): WorkspacesController {
  return new WorkspacesController({
    listForUser,
    ensureMembership,
    createWorkspace,
    workspaceNames,
  } as unknown as MembershipService);
}

beforeEach(() => {
  listForUser.mockReset();
  ensureMembership.mockReset().mockResolvedValue(undefined);
  createWorkspace
    .mockReset()
    .mockResolvedValue({ tenantId: "ws-new", role: "owner" });
  workspaceNames.mockReset().mockResolvedValue(new Map());
});

describe("WorkspacesController", () => {
  it("returns the user's memberships (Firebase subject present)", async () => {
    listForUser.mockResolvedValue([
      { tenantId: "t1", role: "owner" },
      { tenantId: "t2", role: "member" },
    ]);
    const res = await makeController().list({
      tenantId: "t1",
      subject: "user-9",
    });
    expect(res).toEqual([
      { tenantId: "t1", role: "owner" },
      { tenantId: "t2", role: "member" },
    ]);
    expect(ensureMembership).not.toHaveBeenCalled();
  });

  it("lazily backfills an owner membership on first login of a claim user", async () => {
    listForUser
      .mockResolvedValueOnce([]) // none yet
      .mockResolvedValueOnce([{ tenantId: "t-claim", role: "owner" }]);
    const res = await makeController().list({
      tenantId: "t-claim",
      subject: "user-9",
    });
    expect(ensureMembership).toHaveBeenCalledWith("user-9", "t-claim", "owner");
    expect(res).toEqual([{ tenantId: "t-claim", role: "owner" }]);
  });

  it("enriches workspaces with their display name (TenantSettings.displayName)", async () => {
    listForUser.mockResolvedValue([
      { tenantId: "t1", role: "owner" },
      { tenantId: "t2", role: "member" },
    ]);
    workspaceNames.mockResolvedValue(new Map([["t1", "Acme Inc"]]));
    const res = await makeController().list({
      tenantId: "t1",
      subject: "user-9",
    });
    expect(res).toEqual([
      { tenantId: "t1", role: "owner", name: "Acme Inc" },
      { tenantId: "t2", role: "member", name: undefined },
    ]);
  });

  it("synthesizes the single workspace for an API-token principal (no subject, no persist)", async () => {
    const res = await makeController().list({ tenantId: "t-token" });
    expect(res).toEqual([{ tenantId: "t-token", role: "owner" }]);
    expect(listForUser).not.toHaveBeenCalled();
    expect(ensureMembership).not.toHaveBeenCalled();
  });

  describe("create (POST /workspaces)", () => {
    it("creates a workspace for a verified signed-in user", async () => {
      const principal: Principal = {
        tenantId: "",
        userId: "u-1",
        email: "a@b.co",
        emailVerified: true,
      };
      expect(await makeController().create(principal, {})).toEqual({
        tenantId: "ws-new",
        role: "owner",
      });
      expect(createWorkspace).toHaveBeenCalledWith("u-1", "a@b.co", undefined);
    });

    it("passes a supplied workspace name through to createWorkspace", async () => {
      const principal: Principal = {
        tenantId: "",
        userId: "u-1",
        email: "a@b.co",
        emailVerified: true,
      };
      await makeController().create(principal, { name: "Acme Inc" });
      expect(createWorkspace).toHaveBeenCalledWith("u-1", "a@b.co", "Acme Inc");
    });

    it("403s an API-token principal (no user identity → can't self-serve)", async () => {
      const principal: Principal = { tenantId: "t-1", role: "owner" };
      await expect(
        makeController().create(principal, {}),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(createWorkspace).not.toHaveBeenCalled();
    });

    it("403s a user whose email is not verified (attack #6)", async () => {
      const principal: Principal = {
        tenantId: "",
        userId: "u-1",
        email: "a@b.co",
        emailVerified: false,
      };
      await expect(
        makeController().create(principal, {}),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(createWorkspace).not.toHaveBeenCalled();
    });
  });
});
