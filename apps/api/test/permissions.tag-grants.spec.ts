import { beforeEach, describe, expect, it, vi } from "vitest";

// Tag-scoped grants (RBAC-GROUPS.md §9, SHIPPED): a 'selected'-scope grant's effective keys
// = its WorkflowGrantKey list ∪ the workflowKeys carrying ANY of its TagGrant tags. The
// expansion happens INSIDE grantsFor (one batched WorkflowTag lookup, grouped in JS) and is
// baked into the cached flattened keys — downstream matching (can/filterViewable/
// getEffective) is unchanged. Cache correctness: tag membership now changes access, so tag
// writes invalidate the tenant (asserted here via the cache round-trip).

const grantFindFirst = vi.fn();
const grantFindMany = vi.fn();
const workflowTagFindMany = vi.fn();
const tagGrantFindFirst = vi.fn();
const envFindMany = vi.fn();
vi.mock("@naary/db", () => ({
  getPrisma: () => ({
    workflowGrant: { findFirst: grantFindFirst, findMany: grantFindMany },
    workflowTag: { findMany: workflowTagFindMany },
    tagGrant: { findFirst: tagGrantFindFirst },
    environment: { findMany: envFindMany },
  }),
}));

import type { Principal } from "../src/auth/tenant.decorator";
import { PermissionsCache } from "../src/permissions/permissions-cache";
import {
  PermissionsService,
  viewTermsAllow,
} from "../src/permissions/permissions.service";

const owner: Principal = { tenantId: "t-1", userId: "u-own", role: "owner" };
const member: Principal = { tenantId: "t-1", userId: "u-mem", role: "member" };

/** A grant row as prisma returns it (workflows + tagGrants includes). */
function grant(over: Record<string, unknown> = {}) {
  return {
    environmentId: null,
    scope: "selected",
    canView: false,
    canRun: false,
    canEdit: false,
    canDelete: false,
    canShare: false,
    canCreate: false,
    workflows: [] as { workflowKey: string }[],
    tagGrants: [] as { tagId: string }[],
    ...over,
  };
}

function makeService(): PermissionsService {
  return new PermissionsService(new PermissionsCache());
}

function enforcedWith(rows: unknown[]): void {
  grantFindFirst.mockResolvedValue({ id: "g-1" });
  grantFindMany.mockResolvedValue(rows);
}

beforeEach(() => {
  grantFindFirst.mockReset().mockResolvedValue(null);
  grantFindMany.mockReset().mockResolvedValue([]);
  workflowTagFindMany.mockReset().mockResolvedValue([]);
  tagGrantFindFirst.mockReset().mockResolvedValue(null);
  envFindMany.mockReset().mockResolvedValue([]);
});

