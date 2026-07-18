import { ForbiddenException, Injectable } from "@nestjs/common";
import { getPrisma } from "@naary/db";
import type { Principal } from "../auth/tenant.decorator";
import { type EffectiveGrant, PermissionsCache } from "./permissions-cache";

/** The five per-workflow verbs (RBAC-GROUPS.md §4). `create` is separate — it targets a
 *  workflowKey that doesn't exist yet, so it can't be asserted against one. */
export type WorkflowAction = "view" | "run" | "edit" | "delete" | "share";

/** Effective access for one verb: everything, or an explicit key list. */
export interface VerbAccess {
  all: boolean;
  keys: string[];
}

/** The effective matrix `GET /me/permissions` returns (SPA affordance gating, G2).
 *  `restricted:false` ⇒ full access (owner/admin, unrestricted token, or the zero-grants
 *  cliff) — the verb fields are all `{all:true}` so the SPA needs no special-casing. */
export interface EffectivePermissions {
  restricted: boolean;
  canCreate: boolean;
  view: VerbAccess;
  run: VerbAccess;
  edit: VerbAccess;
  delete: VerbAccess;
  share: VerbAccess;
}

const FULL_ACCESS: EffectivePermissions = Object.freeze({
  restricted: false,
  canCreate: true,
  view: { all: true, keys: [] },
  run: { all: true, keys: [] },
  edit: { all: true, keys: [] },
  delete: { all: true, keys: [] },
  share: { all: true, keys: [] },
});

const ACTION_LABEL: Record<WorkflowAction, string> = {
  view: "view",
  run: "run",
  edit: "edit",
  delete: "delete",
  share: "promote",
};

/** Does this grant carry the verb? Any of run/edit/delete/share IMPLIES view (§4 —
 *  operating on an invisible workflow is incoherent). Nothing else is implied. */
function allows(g: EffectiveGrant, action: WorkflowAction): boolean {
  switch (action) {
    case "view":
      return g.canView || g.canRun || g.canEdit || g.canDelete || g.canShare;
    case "run":
      return g.canRun;
    case "edit":
      return g.canEdit;
    case "delete":
      return g.canDelete;
    case "share":
      return g.canShare;
  }
}

/** Env match (§8.5): a grant applies when its environmentId is null (all envs) or equals
 *  the request's RESOLVED env. An undefined request env only matches all-env grants. */
function envMatches(
  g: EffectiveGrant,
  environmentId: string | undefined,
): boolean {
  return g.environmentId === null || g.environmentId === environmentId;
}

/**
 * Authorization resolution for workflow surfaces (RBAC-GROUPS.md §4/§4a, slice G1).
 *
 * THE RULE: a workspace with zero WorkflowGrant rows behaves exactly as today (members and
 * tokens fully functional); the first grant flips `member` users AND `nry_` tokens to
 * deny-by-default, each getting exactly the UNION of their groups' grants. owner/admin USER
 * principals bypass; an ABSENT principal (trigger-fired/scheduled runs, internal callers)
 * is never checked — callers simply don't invoke this without an actor.
 *
 * Enforced via IN-SERVICE asserts (not route guards): the shared services are the only
 * choke points that also cover the v1 public API + MCP. Reads go through a short-TTL cache
 * ({@link PermissionsCache}) invalidated on every group/grant/member write.
 */
@Injectable()
export class PermissionsService {
  constructor(
    private readonly cache: PermissionsCache = new PermissionsCache(),
  ) {}

  /** 403 unless the principal may perform `action` on `workflowKey` in the resolved env. */
  async assertCan(
    principal: Principal,
    action: WorkflowAction,
    workflowKey: string,
    environmentId: string | undefined,
  ): Promise<void> {
    if (!(await this.can(principal, action, workflowKey, environmentId))) {
      throw new ForbiddenException(
        `You don't have permission to ${ACTION_LABEL[action]} this workflow. ` +
          "Ask a workspace owner or admin for access.",
      );
    }
  }

  /** Boolean form of {@link assertCan}. */
  async can(
    principal: Principal,
    action: WorkflowAction,
    workflowKey: string,
    environmentId: string | undefined,
  ): Promise<boolean> {
    const grants = await this.grantsFor(principal);
    if (grants === null) return true; // bypass (owner/admin, unrestricted, cliff)
    return grants.some(
      (g) =>
        allows(g, action) &&
        envMatches(g, environmentId) &&
        (g.scope === "all" || g.keys.includes(workflowKey)),
    );
  }

  /** The subset of `keys` the principal may VIEW in the resolved env (list endpoints
   *  FILTER; single-resource endpoints 403 via assertCan). */
  async filterViewable(
    principal: Principal,
    keys: string[],
    environmentId: string | undefined,
  ): Promise<string[]> {
    const grants = await this.grantsFor(principal);
    if (grants === null) return keys;
    const matching = grants.filter(
      (g) => allows(g, "view") && envMatches(g, environmentId),
    );
    if (matching.some((g) => g.scope === "all")) return keys;
    const viewable = new Set(matching.flatMap((g) => g.keys));
    return keys.filter((k) => viewable.has(k));
  }

