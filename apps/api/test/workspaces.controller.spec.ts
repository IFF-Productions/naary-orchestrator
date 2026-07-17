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
const seedWorkspaceName = vi.fn();
function makeController(): WorkspacesController {
  return new WorkspacesController({
    listForUser,
    ensureMembership,
    createWorkspace,
    workspaceNames,
    seedWorkspaceName,
  } as unknown as MembershipService);
}

beforeEach(() => {
  listForUser.mockReset();
  ensureMembership.mockReset().mockResolvedValue(undefined);
  createWorkspace
    .mockReset()
    .mockResolvedValue({ tenantId: "ws-new", role: "owner" });
  workspaceNames.mockReset().mockResolvedValue(new Map());
  seedWorkspaceName.mockReset().mockResolvedValue(undefined);
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

  describe("personal default name for unnamed legacy tenants", () => {
    it('seeds "<user name>\'s workspace" for an unnamed legacy tenant the caller owns', async () => {
      listForUser.mockResolvedValue([{ tenantId: "t-demo", role: "owner" }]);
      const res = await makeController().list({
        tenantId: "t-demo",
        subject: "user-9",
        name: "Hassan",
        email: "hassan@acme.com",
      });
      expect(seedWorkspaceName).toHaveBeenCalledWith(
        "t-demo",
        "Hassan's workspace",
      );
      expect(res).toEqual([
        { tenantId: "t-demo", role: "owner", name: "Hassan's workspace" },
      ]);
    });

    it("falls back to the email local-part when the user has no display name", async () => {
      listForUser.mockResolvedValue([{ tenantId: "t-demo", role: "owner" }]);
      const res = await makeController().list({
        tenantId: "t-demo",
        subject: "user-9",
        email: "tarazena@gmail.com",
      });
      expect(seedWorkspaceName).toHaveBeenCalledWith(
        "t-demo",
        "tarazena's workspace",
      );
      expect(res[0].name).toBe("tarazena's workspace");
    });

    it("never overwrites a name the user already set", async () => {
      listForUser.mockResolvedValue([{ tenantId: "t-demo", role: "owner" }]);
      workspaceNames.mockResolvedValue(new Map([["t-demo", "Acme Inc"]]));
      const res = await makeController().list({
        tenantId: "t-demo",
        subject: "user-9",
        name: "Hassan",
      });
      expect(seedWorkspaceName).not.toHaveBeenCalled();
      expect(res[0].name).toBe("Acme Inc");
    });

    it("skips server-minted ws-* workspaces and ones the caller doesn't own", async () => {
      listForUser.mockResolvedValue([
        { tenantId: "ws-abc123", role: "owner" },
        { tenantId: "t-other", role: "member" },
      ]);
      await makeController().list({
        tenantId: "ws-abc123",
        subject: "user-9",
        name: "Hassan",
      });
      expect(seedWorkspaceName).not.toHaveBeenCalled();
    });

    it("does nothing when the principal has no name or email to derive from", async () => {
      listForUser.mockResolvedValue([{ tenantId: "t-demo", role: "owner" }]);
      const res = await makeController().list({
        tenantId: "t-demo",
        subject: "user-9",
      });
      expect(seedWorkspaceName).not.toHaveBeenCalled();
      expect(res[0].name).toBeUndefined();
    });
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
