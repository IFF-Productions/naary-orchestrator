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

/**
 * One per-environment VIEW term for a RESTRICTED subject — the shared shape behind the
 * runs-list where-builder (ExecutionsService.runViewFilter) and the usage/insights filters
 * (UsageService). Semantics both consumers must honor:
 *  - a row belongs to the term whose `environmentId` matches; a row with a NULL
 *    environmentId (pre-env rows) belongs to the term with `includesNullEnv` (the DEFAULT
 *    env owns legacy env-less rows);
 *  - within a matching term, `view.all` ⇒ every KEYED row; else the row's workflowKey must
 *    be in `view.keys`. A row with NO workflowKey is NEVER visible to a restricted subject.
 */
export interface EnvViewTerm {
  environmentId: string;
  /** true when this env is the tenant default — rows with a NULL environmentId belong to it. */
  includesNullEnv: boolean;
  /** The subject's effective view in this env: everything, or exactly `keys`. */
  view: VerbAccess;
}

/**
 * Build the per-env view terms for `actor`, or null when the caller is unrestricted /
 * absent (consumers then leave their query/filter byte-identical — the common path).
 * Standalone (takes the perms + env sources as arguments) so ExecutionsService can keep
 * feeding its own EnvironmentsService + mocked PermissionsService — the extraction is a
 * pure refactor there, proven by its unchanged tests. `listEnvs` is lazy: it is only
 * consulted for RESTRICTED subjects. An empty array = nothing viewable anywhere
 * (deny-by-default), which is distinct from null (bypass).
 */
export async function buildViewTerms(
  perms: Pick<PermissionsService, "getEffective">,
  actor: Principal | undefined,
  listEnvs: () => Promise<Array<{ id: string; isDefault: boolean }>>,
): Promise<EnvViewTerm[] | null> {
  if (!actor) return null;
  const eff = await perms.getEffective(actor);
  if (!eff.restricted) return null;
  const terms: EnvViewTerm[] = [];
  for (const env of await listEnvs()) {
    const effEnv = await perms.getEffective(actor, env.id);
    // Nothing viewable in this env — no term.
    if (!effEnv.view.all && effEnv.view.keys.length === 0) continue;
    terms.push({
      environmentId: env.id,
      includesNullEnv: env.isDefault,
      view: effEnv.view,
    });
  }
  return terms;
}

/** May a restricted subject (holding `terms`) see a row tagged (environmentId, workflowKey)?
 *  Encodes the two EnvViewTerm edge rules: NULL environmentId rows belong to the default
 *  env's term; NULL-workflowKey rows are visible only to UNRESTRICTED subjects (call this
 *  only when terms !== null). */