describe("tag-scoped grant expansion (§9)", () => {
  it("effective keys = explicit key list ∪ tag-carried keys (union)", async () => {
    const svc = makeService();
    enforcedWith([
      grant({
        canView: true,
        workflows: [{ workflowKey: "wf-direct" }],
        tagGrants: [{ tagId: "tag-1" }],
      }),
    ]);
    workflowTagFindMany.mockResolvedValue([
      { tagId: "tag-1", workflowKey: "wf-tagged-a" },
      { tagId: "tag-1", workflowKey: "wf-tagged-b" },
    ]);
    await svc.assertCan(member, "view", "wf-direct", "env-1");
    await svc.assertCan(member, "view", "wf-tagged-a", "env-1");
    await svc.assertCan(member, "view", "wf-tagged-b", "env-1");
    await expect(
      svc.assertCan(member, "view", "wf-other", "env-1"),
    ).rejects.toThrow();
    // The tag lookup is tenant-scoped over exactly the grants' tag ids.
    expect(workflowTagFindMany).toHaveBeenCalledWith({
      where: { tenantId: "t-1", tagId: { in: ["tag-1"] } },
      select: { tagId: true, workflowKey: true },
    });
  });

  it("getEffective folds tag-carried keys into the per-verb key lists (dedup with direct)", async () => {
    const svc = makeService();
    enforcedWith([
      grant({
        canRun: true,
        workflows: [{ workflowKey: "wf-a" }],
        tagGrants: [{ tagId: "tag-1" }],
      }),
    ]);
    workflowTagFindMany.mockResolvedValue([
      { tagId: "tag-1", workflowKey: "wf-a" }, // overlaps the direct key — deduped
      { tagId: "tag-1", workflowKey: "wf-b" },
    ]);
    const eff = await svc.getEffective(member, "env-1");
    expect(eff.run).toEqual({ all: false, keys: ["wf-a", "wf-b"] });
    expect(eff.view).toEqual({ all: false, keys: ["wf-a", "wf-b"] }); // implies view
  });

  it("ONE batched WorkflowTag lookup across ALL tags of ALL grants, grouped per grant", async () => {
    const svc = makeService();
    enforcedWith([
      grant({ canRun: true, tagGrants: [{ tagId: "tag-1" }] }),
      grant({
        canEdit: true,
        tagGrants: [{ tagId: "tag-2" }, { tagId: "tag-1" }],
      }),
    ]);
    workflowTagFindMany.mockResolvedValue([
      { tagId: "tag-1", workflowKey: "wf-1" },
      { tagId: "tag-2", workflowKey: "wf-2" },
    ]);
    await svc.can(member, "view", "wf-1", "env-1");
    expect(workflowTagFindMany).toHaveBeenCalledTimes(1);
    expect(workflowTagFindMany.mock.calls[0][0].where.tagId.in.sort()).toEqual([
      "tag-1",
      "tag-2",
    ]);
    // Grant 1 (run) carries only tag-1's keys; grant 2 (edit) carries both tags' keys.
    expect(await svc.can(member, "run", "wf-1", "env-1")).toBe(true);
    expect(await svc.can(member, "run", "wf-2", "env-1")).toBe(false);
    expect(await svc.can(member, "edit", "wf-1", "env-1")).toBe(true);
    expect(await svc.can(member, "edit", "wf-2", "env-1")).toBe(true);
  });

  it("skips the WorkflowTag lookup entirely when no grant carries tags", async () => {
    const svc = makeService();
    enforcedWith([grant({ canView: true, workflows: [{ workflowKey: "a" }] })]);
    await svc.can(member, "view", "a", "env-1");
    expect(workflowTagFindMany).not.toHaveBeenCalled();
  });

  it("a tag with no tagged workflows contributes nothing (grant may become empty)", async () => {
    const svc = makeService();
    enforcedWith([grant({ canView: true, tagGrants: [{ tagId: "tag-1" }] })]);
    workflowTagFindMany.mockResolvedValue([]);
    expect(await svc.can(member, "view", "anything", "env-1")).toBe(false);
  });

  it("per-grant ENV scoping still applies to tag-carried keys (§8.5)", async () => {
    const svc = makeService();
    enforcedWith([
      grant({
        canRun: true,
        environmentId: "env-prod",
        tagGrants: [{ tagId: "tag-1" }],
      }),
    ]);
    workflowTagFindMany.mockResolvedValue([
      { tagId: "tag-1", workflowKey: "wf-t" },
    ]);
    expect(await svc.can(member, "run", "wf-t", "env-prod")).toBe(true);
    expect(await svc.can(member, "run", "wf-t", "env-sandbox")).toBe(false);
  });

  it("the expansion is CACHED with the flattened keys and dropped on invalidateTenant", async () => {
    const svc = makeService();
    enforcedWith([grant({ canView: true, tagGrants: [{ tagId: "tag-1" }] })]);
    workflowTagFindMany.mockResolvedValue([
      { tagId: "tag-1", workflowKey: "wf-old" },
    ]);
    expect(await svc.can(member, "view", "wf-old", "env-1")).toBe(true);
    expect(await svc.can(member, "view", "wf-new", "env-1")).toBe(false);
    expect(workflowTagFindMany).toHaveBeenCalledTimes(1); // cached

    // The tag moves to another workflow (setWorkflowTags) → the write path invalidates…
    workflowTagFindMany.mockResolvedValue([
      { tagId: "tag-1", workflowKey: "wf-new" },
    ]);
    svc.invalidateTenant("t-1");
    // …and the very next check sees the new membership (access follows the tag).
    expect(await svc.can(member, "view", "wf-new", "env-1")).toBe(true);
    expect(await svc.can(member, "view", "wf-old", "env-1")).toBe(false);
  });
});

