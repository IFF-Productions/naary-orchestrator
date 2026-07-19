/**
 * Pure logic for the Groups UI + SPA affordance gating (RBAC-GROUPS.md, slice G2).
 * No I/O — everything here is unit-tested (apps/web/test/permissions-logic.spec.ts).
 *
 * Affordance gating is NOT enforcement: hiding a button only mirrors what the API
 * already 403s (G1's in-service asserts). A forced request still fails server-side.
 */
import type {
  EffectivePermissions,
  GrantInput,
  GroupGrant,
  PermissionGroup,
} from "./api";

/** The five per-workflow verbs. `create` is separate — it targets a key that doesn't exist yet. */
export type WorkflowVerb = "view" | "run" | "edit" | "delete" | "share";

/** The grant editor's working state — what the matrix + selectors bind to. */
export interface GrantDraft {
  /** null = all environments (the default). */
  environmentId: string | null;
  scope: "all" | "selected";
  canView: boolean;
  canRun: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canShare: boolean;
  canCreate: boolean;
  workflowKeys: string[];
  /** Tag ids for 'selected' scope (§9 tag-scoped grants): effective coverage =
   *  workflowKeys ∪ every key carrying any of these tags. */
  tagIds: string[];
}

/** A fresh, empty draft: all environments, all workflows, no verbs. */
export function emptyGrantDraft(): GrantDraft {
  return {
    environmentId: null,
    scope: "all",
    canView: false,
    canRun: false,
    canEdit: false,
    canDelete: false,
    canShare: false,
    canCreate: false,
    workflowKeys: [],
    tagIds: [],
  };
}

/** Seed the editor from an existing grant (edit flow). */
export function draftFromGrant(g: GroupGrant): GrantDraft {
  return {
    environmentId: g.environmentId,
    scope: g.scope,
    canView: g.canView,
    canRun: g.canRun,
    canEdit: g.canEdit,
    canDelete: g.canDelete,
    canShare: g.canShare,
    canCreate: g.canCreate,
    workflowKeys: [...g.workflowKeys],
    tagIds: [...(g.tagIds ?? [])],
  };
}

/**
 * Matrix → API payload. Mirrors the server's §8.3 rule client-side so a save can't 400:
 * `canCreate` is valid only on 'all'-scope grants (forced false otherwise), and
 * workflowKeys/tagIds only travel for scope 'selected' (replace-set; cleared for 'all').
 */
export function draftToPayload(d: GrantDraft): GrantInput {
  const selected = d.scope === "selected";
  return {
    environmentId: d.environmentId,
    scope: d.scope,
    canView: d.canView,
    canRun: d.canRun,
    canEdit: d.canEdit,
    canDelete: d.canDelete,
    canShare: d.canShare,
    canCreate: selected ? false : d.canCreate,
    workflowKeys: selected ? d.workflowKeys : [],
    tagIds: selected ? d.tagIds : [],
  };
}

/** A saveable draft carries at least one verb, and 'selected' scope at least one workflow
 *  or tag. Returns the reason it isn't saveable, or null when it is. */
export function draftProblem(d: GrantDraft): string | null {
  const anyVerb =
    d.canView ||
    d.canRun ||
    d.canEdit ||
    d.canDelete ||
    d.canShare ||
    (d.scope === "all" && d.canCreate);
  if (!anyVerb) return "Select at least one permission.";
  if (
    d.scope === "selected" &&
    d.workflowKeys.length === 0 &&
    d.tagIds.length === 0
  )
    return "Select at least one workflow or tag (or switch the scope to all workflows).";
  return null;
}

/** Does ANY grant exist across the workspace's groups? THE restriction switch (§4/§8.6):
 *  false means the next saved grant is the FIRST — the UI must show the cliff warning. */
export function workspaceHasAnyGrant(groups: PermissionGroup[]): boolean {
  return groups.some((g) => g.grants.length > 0);
}

/** Does ANY grant reference a TAG? False means the next tag-carrying grant is the
 *  workspace's FIRST TagGrant — the editor shows the "tags become access-bearing" warning
 *  (from then on, editing a workflow's tags requires the Promote permission). */
export function workspaceHasAnyTagGrant(groups: PermissionGroup[]): boolean {
  return groups.some((g) =>
    g.grants.some((gr) => (gr.tagIds ?? []).length > 0),
  );
}

/** Total grants across all groups (list header). */
export function totalGrantCount(groups: PermissionGroup[]): number {
  return groups.reduce((n, g) => n + g.grants.length, 0);
}

/* ---------------- affordance gating (GET /me/permissions) ---------------- */

/**
 * May the caller perform `verb` on `workflowKey`? `perms` null = not loaded (or the
 * fetch failed) — treat as allowed and let the server enforce; hiding everything on a
 * transient error would brick the UI for unrestricted users.
 */
export function canDo(
  perms: EffectivePermissions | null,
  verb: WorkflowVerb,
  workflowKey: string,
): boolean {
  if (!perms || !perms.restricted) return true;
  const access = perms[verb];
  return access.all || access.keys.includes(workflowKey);
}

/** May the caller create a NEW workflow in this env? */
export function canCreateWorkflow(perms: EffectivePermissions | null): boolean {
  if (!perms || !perms.restricted) return true;
  return perms.canCreate;
}

/** Canvas save: editing an EXISTING key needs `edit` on it; a NEW key needs `create`. */
export function canSaveWorkflow(
  perms: EffectivePermissions | null,
  workflowKey: string,
  keyExists: boolean,
): boolean {
  return keyExists
    ? canDo(perms, "edit", workflowKey)
    : canCreateWorkflow(perms);
}
