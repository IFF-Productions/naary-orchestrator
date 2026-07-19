import { ForbiddenException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Company grants (RBAC-GROUPS §9 / COMPANIES §9): a SECOND grant source unioned into
// workspace resolution. The reads: the workspace switch (workflowGrant.findFirst), the
// subject's workspace grants (workflowGrant.findMany), the tenant→company link
// (tenantSettings.findUnique), and the member's company grants
// (companyWorkflowGrant.findMany, keyed by companyId + group membership).
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

const member: Principal = { tenantId: "t-1", userId: "u-mem", role: "member" };
/** A RESTRICTED token principal (§4a): stamped member + tokenId by the guard. */
const restrictedToken: Principal = {
  tenantId: "t-1",
  role: "member",
  tokenId: "tok-1",
};

function wsGrant(over: Record<string, unknown> = {}) {
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

function coGrant(over: Record<string, unknown> = {}) {
  return {
    id: "cg-1",
    groupId: "cpg-1",
    canView: false,
    canRun: false,
    canEdit: false,
    canDelete: false,
    canShare: false,
    canCreate: false,
    createdAt: new Date(),
    ...over,
  };
}

function makeService(): PermissionsService {
  return new PermissionsService(new PermissionsCache());
}

/** The workspace is ENFORCED (≥1 WorkflowGrant) and attached to co-1. */
function enforcedAttached(wsRows: unknown[], companyRows: unknown[]): void {
  grantFindFirst.mockResolvedValue({ id: "g-1" });
  grantFindMany.mockResolvedValue(wsRows);
  tenantSettingsFindUnique.mockResolvedValue({ companyId: "co-1" });
  companyGrantFindMany.mockResolvedValue(companyRows);
}

beforeEach(() => {
  grantFindFirst.mockReset().mockResolvedValue(null);
  grantFindMany.mockReset().mockResolvedValue([]);
  tenantSettingsFindUnique.mockReset().mockResolvedValue(null);
  tenantSettingsFindMany.mockReset().mockResolvedValue([]);
  companyGrantFindMany.mockReset().mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// THE INVARIANT: company grants NEVER flip a workspace's cliff. The enforcement
// switch stays workspace-local (WorkflowGrant existence); an unenforced
// workspace is byte-identically unaffected — no company lookups AT ALL.
// ---------------------------------------------------------------------------
describe("cliff non-flip (pinned)", () => {
  it("company grant alone + UNENFORCED workspace ⇒ subject bypasses; company tables never read", async () => {
    grantFindFirst.mockResolvedValue(null); // zero workspace grants — the cliff is not tripped
    // Even though a company grant nominally exists for this user…
    tenantSettingsFindUnique.mockResolvedValue({ companyId: "co-1" });
    companyGrantFindMany.mockResolvedValue([coGrant({ canView: true })]);
    const svc = makeService();
    // …behavior is byte-identical to a standalone unenforced workspace: full access…
    for (const action of ["view", "run", "edit", "delete", "share"] as const) {
      await svc.assertCan(member, action, "wf", "env-1");
    }
    expect(await svc.canCreateWorkflow(member, "env-1")).toBe(true);
    expect((await svc.getEffective(member, "env-1")).restricted).toBe(false);
    // …and the resolution NEVER consulted the company (bypass short-circuits first).
    expect(tenantSettingsFindUnique).not.toHaveBeenCalled();
    expect(companyGrantFindMany).not.toHaveBeenCalled();
  });

  it("owner/admin users bypass without any company (or workspace) grant reads", async () => {
    const owner: Principal = { tenantId: "t-1", userId: "u-o", role: "owner" };
    const svc = makeService();
    await svc.assertCan(owner, "delete", "wf", "env-1");
    expect(grantFindFirst).not.toHaveBeenCalled();
    expect(tenantSettingsFindUnique).not.toHaveBeenCalled();
    expect(companyGrantFindMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Union math: restricted member's workspace grants ∪ company grants.
// ---------------------------------------------------------------------------
describe("union of workspace + company grants", () => {
  it("verbs merge: company canRun ∪ workspace edit-selected", async () => {
    enforcedAttached(
      [
        wsGrant({
          canEdit: true,
          scope: "selected",
          workflows: [{ workflowKey: "wf-a" }],
        }),
      ],
      [coGrant({ canRun: true })],
    );
    const svc = makeService();
    // Company grant: run (and implied view) EVERYWHERE — all workflows, every env.
    await svc.assertCan(member, "run", "anything", "env-1");
    await svc.assertCan(member, "view", "anything", "env-2");
    // Workspace grant still contributes its own verb.
    await svc.assertCan(member, "edit", "wf-a", "env-1");
    // Neither source grants edit on other keys, nor delete anywhere.
    await expect(
      svc.assertCan(member, "edit", "wf-b", "env-1"),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      svc.assertCan(member, "delete", "wf-a", "env-1"),
    ).rejects.toThrow(ForbiddenException);
  });

  it("a restricted member with ONLY company grants gets exactly those (all-scope, every env)", async () => {
    enforcedAttached([], [coGrant({ canView: true, canCreate: true })]);
    const svc = makeService();
    const eff = await svc.getEffective(member, "env-x");
    expect(eff.restricted).toBe(true);
    expect(eff.view).toEqual({ all: true, keys: [] });
    expect(eff.canCreate).toBe(true); // 'all'-scope, so canCreate is coherent
    expect(eff.run).toEqual({ all: false, keys: [] });
    expect(await svc.filterViewable(member, ["a", "b"], "env-y")).toEqual([
      "a",
      "b",
    ]);
  });

  it("company grants match EVERY environment (mapped env=null)", async () => {
    enforcedAttached(
      [wsGrant({ canRun: true, scope: "all", environmentId: "env-prod" })],
      [coGrant({ canEdit: true })],
    );
    const svc = makeService();
    await svc.assertCan(member, "run", "wf", "env-prod");
    await expect(svc.assertCan(member, "run", "wf", "env-dev")).rejects.toThrow(
      ForbiddenException,
    ); // the workspace grant stays env-scoped
    await svc.assertCan(member, "edit", "wf", "env-dev"); // the company grant does not
    await svc.assertCan(member, "edit", "wf", "env-prod");
  });

  it("an all-false company grant contributes nothing", async () => {
    enforcedAttached([], [coGrant()]);
    const svc = makeService();
    await expect(svc.assertCan(member, "view", "wf", "env-1")).rejects.toThrow(
      ForbiddenException,
    );
  });

  it("company grants are scoped to THE company the tenant is attached to (cross-company isolation)", async () => {
    enforcedAttached([], [coGrant({ canView: true })]);
    const svc = makeService();
    await svc.can(member, "view", "wf", "env-1");
    // The where pins BOTH the attached company id AND the member's group membership —
    // a group of any other company can never contribute.
    expect(companyGrantFindMany).toHaveBeenCalledWith({
      where: {
        group: { companyId: "co-1", members: { some: { userId: "u-mem" } } },
      },
    });
  });

  it("a STANDALONE enforced workspace (no companyId) fetches no company grants", async () => {
    grantFindFirst.mockResolvedValue({ id: "g-1" });
    grantFindMany.mockResolvedValue([]);
    tenantSettingsFindUnique.mockResolvedValue({ companyId: null });
    const svc = makeService();
    await expect(svc.assertCan(member, "view", "wf", "env-1")).rejects.toThrow(
      ForbiddenException,
    );
    expect(companyGrantFindMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tokens NEVER receive company grants — they are workspace-scoped subjects.
// ---------------------------------------------------------------------------
describe("tokens are excluded from the company source", () => {
  it("a restricted token resolves workspace grants only; company tables never read", async () => {
    enforcedAttached([], [coGrant({ canView: true, canRun: true })]);
    const svc = makeService();
    await expect(
      svc.assertCan(restrictedToken, "view", "wf", "env-1"),
    ).rejects.toThrow(ForbiddenException);
    expect(tenantSettingsFindUnique).not.toHaveBeenCalled();
    expect(companyGrantFindMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Caching + the invalidateCompany fan-out.
// ---------------------------------------------------------------------------
describe("company grants share the per-subject cache; invalidateCompany fans out", () => {
  it("company grants are cached inside the subject's grants entry (one round of reads)", async () => {
    enforcedAttached([], [coGrant({ canView: true })]);
    const svc = makeService();
    await svc.assertCan(member, "view", "wf-1", "env-1");
    await svc.assertCan(member, "view", "wf-2", "env-2");
    expect(companyGrantFindMany).toHaveBeenCalledTimes(1);
    expect(tenantSettingsFindUnique).toHaveBeenCalledTimes(1);
  });

  it("invalidateCompany drops EVERY attached tenant's cache (a company revocation is immediate)", async () => {
    enforcedAttached([], [coGrant({ canView: true })]);
    const svc = makeService();
    await svc.assertCan(member, "view", "wf", "env-1"); // cached allow
    // The company owner deletes the grant…
    companyGrantFindMany.mockResolvedValue([]);
    // …and the write path fans out over the attached tenants:
    tenantSettingsFindMany.mockResolvedValue([
      { tenantId: "t-1" },
      { tenantId: "t-2" },
    ]);
    await svc.invalidateCompany("co-1");
    expect(tenantSettingsFindMany).toHaveBeenCalledWith({
      where: { companyId: "co-1" },
      select: { tenantId: true },
    });
    await expect(svc.assertCan(member, "view", "wf", "env-1")).rejects.toThrow(
      ForbiddenException,
    );
  });

  it("a member of a DIFFERENT tenant is untouched by another tenant's invalidation", async () => {
    enforcedAttached([], [coGrant({ canView: true })]);
    const svc = makeService();
    await svc.assertCan(member, "view", "wf", "env-1");
    tenantSettingsFindMany.mockResolvedValue([{ tenantId: "t-OTHER" }]);
    await svc.invalidateCompany("co-2");
    await svc.assertCan(member, "view", "wf", "env-1"); // still served from cache
    expect(companyGrantFindMany).toHaveBeenCalledTimes(1);
  });
});