export function viewTermsAllow(
  terms: EnvViewTerm[],
  environmentId: string | null,
  workflowKey: string | null,
): boolean {
  if (workflowKey === null) return false;
  const term = terms.find((t) =>
    environmentId === null
      ? t.includesNullEnv
      : t.environmentId === environmentId,
  );
  if (!term) return false;
  return term.view.all || term.view.keys.includes(workflowKey);
}

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
   * The per-env view terms for `actor` (see {@link EnvViewTerm}), or null for a bypassed /
   * unrestricted caller. The env list comes straight from the Environment table (every
   * request path has already ensured the default env exists via resolveEnvId), default
   * first for stable output. Consumed by UsageService to filter the usage ledger to the
   * subject's viewable workflows; ExecutionsService builds the same terms through
   * {@link buildViewTerms} with its own EnvironmentsService.
   */
  async viewTerms(
    actor: Principal | undefined,
    tenantId: string,
  ): Promise<EnvViewTerm[] | null> {
    return buildViewTerms(this, actor, async () =>
      getPrisma().environment.findMany({
        where: { tenantId },
        orderBy: [{ isDefault: "desc" }, { name: "asc" }],
        select: { id: true, isDefault: true },
      }),
    );
  }

  /**
   * Does this tenant have ≥1 TagGrant row anywhere? THE tag-edit gate switch: with any
   * TagGrant, tag membership carries access, so `setWorkflowTags` requires SHARE (promote)
   * instead of edit (user-confirmed rule; zero rows keeps today's edit-gate). Cached
   * beside {@link isTenantEnforced} (short TTL + explicit invalidation) — it sits on the
   * tags PUT path.
   */
  async tenantHasTagGrants(tenantId: string): Promise<boolean> {
    const cached = this.cache.getTagGranted(tenantId);
    if (cached !== undefined) return cached;
    const row = await getPrisma().tagGrant.findFirst({
      where: { grant: { tenantId } },
      select: { grantId: true },
    });
    const has = row !== null;
    this.cache.setTagGranted(tenantId, has);
    return has;
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
   * Company-write fan-out: a company group/member/grant write (CompanyGroupsService) or a
   * workspace attach/detach (CompanyService) changes the COMPANY term of every attached
   * workspace's resolution, so every attached tenant's cache must drop — company grants are
   * cached inside the same per-subject grants entries as workspace grants.
   */
  async invalidateCompany(companyId: string): Promise<void> {
    const tenants = await getPrisma().tenantSettings.findMany({
      where: { companyId },
      select: { tenantId: true },
    });
    for (const t of tenants) this.cache.invalidateTenant(t.tenantId);
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
      include: {
        workflows: { select: { workflowKey: true } },
        tagGrants: { select: { tagId: true } },
      },
    });
    // Tag expansion (§9 seam, shipped): a 'selected' grant's effective keys = its explicit
    // key list ∪ the workflowKeys carrying ANY of its TagGrant tags — resolved here (ONE
    // batched WorkflowTag lookup across every tag of every grant, grouped in JS) and baked
    // into the cached flattened keys so downstream matching is unchanged. Cache
    // correctness: tag membership now changes effective access, so every access-relevant
    // tag write (attach/detach, tag delete) invalidates the tenant (TagsService).
    const tagIds = [
      ...new Set(rows.flatMap((r) => (r.tagGrants ?? []).map((t) => t.tagId))),
    ];
    const keysByTag = new Map<string, string[]>();
    if (tagIds.length > 0) {
      const tagged = await getPrisma().workflowTag.findMany({
        where: { tenantId: principal.tenantId, tagId: { in: tagIds } },
        select: { tagId: true, workflowKey: true },
      });
      for (const t of tagged) {
        const list = keysByTag.get(t.tagId);
        if (list) list.push(t.workflowKey);
        else keysByTag.set(t.tagId, [t.workflowKey]);
      }
    }
    const grants: EffectiveGrant[] = rows.map((r) => ({
      environmentId: r.environmentId,
      scope: r.scope === "selected" ? "selected" : "all",
      canView: r.canView,
      canRun: r.canRun,
      canEdit: r.canEdit,
      canDelete: r.canDelete,
      canShare: r.canShare,
      canCreate: r.canCreate,
      keys: [
        ...new Set([
          ...r.workflows.map((w) => w.workflowKey),
          ...(r.tagGrants ?? []).flatMap((t) => keysByTag.get(t.tagId) ?? []),
        ]),
      ],
    }));
    // Company union (RBAC-GROUPS §9 / COMPANIES §9): a SECOND grant source for subjects the
    // workspace has ALREADY restricted. Placement is the cliff-non-flip invariant: this runs
    // strictly AFTER the isTenantEnforced gate above, so a company grant can never restrict
    // (or otherwise touch) an unenforced workspace — it only ADDS access back. uid-keyed
    // USERS only: tokens are workspace-scoped subjects and never receive company grants.
    if (subject.kind === "user") {
      grants.push(
        ...(await this.companyGrantsFor(principal.tenantId, subject.id)),
      );
    }
    this.cache.setGrants(principal.tenantId, subject.key, grants);
    return grants;
  }

  /**
   * The RESTRICTED user's company grants, mapped to all-scope/all-env EffectiveGrants
   * (v1 bounds: CompanyWorkflowGrant carries no scope/keys/env — per-key and per-env
   * selections don't compose across workspaces; that's a documented future seam). The
   * `companyId` equality inside the where is the cross-company isolation: only groups of
   * THE company this workspace is attached to can contribute. Cached by the caller inside
   * the same per-subject grants entry; company writes fan out via invalidateCompany.
   */
  private async companyGrantsFor(
    tenantId: string,
    userId: string,
  ): Promise<EffectiveGrant[]> {
    const settings = await getPrisma().tenantSettings.findUnique({
      where: { tenantId },
      select: { companyId: true },
    });
    if (!settings?.companyId) return [];
    const rows = await getPrisma().companyWorkflowGrant.findMany({
      where: {
        group: {
          companyId: settings.companyId,
          members: { some: { userId } },
        },
      },
    });
    return rows.map((r) => ({
      environmentId: null, // all environments (v1)
      scope: "all" as const, // all workflows in the workspace (v1)
      canView: r.canView,
      canRun: r.canRun,
      canEdit: r.canEdit,
      canDelete: r.canDelete,
      canShare: r.canShare,
      canCreate: r.canCreate,
      keys: [],
    }));
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
