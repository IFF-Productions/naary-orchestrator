import { ForbiddenException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

// PermissionsService reads three things: "does the tenant have ANY grant?" (findFirst — THE
// restriction switch), the subject's effective grants (findMany through the group joins),
// and — for restricted USER subjects only — the tenant's companyId + company grants
// (the second grant source; defaults here = standalone workspace, no company).
const grantFindFirst = vi.fn();
const grantFindMany = vi.fn();
const tenantSettingsFindUnique = vi.fn();
const tenantSettingsFindMany = vi.fn();
const companyGrantFindMany = vi.fn();
vi.mock("@naary/db", () => ({
  getPrisma: () => ({
    workflowGrant: { findFirst: grantFindFirst, findMany: grantFindMany },
    tenantSettings: {
      findUnique: tenantSettingsFindUnique,
      findMany: tenantSettingsFindMany,
    },
    companyWorkflowGrant: { findMany: companyGrantFindMany },
  }),
}));

import type { Principal } from "../src/auth/tenant.decorator";
import { PermissionsCache } from "../src/permissions/permissions-cache";
import { PermissionsService } from "../src/permissions/permissions.service";

const owner: Principal = { tenantId: "t-1", userId: "u-own", role: "owner" };
const admin: Principal = { tenantId: "t-1", userId: "u-adm", role: "admin" };
const member: Principal = { tenantId: "t-1", userId: "u-mem", role: "member" };
/** An UNRESTRICTED `nry_` token principal (zero-grant workspace): stamped owner, NO tokenId. */
const unrestrictedToken: Principal = { tenantId: "t-1", role: "owner" };
/** A RESTRICTED token principal (§4a): stamped member + tokenId by the guard. */
const restrictedToken: Principal = {
  tenantId: "t-1",
  role: "member",
  tokenId: "tok-1",
};

/** A grant row as prisma returns it (workflows = the key list include). */
function grant(over: Record<string, unknown> = {}) {
  return {
    environmentId: null,
    scope: "all",
    canView: false,
    canRun: false,
    canEdit: false,
    canDelete: false,
    canShare: false,
    canCreate: false,
    workflows: [] as { workflowKey: string }[],
    ...over,
  };
}

function makeService(): PermissionsService {
  return new PermissionsService(new PermissionsCache());
}

/** The tenant has grants; the SUBJECT's groups carry `rows`. */
function enforcedWith(rows: unknown[]): void {
  grantFindFirst.mockResolvedValue({ id: "g-1" });
  grantFindMany.mockResolvedValue(rows);
}

beforeEach(() => {
  grantFindFirst.mockReset().mockResolvedValue(null);
  grantFindMany.mockReset().mockResolvedValue([]);
  tenantSettingsFindUnique.mockReset().mockResolvedValue(null); // standalone workspace
  tenantSettingsFindMany.mockReset().mockResolvedValue([]);
  companyGrantFindMany.mockReset().mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// Bypass matrix (§4): owner/admin users and unrestricted tokens never touch the
// grant tables; a trigger-fired path has NO principal and the services simply
// don't call the service at all (asserted in the enforcement specs).
// ---------------------------------------------------------------------------
describe("PermissionsService bypass matrix", () => {
  it("owner and admin USERS bypass — no grant reads at all", async () => {
    const svc = makeService();
    await svc.assertCan(owner, "delete", "wf", "env-1");
    await svc.assertCan(admin, "edit", "wf", "env-1");
    expect(grantFindFirst).not.toHaveBeenCalled();
    expect(grantFindMany).not.toHaveBeenCalled();
  });

  it("an UNRESTRICTED token (role owner, no tokenId) bypasses", async () => {
    const svc = makeService();
    await svc.assertCan(unrestrictedToken, "run", "wf", "env-1");
    expect(grantFindFirst).not.toHaveBeenCalled();
  });

  it("filterViewable / canCreateWorkflow / getEffective are full-access for bypassed subjects", async () => {
    const svc = makeService();
    expect(await svc.filterViewable(owner, ["a", "b"], "env-1")).toEqual([
      "a",
      "b",
    ]);
    expect(await svc.canCreateWorkflow(admin, "env-1")).toBe(true);
    const eff = await svc.getEffective(owner, "env-1");
    expect(eff.restricted).toBe(false);
    expect(eff.canCreate).toBe(true);
    expect(eff.view).toEqual({ all: true, keys: [] });
  });
});

// ---------------------------------------------------------------------------
// THE RULE (§4): zero grants = today's behavior; the FIRST grant flips members
// AND ungrouped tokens to deny-by-default.
// ---------------------------------------------------------------------------
describe("PermissionsService zero-grants cliff", () => {
  it("a member in a ZERO-grant workspace is fully functional (migration neutrality)", async () => {
    const svc = makeService();
    grantFindFirst.mockResolvedValue(null); // no grants anywhere in the tenant
    for (const action of ["view", "run", "edit", "delete", "share"] as const) {
      await svc.assertCan(member, action, "wf", "env-1");
    }
    expect(await svc.canCreateWorkflow(member, "env-1")).toBe(true);
    expect(await svc.filterViewable(member, ["a"], "env-1")).toEqual(["a"]);
    expect((await svc.getEffective(member, "env-1")).restricted).toBe(false);
    // The switch was consulted, the per-subject grants never were.
    expect(grantFindMany).not.toHaveBeenCalled();
  });

  it("the FIRST grant flips an ungrouped MEMBER to deny-by-default", async () => {
    const svc = makeService();
    enforcedWith([]); // grants exist in the tenant; this member is in no group
    await expect(svc.assertCan(member, "view", "wf", "env-1")).rejects.toThrow(
      ForbiddenException,
    );
    expect(await svc.canCreateWorkflow(member, "env-1")).toBe(false);
    expect(await svc.filterViewable(member, ["a", "b"], "env-1")).toEqual([]);
  });

  it("the FIRST grant flips an UNGROUPED token to deny-by-default too (§8.6)", async () => {
    const svc = makeService();
    enforcedWith([]);
    await expect(
      svc.assertCan(restrictedToken, "run", "wf", "env-1"),
    ).rejects.toThrow(ForbiddenException);
  });

  it("resolves a token subject by tokenId and a user subject by userId", async () => {
    const svc = makeService();
    enforcedWith([]);
    await svc.can(restrictedToken, "view", "wf", "env-1");
    expect(grantFindMany.mock.calls[0][0].where.group).toEqual({
      tokenMembers: { some: { tokenId: "tok-1" } },
    });
    grantFindMany.mockClear();
    await svc.can(member, "view", "wf", "env-1");
    expect(grantFindMany.mock.calls[0][0].where.group).toEqual({
      members: { some: { userId: "u-mem" } },
    });
  });
});

// ---------------------------------------------------------------------------
// Grant resolution: union across groups, implies-view, env matching, canCreate.
// ---------------------------------------------------------------------------
describe("PermissionsService grant resolution", () => {
  it("effective = UNION across the subject's groups' grants", async () => {
    const svc = makeService();
    enforcedWith([
      grant({ canView: true, scope: "all" }), // group A: view everything
      grant({
        canEdit: true,
        scope: "selected",
        workflows: [{ workflowKey: "wf-a" }],
      }), // group B: edit wf-a
    ]);
    await svc.assertCan(member, "view", "anything", "env-1");
    await svc.assertCan(member, "edit", "wf-a", "env-1");
    await expect(
      svc.assertCan(member, "edit", "wf-b", "env-1"),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      svc.assertCan(member, "delete", "wf-a", "env-1"),
    ).rejects.toThrow(ForbiddenException); // run does not imply edit, edit not delete
  });

  it("any of run/edit/delete/share IMPLIES view; nothing else is implied", async () => {
    const svc = makeService();
    enforcedWith([
      grant({
        canRun: true,
        scope: "selected",
        workflows: [{ workflowKey: "wf-a" }],
      }),
    ]);
    await svc.assertCan(member, "view", "wf-a", "env-1"); // implied
    await svc.assertCan(member, "run", "wf-a", "env-1");
    await expect(
      svc.assertCan(member, "edit", "wf-a", "env-1"),
    ).rejects.toThrow(ForbiddenException);
    expect(await svc.filterViewable(member, ["wf-a", "wf-b"], "env-1")).toEqual(
      ["wf-a"],
    );
  });

  it("env matching (§8.5): null = every env, set = exactly that env", async () => {
    const svc = makeService();
    enforcedWith([
      grant({ canRun: true, scope: "all", environmentId: "env-prod" }),
      grant({ canView: true, scope: "all", environmentId: null }),
    ]);
    await svc.assertCan(member, "run", "wf", "env-prod"); // matching env
    await expect(
      svc.assertCan(member, "run", "wf", "env-sandbox"),
    ).rejects.toThrow(ForbiddenException); // wrong env denied
    await svc.assertCan(member, "view", "wf", "env-sandbox"); // null-env grant matches everywhere
  });

  it("canCreate counts ONLY on 'all'-scope grants (§8.3), env-scoped", async () => {
    const svc = makeService();
    enforcedWith([
      // Defensive: even if a selected-scope canCreate row existed, it must not count.
      grant({
        canCreate: true,
        scope: "selected",
        workflows: [{ workflowKey: "wf-a" }],
      }),
      grant({ canCreate: true, scope: "all", environmentId: "env-sandbox" }),
    ]);
    expect(await svc.canCreateWorkflow(member, "env-sandbox")).toBe(true);
    expect(await svc.canCreateWorkflow(member, "env-prod")).toBe(false);
    await expect(svc.assertCanCreate(member, "env-prod")).rejects.toThrow(
      ForbiddenException,
    );
  });

  it("share is its own verb (promote), matched against the given (source) env", async () => {
    const svc = makeService();
    enforcedWith([
      grant({
        canShare: true,
        scope: "selected",
        environmentId: "env-src",
        workflows: [{ workflowKey: "wf" }],
      }),
    ]);
    await svc.assertCan(member, "share", "wf", "env-src");
    await expect(
      svc.assertCan(member, "share", "wf", "env-other"),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      svc.assertCan(member, "share", "wf-other", "env-src"),
    ).rejects.toThrow(ForbiddenException);
  });

  it("getEffective folds the union into per-verb {all, keys} with implies-view", async () => {
    const svc = makeService();
    enforcedWith([
      grant({
        canRun: true,
        scope: "selected",
        workflows: [{ workflowKey: "wf-a" }, { workflowKey: "wf-b" }],
      }),
      grant({ canEdit: true, scope: "all", environmentId: "env-other" }), // wrong env — ignored
      grant({ canCreate: true, canView: true, scope: "all" }),
    ]);
    const eff = await svc.getEffective(member, "env-1");
    expect(eff.restricted).toBe(true);
    expect(eff.canCreate).toBe(true);
    expect(eff.view).toEqual({ all: true, keys: [] }); // view-all grant
    expect(eff.run).toEqual({ all: false, keys: ["wf-a", "wf-b"] });
    expect(eff.edit).toEqual({ all: false, keys: [] }); // env-other grant filtered out
    expect(eff.share).toEqual({ all: false, keys: [] });
  });
});

// ---------------------------------------------------------------------------
// Caching: short-TTL read-through, dropped on invalidateTenant (every group/
// grant/member write calls it — revocation must be immediate).
// ---------------------------------------------------------------------------
describe("PermissionsService cache", () => {
  it("caches the enforcement switch and the subject's grants (one DB round each)", async () => {
    const svc = makeService();
    enforcedWith([grant({ canView: true, scope: "all" })]);
    await svc.assertCan(member, "view", "wf", "env-1");
    await svc.assertCan(member, "view", "wf2", "env-1");
    await svc.filterViewable(member, ["a"], "env-1");
    expect(grantFindFirst).toHaveBeenCalledTimes(1);
    expect(grantFindMany).toHaveBeenCalledTimes(1);
  });

  it("invalidateTenant drops both caches — a grant write is visible immediately", async () => {
    const svc = makeService();
    enforcedWith([grant({ canView: true, scope: "all" })]);
    await svc.assertCan(member, "view", "wf", "env-1");
    // The admin now deletes every grant (lifting the cliff)…
    grantFindFirst.mockResolvedValue(null);
    grantFindMany.mockResolvedValue([]);
    // …but the cache still says "enforced with view-all" until invalidated.
    svc.invalidateTenant("t-1");
    await svc.assertCan(member, "edit", "wf", "env-1"); // now unrestricted (cliff lifted)
    expect(grantFindFirst).toHaveBeenCalledTimes(2);
  });

  it("a REVOCATION is effective after invalidation (deny replaces a cached allow)", async () => {
    const svc = makeService();
    enforcedWith([grant({ canEdit: true, scope: "all" })]);
    await svc.assertCan(member, "edit", "wf", "env-1"); // allowed + cached
    grantFindMany.mockResolvedValue([]); // the member's group was just removed
    svc.invalidateTenant("t-1");
    await expect(svc.assertCan(member, "edit", "wf", "env-1")).rejects.toThrow(
      ForbiddenException,
    );
  });

  it("isTenantEnforced is the guard's cached restriction switch", async () => {
    const svc = makeService();
    grantFindFirst.mockResolvedValue({ id: "g-1" });
    expect(await svc.isTenantEnforced("t-1")).toBe(true);
    expect(await svc.isTenantEnforced("t-1")).toBe(true);
    expect(grantFindFirst).toHaveBeenCalledTimes(1); // cached
    svc.invalidateTenant("t-1");
    grantFindFirst.mockResolvedValue(null);
    expect(await svc.isTenantEnforced("t-1")).toBe(false);
  });
});