  /** May the principal create a NEW workflowKey in this env? `canCreate` is its own verb
   *  (§8.3), valid only on 'all'-scope grants — never inferred from edit. */
  async canCreateWorkflow(
    principal: Principal,
    environmentId: string | undefined,
  ): Promise<boolean> {
    const grants = await this.grantsFor(principal);
    if (grants === null) return true;
    return grants.some(
      (g) => g.canCreate && g.scope === "all" && envMatches(g, environmentId),
    );
  }

  /** 403 unless {@link canCreateWorkflow}. */
  async assertCanCreate(
    principal: Principal,
    environmentId: string | undefined,
  ): Promise<void> {
    if (!(await this.canCreateWorkflow(principal, environmentId))) {
      throw new ForbiddenException(
        "You don't have permission to create workflows in this environment. " +
          "Ask a workspace owner or admin for access.",
      );
    }
  }

  /** The effective matrix for the principal in the resolved env — powers GET /me/permissions. */
  async getEffective(
    principal: Principal,
    environmentId?: string,
  ): Promise<EffectivePermissions> {
    const grants = await this.grantsFor(principal);
    if (grants === null) return { ...FULL_ACCESS };
    const matching = grants.filter((g) => envMatches(g, environmentId));
    const verb = (action: WorkflowAction): VerbAccess => {
      const allowed = matching.filter((g) => allows(g, action));
      if (allowed.some((g) => g.scope === "all"))
        return { all: true, keys: [] };
      return { all: false, keys: [...new Set(allowed.flatMap((g) => g.keys))] };
    };
    return {
      restricted: true,
      canCreate: matching.some((g) => g.canCreate && g.scope === "all"),
      view: verb("view"),
      run: verb("run"),
      edit: verb("edit"),
      delete: verb("delete"),
      share: verb("share"),
    };
  }

  /**
   * Is this tenant under group enforcement (≥1 WorkflowGrant anywhere in the workspace)?
   * THE restriction switch (§4/§8.6): the AuthGuard calls this per `nry_` request to decide
   * whether to stamp the token `member`+tokenId, so it's cached (short TTL + explicit
   * invalidation) — no hot-path query in steady state.
   */
  async isTenantEnforced(tenantId: string): Promise<boolean> {
    const cached = this.cache.getEnforced(tenantId);
    if (cached !== undefined) return cached;
    const row = await getPrisma().workflowGrant.findFirst({
      where: { tenantId },
      select: { id: true },
    });
    const enforced = row !== null;
    this.cache.setEnforced(tenantId, enforced);
    return enforced;
  }

  /** Drop the tenant's cached enforcement flag + every subject's cached grants. MUST be
   *  called by every group/grant/member/token-member write (GroupsService does). */
  invalidateTenant(tenantId: string): void {
    this.cache.invalidateTenant(tenantId);
  }

  /**
   * The principal's effective grants, or null for a BYPASSED subject:
   *  - owner/admin USER principals (and any principal that isn't a gated subject);
   *  - restricted subjects in a workspace with ZERO grants (the cliff — full access);
   * A `member` user resolves by userId; a restricted token (principal.tokenId) by tokenId.
   */
  private async grantsFor(
    principal: Principal | undefined,
  ): Promise<EffectiveGrant[] | null> {
    if (!principal) return null; // no actor (internal/trigger caller) — never checked
    const subject = this.subjectKey(principal);
    if (!subject) return null;
    if (!(await this.isTenantEnforced(principal.tenantId))) return null;
    const cached = this.cache.getGrants(principal.tenantId, subject.key);
    if (cached) return cached;
    const rows = await getPrisma().workflowGrant.findMany({
      where: {
        tenantId: principal.tenantId,
        group:
          subject.kind === "token"
            ? { tokenMembers: { some: { tokenId: subject.id } } }
            : { members: { some: { userId: subject.id } } },
      },
      include: { workflows: { select: { workflowKey: true } } },
    });
    const grants: EffectiveGrant[] = rows.map((r) => ({
      environmentId: r.environmentId,
      scope: r.scope === "selected" ? "selected" : "all",
      canView: r.canView,
      canRun: r.canRun,
      canEdit: r.canEdit,
      canDelete: r.canDelete,
      canShare: r.canShare,
      canCreate: r.canCreate,
      keys: r.workflows.map((w) => w.workflowKey),
    }));
    this.cache.setGrants(principal.tenantId, subject.key, grants);
    return grants;
  }

  /** The gated subject behind a principal, or null when it BYPASSES enforcement.
   *  Restricted tokens carry tokenId (stamped by the guard); users are gated only at
   *  role='member' — owner/admin bypass per §4. A principal with neither a member role
   *  nor a tokenId (trigger/internal shapes) is never gated. */
  private subjectKey(
    principal: Principal,
  ): { kind: "user" | "token"; id: string; key: string } | null {
    if (principal.tokenId) {
      return {
        kind: "token",
        id: principal.tokenId,
        key: `t:${principal.tokenId}`,
      };
    }
    if (principal.role === "member" && principal.userId) {
      return {
        kind: "user",
        id: principal.userId,
        key: `u:${principal.userId}`,
      };
    }
    return null;
  }
}
