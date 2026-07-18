import { describe, expect, it } from "vitest";
import type {
  EffectivePermissions,
  GroupGrant,
  PermissionGroup,
} from "../src/lib/api/types";
import {
  canCreateWorkflow,
  canDo,
  canSaveWorkflow,
  draftFromGrant,
  draftProblem,
  draftToPayload,
  emptyGrantDraft,
  totalGrantCount,
  workspaceHasAnyGrant,
} from "../src/lib/permissions-logic";

const grant = (over: Partial<GroupGrant> = {}): GroupGrant => ({
  id: "gr-1",
  environmentId: null,
  scope: "all",
  canView: false,
  canRun: false,
  canEdit: false,
  canDelete: false,
  canShare: false,
  canCreate: false,
  workflowKeys: [],
  ...over,
});

const group = (grants: GroupGrant[]): PermissionGroup => ({
  id: "g-1",
  name: "Support",
  createdAt: "2026-07-18T00:00:00.000Z",
  members: [],
  tokens: [],
  grants,
});

const restricted = (
  over: Partial<EffectivePermissions> = {},
): EffectivePermissions => ({
  restricted: true,
  canCreate: false,
  view: { all: false, keys: [] },
  run: { all: false, keys: [] },
  edit: { all: false, keys: [] },
  delete: { all: false, keys: [] },
  share: { all: false, keys: [] },
  ...over,
});

describe("draftToPayload (matrix → API payload)", () => {
  it("passes the six verbs + env through for an all-scope grant, clearing keys", () => {
    const p = draftToPayload({
      ...emptyGrantDraft(),
      environmentId: "env-prod",
      canView: true,
      canRun: true,
      canCreate: true,
      workflowKeys: ["stale-key"], // left over from a scope flip — must not travel
    });
    expect(p).toEqual({
      environmentId: "env-prod",
      scope: "all",
      canView: true,
      canRun: true,
      canEdit: false,
      canDelete: false,
      canShare: false,
      canCreate: true,
      workflowKeys: [],
    });
  });

  it("forces canCreate off for scope 'selected' (mirrors the server's §8.3 400)", () => {
    const p = draftToPayload({
      ...emptyGrantDraft(),
      scope: "selected",
      canEdit: true,
      canCreate: true, // checked before the scope flipped
      workflowKeys: ["a", "b"],
    });
    expect(p.canCreate).toBe(false);
    expect(p.workflowKeys).toEqual(["a", "b"]);
    expect(p.scope).toBe("selected");
  });

  it("keeps environmentId null for the all-environments default", () => {
    expect(
      draftToPayload({ ...emptyGrantDraft(), canView: true }).environmentId,
    ).toBeNull();
  });
});

describe("draftFromGrant (edit-flow seeding)", () => {
  it("round-trips a grant through draft and back to an equivalent payload", () => {
    const g = grant({
      environmentId: "env-1",
      scope: "selected",
      canView: true,
      canRun: true,
      workflowKeys: ["k1", "k2"],
    });
    const p = draftToPayload(draftFromGrant(g));
    expect(p).toEqual({
      environmentId: "env-1",
      scope: "selected",
      canView: true,
      canRun: true,
      canEdit: false,
      canDelete: false,
      canShare: false,
      canCreate: false,
      workflowKeys: ["k1", "k2"],
    });
  });

  it("copies workflowKeys (mutating the draft never mutates the grant)", () => {
    const g = grant({ scope: "selected", workflowKeys: ["k1"] });
    const d = draftFromGrant(g);
    d.workflowKeys.push("k2");
    expect(g.workflowKeys).toEqual(["k1"]);
  });
});

describe("draftProblem (save gate)", () => {
  it("rejects a draft with no verbs", () => {
    expect(draftProblem(emptyGrantDraft())).toMatch(/at least one permission/i);
  });

  it("does not count canCreate as a verb under 'selected' scope (it will be forced off)", () => {
    expect(
      draftProblem({
        ...emptyGrantDraft(),
        scope: "selected",
        canCreate: true,
        workflowKeys: ["a"],
      }),
    ).toMatch(/at least one permission/i);
  });

  it("requires at least one workflow for 'selected' scope", () => {
    expect(
      draftProblem({ ...emptyGrantDraft(), scope: "selected", canView: true }),
    ).toMatch(/at least one workflow/i);
  });

  it("accepts a create-only all-scope grant and a view-only selected grant", () => {
    expect(draftProblem({ ...emptyGrantDraft(), canCreate: true })).toBeNull();
    expect(
      draftProblem({
        ...emptyGrantDraft(),
        scope: "selected",
        canView: true,
        workflowKeys: ["a"],
      }),
    ).toBeNull();
  });
});

describe("first-grant detection (§4/§8.6 — the cliff)", () => {
  it("is false with zero grants across all groups", () => {
    expect(workspaceHasAnyGrant([])).toBe(false);
    expect(workspaceHasAnyGrant([group([]), group([])])).toBe(false);
  });

  it("is true the moment ANY group holds a grant", () => {
    expect(workspaceHasAnyGrant([group([]), group([grant()])])).toBe(true);
  });

  it("totalGrantCount sums across groups", () => {
    expect(totalGrantCount([group([grant()]), group([grant(), grant()])])).toBe(
      3,
    );
  });
});

describe("canDo / canCreateWorkflow / canSaveWorkflow (affordance gating)", () => {
  it("null perms (not loaded / fetch failed) never gates — the server enforces", () => {
    expect(canDo(null, "edit", "k")).toBe(true);
    expect(canCreateWorkflow(null)).toBe(true);
    expect(canSaveWorkflow(null, "k", true)).toBe(true);
  });

  it("restricted:false is full access", () => {
    const full = restricted({ restricted: false });
    expect(canDo(full, "delete", "k")).toBe(true);
    expect(canCreateWorkflow(full)).toBe(true);
  });

  it("restricted honours all vs key lists per verb", () => {
    const p = restricted({
      view: { all: true, keys: [] },
      run: { all: false, keys: ["k1"] },
    });
    expect(canDo(p, "view", "anything")).toBe(true);
    expect(canDo(p, "run", "k1")).toBe(true);
    expect(canDo(p, "run", "k2")).toBe(false);
    expect(canDo(p, "edit", "k1")).toBe(false);
  });

  it("canSaveWorkflow: existing key needs edit on it, new key needs create", () => {
    const p = restricted({
      canCreate: false,
      edit: { all: false, keys: ["k1"] },
    });
    expect(canSaveWorkflow(p, "k1", true)).toBe(true);
    expect(canSaveWorkflow(p, "k2", true)).toBe(false);
    expect(canSaveWorkflow(p, "brand-new", false)).toBe(false);
    expect(
      canSaveWorkflow(restricted({ canCreate: true }), "brand-new", false),
    ).toBe(true);
  });
});