describe("tenantHasTagGrants (the conditional tag-edit gate switch)", () => {
  it("true iff any TagGrant exists under the tenant's grants; cached; invalidation drops it", async () => {
    const svc = makeService();
    tagGrantFindFirst.mockResolvedValue({ grantId: "g-1" });
    expect(await svc.tenantHasTagGrants("t-1")).toBe(true);
    expect(await svc.tenantHasTagGrants("t-1")).toBe(true);
    expect(tagGrantFindFirst).toHaveBeenCalledTimes(1); // cached
    expect(tagGrantFindFirst).toHaveBeenCalledWith({
      where: { grant: { tenantId: "t-1" } },
      select: { grantId: true },
    });
    // The last TagGrant is deleted (grant edit / tag delete cascade) + invalidation…
    tagGrantFindFirst.mockResolvedValue(null);
    svc.invalidateTenant("t-1");
    expect(await svc.tenantHasTagGrants("t-1")).toBe(false); // gate lifts to edit
  });
});

describe("viewTerms (shared runs-list/usage filter source)", () => {
  it("null for bypassed subjects (owner) — no env listing at all", async () => {
    const svc = makeService();
    expect(await svc.viewTerms(owner, "t-1")).toBeNull();
    expect(envFindMany).not.toHaveBeenCalled();
  });

  it("null for an ABSENT actor (internal caller)", async () => {
    const svc = makeService();
    expect(await svc.viewTerms(undefined, "t-1")).toBeNull();
    expect(grantFindFirst).not.toHaveBeenCalled();
  });

  it("restricted member: one term per env with visibility; default env owns NULL-env rows", async () => {
    const svc = makeService();
    enforcedWith([
      grant({ canView: true, scope: "all", environmentId: "env-prod" }),
      grant({
        canView: true,
        environmentId: "env-sbx",
        workflows: [{ workflowKey: "wf-a" }],
      }),
    ]);
    envFindMany.mockResolvedValue([
      { id: "env-prod", isDefault: true },
      { id: "env-sbx", isDefault: false },
      { id: "env-uat", isDefault: false }, // nothing viewable there — no term
    ]);
    const terms = await svc.viewTerms(member, "t-1");
    expect(terms).toEqual([
      {
        environmentId: "env-prod",
        includesNullEnv: true,
        view: { all: true, keys: [] },
      },
      {
        environmentId: "env-sbx",
        includesNullEnv: false,
        view: { all: false, keys: ["wf-a"] },
      },
    ]);
  });

  it("restricted member with NOTHING viewable gets [] (deny-by-default, distinct from null)", async () => {
    const svc = makeService();
    enforcedWith([]); // enforced tenant, ungrouped member
    envFindMany.mockResolvedValue([{ id: "env-prod", isDefault: true }]);
    expect(await svc.viewTerms(member, "t-1")).toEqual([]);
  });
});

describe("viewTermsAllow (the shared row predicate)", () => {
  const terms = [
    {
      environmentId: "env-prod",
      includesNullEnv: true,
      view: { all: false, keys: ["wf-a"] },
    },
    {
      environmentId: "env-sbx",
      includesNullEnv: false,
      view: { all: true, keys: [] },
    },
  ];

  it("matches by env with key-list / all semantics", () => {
    expect(viewTermsAllow(terms, "env-prod", "wf-a")).toBe(true);
    expect(viewTermsAllow(terms, "env-prod", "wf-b")).toBe(false);
    expect(viewTermsAllow(terms, "env-sbx", "anything")).toBe(true);
    expect(viewTermsAllow(terms, "env-unknown", "wf-a")).toBe(false);
  });

  it("a NULL environmentId row belongs to the DEFAULT env's term", () => {
    expect(viewTermsAllow(terms, null, "wf-a")).toBe(true);
    expect(viewTermsAllow(terms, null, "wf-b")).toBe(false);
  });

  it("a NULL workflowKey row is NEVER visible to a restricted subject", () => {
    expect(viewTermsAllow(terms, "env-sbx", null)).toBe(false);
    expect(viewTermsAllow(terms, null, null)).toBe(false);
  });
});
