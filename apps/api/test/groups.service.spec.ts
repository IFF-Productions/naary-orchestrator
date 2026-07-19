import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

const permissionGroup = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
const groupMember = { upsert: vi.fn(), deleteMany: vi.fn() };
const groupTokenMember = { upsert: vi.fn(), deleteMany: vi.fn() };
const workflowGrant = {
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  deleteMany: vi.fn(),
};
const workflowGrantKey = { deleteMany: vi.fn() };
const tagGrant = { deleteMany: vi.fn() };
const tag = { findMany: vi.fn() };
const membership = { findUnique: vi.fn() };
const apiToken = { findFirst: vi.fn() };
const environment = { findFirst: vi.fn() };
const $transaction = vi.fn(async (ops: unknown[]) => Promise.all(ops));
vi.mock("@naary/db", () => ({
  getPrisma: () => ({
    permissionGroup,
    groupMember,
    groupTokenMember,
    workflowGrant,
    workflowGrantKey,
    tagGrant,
    tag,
    membership,
    apiToken,
    environment,
    $transaction,
  }),
}));

import type { Principal } from "../src/auth/tenant.decorator";
import { GroupsService } from "../src/permissions/groups.service";
import type { PermissionsService } from "../src/permissions/permissions.service";

const invalidateTenant = vi.fn();
const svc = new GroupsService({
  invalidateTenant,
} as unknown as PermissionsService);

const asOwner: Principal = { tenantId: "t-1", userId: "u-own", role: "owner" };
const asAdmin: Principal = { tenantId: "t-1", userId: "u-adm", role: "admin" };
const asMember: Principal = {
  tenantId: "t-1",
  userId: "u-mem",
  role: "member",
};

const GROUP_ROW = {
  id: "grp-1",
  tenantId: "t-1",
  name: "Support",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  members: [],
  tokenMembers: [],
  grants: [],
};

const GRANT_ROW = {
  id: "grant-1",
  environmentId: null,
  scope: "all",
  canView: true,
  canRun: false,
  canEdit: false,
  canDelete: false,
  canShare: false,
  canCreate: false,
  workflows: [],
};

beforeEach(() => {
  for (const model of [
    permissionGroup,
    groupMember,
    groupTokenMember,
    workflowGrant,
    workflowGrantKey,
    tagGrant,
    tag,
    membership,
    apiToken,
    environment,
  ]) {
    for (const fn of Object.values(model)) fn.mockReset();
  }
  invalidateTenant.mockReset();
  $transaction.mockClear();
  permissionGroup.findMany.mockResolvedValue([]);
  permissionGroup.findFirst.mockResolvedValue({ id: "grp-1" }); // group belongs to tenant
  membership.findUnique.mockResolvedValue(null);
  apiToken.findFirst.mockResolvedValue(null);
  environment.findFirst.mockResolvedValue(null);
  workflowGrant.findFirst.mockResolvedValue(null);
  workflowGrant.deleteMany.mockResolvedValue({ count: 1 });
  groupMember.deleteMany.mockResolvedValue({ count: 1 });
  groupTokenMember.deleteMany.mockResolvedValue({ count: 1 });
  workflowGrantKey.deleteMany.mockResolvedValue({ count: 0 });
  tagGrant.deleteMany.mockResolvedValue({ count: 0 });
  tag.findMany.mockResolvedValue([]);
});

// ---- §4 role gates: group/grant CRUD is owner|admin ONLY (share grants no such power) ----
describe("GroupsService role gates", () => {
  it("403s a plain member on every group/grant operation", async () => {
    await expect(svc.list("t-1", asMember)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(svc.create("t-1", asMember, "G")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      svc.addMember("t-1", asMember, "grp-1", "u-2"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      svc.addToken("t-1", asMember, "grp-1", "tok-1"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      svc.createGrant("t-1", asMember, "grp-1", {}),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      svc.removeGrant("t-1", asMember, "grp-1", "grant-1"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(permissionGroup.create).not.toHaveBeenCalled();
    expect(workflowGrant.create).not.toHaveBeenCalled();
  });

  it("lets an ADMIN manage groups (not just the owner)", async () => {
    permissionGroup.create.mockResolvedValue(GROUP_ROW);
    const out = await svc.create("t-1", asAdmin, "Support");
    expect(out).toMatchObject({ id: "grp-1", name: "Support" });
  });
});

// ---- tenant isolation: every operation is scoped to the caller's workspace ----
describe("GroupsService tenant isolation", () => {
  it("404s on a group that belongs to ANOTHER tenant (never cross-tenant)", async () => {
    permissionGroup.findFirst.mockResolvedValue(null); // not ours
    await expect(
      svc.rename("t-1", asOwner, "grp-foreign", "X"),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      svc.addMember("t-1", asOwner, "grp-foreign", "u-2"),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      svc.createGrant("t-1", asOwner, "grp-foreign", {}),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(permissionGroup.findFirst).toHaveBeenCalledWith({
      where: { id: "grp-foreign", tenantId: "t-1" },
      select: { id: true },
    });
  });

  it("grant delete is tenant+group-scoped (count 0 → 404, not a silent success)", async () => {
    workflowGrant.deleteMany.mockResolvedValue({ count: 0 });
    await expect(
      svc.removeGrant("t-1", asOwner, "grp-1", "grant-foreign"),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(workflowGrant.deleteMany).toHaveBeenCalledWith({
      where: { id: "grant-foreign", groupId: "grp-1", tenantId: "t-1" },
    });
  });
});

// ---- membership / token validation ----
describe("GroupsService member + token attachment", () => {
  it("400s adding a user who holds NO Membership in the tenant", async () => {
    membership.findUnique.mockResolvedValue(null);
    await expect(
      svc.addMember("t-1", asOwner, "grp-1", "u-ghost"),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(groupMember.upsert).not.toHaveBeenCalled();
  });

  it("adds a real member idempotently and INVALIDATES the tenant's permissions cache", async () => {
    membership.findUnique.mockResolvedValue({ userId: "u-2" });
    await svc.addMember("t-1", asOwner, "grp-1", "u-2");
    expect(groupMember.upsert).toHaveBeenCalledWith({
      where: { groupId_userId: { groupId: "grp-1", userId: "u-2" } },
      create: { groupId: "grp-1", userId: "u-2" },
      update: {},
    });
    expect(invalidateTenant).toHaveBeenCalledWith("t-1");
  });

  it("400s attaching a token that belongs to another tenant", async () => {
    apiToken.findFirst.mockResolvedValue(null);
    await expect(
      svc.addToken("t-1", asOwner, "grp-1", "tok-foreign"),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(groupTokenMember.upsert).not.toHaveBeenCalled();
  });

  it("attaches the tenant's own token (§4a) and invalidates", async () => {
    apiToken.findFirst.mockResolvedValue({ id: "tok-1" });
    await svc.addToken("t-1", asOwner, "grp-1", "tok-1");
    expect(groupTokenMember.upsert).toHaveBeenCalled();
    expect(invalidateTenant).toHaveBeenCalledWith("t-1");
  });

  it("member/token removal invalidates (revocation must be immediate)", async () => {
    await svc.removeMember("t-1", asOwner, "grp-1", "u-2");
    await svc.removeToken("t-1", asOwner, "grp-1", "tok-1");
    expect(invalidateTenant).toHaveBeenCalledTimes(2);
  });
});

// ---- grants: the six-verb matrix, canCreate×scope coherence, env validation ----
describe("GroupsService grants", () => {
  it("400s canCreate on a 'selected'-scope grant (§8.3)", async () => {
    await expect(
      svc.createGrant("t-1", asOwner, "grp-1", {
        scope: "selected",
        canCreate: true,
        workflowKeys: ["wf-a"],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(workflowGrant.create).not.toHaveBeenCalled();
  });

  it("400s an UPDATE whose RESULTING state is canCreate×selected", async () => {
    // Existing grant has canCreate on 'all'; the patch flips scope to 'selected'.
    workflowGrant.findFirst.mockResolvedValue({
      ...GRANT_ROW,
      scope: "all",
      canCreate: true,
    });
    await expect(
      svc.updateGrant("t-1", asOwner, "grp-1", "grant-1", {
        scope: "selected",
        workflowKeys: ["wf-a"],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(workflowGrant.update).not.toHaveBeenCalled();
  });

  it("400s an environmentId that isn't an env of this workspace", async () => {
    environment.findFirst.mockResolvedValue(null);
    await expect(
      svc.createGrant("t-1", asOwner, "grp-1", {
        environmentId: "env-foreign",
        canView: true,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("creates an env-scoped 'selected' grant with its key list and invalidates", async () => {
    environment.findFirst.mockResolvedValue({ id: "env-sbx" });
    workflowGrant.create.mockResolvedValue({
      ...GRANT_ROW,
      id: "grant-2",
      environmentId: "env-sbx",
      scope: "selected",
      canRun: true,
      workflows: [{ workflowKey: "wf-a" }],
    });
    const out = await svc.createGrant("t-1", asOwner, "grp-1", {
      environmentId: "env-sbx",
      scope: "selected",
      canRun: true,
      workflowKeys: ["wf-a", " wf-a ", ""],
    });
    expect(workflowGrant.create.mock.calls[0][0].data).toMatchObject({
      tenantId: "t-1", // denormalized — THE restriction switch
      groupId: "grp-1",
      environmentId: "env-sbx",
      scope: "selected",
      canRun: true,
      workflows: { create: [{ workflowKey: "wf-a" }] }, // trimmed + deduped
    });
    expect(out).toMatchObject({
      id: "grant-2",
      scope: "selected",
      workflowKeys: ["wf-a"],
    });
    expect(invalidateTenant).toHaveBeenCalledWith("t-1");
  });

  it("update replace-sets the key list atomically (delete old keys + write new)", async () => {
    workflowGrant.findFirst.mockResolvedValue({
      ...GRANT_ROW,
      scope: "selected",
    });
    workflowGrant.update.mockResolvedValue({
      ...GRANT_ROW,
      scope: "selected",
      workflows: [{ workflowKey: "wf-b" }],
    });
    await svc.updateGrant("t-1", asOwner, "grp-1", "grant-1", {
      workflowKeys: ["wf-b"],
    });
    expect(workflowGrantKey.deleteMany).toHaveBeenCalledWith({
      where: { grantId: "grant-1" },
    });
    expect($transaction).toHaveBeenCalledTimes(1);
    expect(invalidateTenant).toHaveBeenCalledWith("t-1");
  });

  it("grant delete invalidates (removing the LAST grant lifts the cliff)", async () => {
    await svc.removeGrant("t-1", asOwner, "grp-1", "grant-1");
    expect(invalidateTenant).toHaveBeenCalledWith("t-1");
  });
});

// ---- tag-scoped grants (§9, SHIPPED): tagIds on 'selected' grants ----
describe("GroupsService tag-scoped grants", () => {
  it("creates a 'selected' grant with validated + deduped tagIds and invalidates", async () => {
    tag.findMany.mockResolvedValue([{ id: "tag-1" }, { id: "tag-2" }]);
    workflowGrant.create.mockResolvedValue({
      ...GRANT_ROW,
      id: "grant-2",
      scope: "selected",
      canView: true,
      workflows: [],
      tagGrants: [{ tagId: "tag-1" }, { tagId: "tag-2" }],
    });
    const out = await svc.createGrant("t-1", asOwner, "grp-1", {
      scope: "selected",
      canView: true,
      tagIds: ["tag-1", "tag-2", "tag-1"], // deduped
    });
    // Ownership check is tenant-scoped over exactly the (deduped) requested ids.
    expect(tag.findMany).toHaveBeenCalledWith({
      where: { id: { in: ["tag-1", "tag-2"] }, tenantId: "t-1" },
      select: { id: true },
    });
    expect(workflowGrant.create.mock.calls[0][0].data).toMatchObject({
      scope: "selected",
      tagGrants: { create: [{ tagId: "tag-1" }, { tagId: "tag-2" }] },
    });
    expect(out.tagIds).toEqual(["tag-1", "tag-2"]);
    expect(invalidateTenant).toHaveBeenCalledWith("t-1");
  });

  it("400s a tag id that belongs to another tenant — BEFORE writing", async () => {
    tag.findMany.mockResolvedValue([{ id: "tag-1" }]); // tag-foreign missing
    await expect(
      svc.createGrant("t-1", asOwner, "grp-1", {
        scope: "selected",
        canView: true,
        tagIds: ["tag-1", "tag-foreign"],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(workflowGrant.create).not.toHaveBeenCalled();
  });

  it("ignores tagIds for scope 'all' (like workflowKeys — no validation, none written)", async () => {
    workflowGrant.create.mockResolvedValue({ ...GRANT_ROW, tagGrants: [] });
    const out = await svc.createGrant("t-1", asOwner, "grp-1", {
      scope: "all",
      canView: true,
      tagIds: ["tag-1"],
    });
    expect(tag.findMany).not.toHaveBeenCalled();
    expect(
      workflowGrant.create.mock.calls[0][0].data.tagGrants,
    ).toBeUndefined();
    expect(out.tagIds).toEqual([]);
  });

  it("update replace-sets the TAG list atomically (clears old TagGrants + writes new)", async () => {
    workflowGrant.findFirst.mockResolvedValue({
      ...GRANT_ROW,
      scope: "selected",
    });
    tag.findMany.mockResolvedValue([{ id: "tag-2" }]);
    workflowGrant.update.mockResolvedValue({
      ...GRANT_ROW,
      scope: "selected",
      workflows: [],
      tagGrants: [{ tagId: "tag-2" }],
    });
    const out = await svc.updateGrant("t-1", asOwner, "grp-1", "grant-1", {
      tagIds: ["tag-2"],
    });
    expect(tagGrant.deleteMany).toHaveBeenCalledWith({
      where: { grantId: "grant-1" },
    });
    // The UNTOUCHED key list costs no delete.
    expect(workflowGrantKey.deleteMany).not.toHaveBeenCalled();
    expect($transaction).toHaveBeenCalledTimes(1);
    expect(out.tagIds).toEqual(["tag-2"]);
    expect(invalidateTenant).toHaveBeenCalledWith("t-1");
  });

  it("an update leaving BOTH lists untouched runs a single update (no transaction)", async () => {
    workflowGrant.findFirst.mockResolvedValue({
      ...GRANT_ROW,
      scope: "selected",
    });
    workflowGrant.update.mockResolvedValue({
      ...GRANT_ROW,
      scope: "selected",
      tagGrants: [],
    });
    await svc.updateGrant("t-1", asOwner, "grp-1", "grant-1", {
      canRun: true,
    });
    expect($transaction).not.toHaveBeenCalled();
    expect(tagGrant.deleteMany).not.toHaveBeenCalled();
    expect(workflowGrantKey.deleteMany).not.toHaveBeenCalled();
  });

  it("flipping scope to 'all' clears BOTH lists (keys and tags)", async () => {
    workflowGrant.findFirst.mockResolvedValue({
      ...GRANT_ROW,
      scope: "selected",
    });
    workflowGrant.update.mockResolvedValue({
      ...GRANT_ROW,
      scope: "all",
      workflows: [],
      tagGrants: [],
    });
    await svc.updateGrant("t-1", asOwner, "grp-1", "grant-1", {
      scope: "all",
    });
    expect(workflowGrantKey.deleteMany).toHaveBeenCalledWith({
      where: { grantId: "grant-1" },
    });
    expect(tagGrant.deleteMany).toHaveBeenCalledWith({
      where: { grantId: "grant-1" },
    });
  });
});
