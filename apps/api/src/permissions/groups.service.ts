import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { getPrisma } from "@naary/db";
import type { Principal } from "../auth/tenant.decorator";
import { PermissionsService } from "./permissions.service";

/** A grant as the API returns it (env id + scope + the six verbs + key list + tag list). */
export interface GrantView {
  id: string;
  environmentId: string | null;
  scope: "all" | "selected";
  canView: boolean;
  canRun: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canShare: boolean;
  canCreate: boolean;
  workflowKeys: string[];
  /** Tag ids this 'selected' grant carries (§9 seam): effective keys = workflowKeys ∪ the
   *  keys tagged with ANY of these. Empty for scope 'all'. */
  tagIds: string[];
}

export interface GroupView {
  id: string;
  name: string;
  createdAt: string;
  members: { userId: string; createdAt: string }[];
  tokens: { tokenId: string; createdAt: string }[];
  grants: GrantView[];
}

/** The verb + scope fields a grant create/update carries. */
export interface GrantInput {
  environmentId?: string | null;
  scope?: string;
  canView?: boolean;
  canRun?: boolean;
  canEdit?: boolean;
  canDelete?: boolean;
  canShare?: boolean;
  canCreate?: boolean;
  workflowKeys?: string[];
  /** Tag ids for scope 'selected' (replace-set on update; must belong to the tenant).
   *  Ignored for scope 'all' — like workflowKeys. */
  tagIds?: string[];
}

/** Group/grant CRUD requires owner|admin (RBAC-GROUPS.md §4 — same gate as member
 *  management; `share` deliberately grants NO grant-editing power, §8.2). */
function assertManager(caller: Principal): void {
  if (caller.role !== "owner" && caller.role !== "admin") {
    throw new ForbiddenException(
      "Managing permission groups requires the owner or admin role.",
    );
  }
}

const GRANT_INCLUDE = {
  workflows: { select: { workflowKey: true } },
  tagGrants: { select: { tagId: true } },
} as const;

/** The grant row shape the service reads back (with its key + tag lists included). */
interface GrantRow {
  id: string;
  environmentId: string | null;
  scope: string;
  canView: boolean;
  canRun: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canShare: boolean;
  canCreate: boolean;
  workflows: { workflowKey: string }[];
  tagGrants?: { tagId: string }[];
}

/**
 * Permission-group + grant management (RBAC-GROUPS.md §3/§4, slice G1). Every method is
 * tenant-scoped (the group must belong to the caller's workspace — 404 otherwise) and
 * owner/admin-gated. Every WRITE invalidates the tenant's permissions cache so a change
 * (especially a revocation) is visible on the very next request.
 */
@Injectable()
export class GroupsService {
  constructor(private readonly permissions: PermissionsService) {}

  async list(tenantId: string, caller: Principal): Promise<GroupView[]> {
    assertManager(caller);
    const rows = await getPrisma().permissionGroup.findMany({
      where: { tenantId },
      orderBy: { createdAt: "asc" },
      include: {
        members: true,
        tokenMembers: true,
        grants: { include: GRANT_INCLUDE },
      },
    });
    return rows.map((g) => this.view(g));
  }

  async create(
    tenantId: string,
    caller: Principal,
    name: string,
  ): Promise<GroupView> {
    assertManager(caller);
    const trimmed = name?.trim();
    if (!trimmed) throw new BadRequestException("Group name is required.");
    try {
      const row = await getPrisma().permissionGroup.create({
        data: { tenantId, name: trimmed },
        include: {
          members: true,
          tokenMembers: true,
          grants: { include: GRANT_INCLUDE },
        },
      });
      return this.view(row);
    } catch (err) {
      if ((err as { code?: string })?.code === "P2002") {
        throw new ConflictException(
          `A group named '${trimmed}' already exists in this workspace.`,
        );
      }
      throw err;
    }
  }

  async rename(
    tenantId: string,
    caller: Principal,
    groupId: string,
    name: string,
  ): Promise<GroupView> {
    assertManager(caller);
    const trimmed = name?.trim();
    if (!trimmed) throw new BadRequestException("Group name is required.");
    await this.getOwned(tenantId, groupId);
    try {
      const row = await getPrisma().permissionGroup.update({
        where: { id: groupId },
        data: { name: trimmed },
        include: {
          members: true,
          tokenMembers: true,
          grants: { include: GRANT_INCLUDE },
        },
      });
      return this.view(row);
    } catch (err) {
      if ((err as { code?: string })?.code === "P2002") {
        throw new ConflictException(
          `A group named '${trimmed}' already exists in this workspace.`,
        );
      }
      throw err;
    }
  }

  /** Delete a group. Cascades its members, token members, and grants — which may LIFT the
   *  tenant off the cliff (last grant gone ⇒ everyone unrestricted again). */
  async remove(
    tenantId: string,
    caller: Principal,
    groupId: string,
  ): Promise<void> {
    assertManager(caller);
    await this.getOwned(tenantId, groupId);
    await getPrisma().permissionGroup.delete({ where: { id: groupId } });
    this.permissions.invalidateTenant(tenantId);
  }

  /** Add a USER to a group. The target must hold a Membership in the tenant (400
   *  otherwise) — groups reference real members, never free-floating uids. Idempotent. */
  async addMember(
    tenantId: string,
    caller: Principal,
    groupId: string,
    userId: string,
  ): Promise<void> {
    assertManager(caller);
    await this.getOwned(tenantId, groupId);
    const membership = await getPrisma().membership.findUnique({
      where: { userId_tenantId: { userId, tenantId } },
    });
    if (!membership) {
      throw new BadRequestException(
        "That user is not a member of this workspace — invite them first.",
      );
    }
    await getPrisma().groupMember.upsert({
      where: { groupId_userId: { groupId, userId } },
      create: { groupId, userId },
      update: {},
    });
    this.permissions.invalidateTenant(tenantId);
  }

  async removeMember(
    tenantId: string,
    caller: Principal,
    groupId: string,
    userId: string,
  ): Promise<void> {
    assertManager(caller);
    await this.getOwned(tenantId, groupId);
    await getPrisma().groupMember.deleteMany({ where: { groupId, userId } });
    this.permissions.invalidateTenant(tenantId);
  }

  /** Attach an API TOKEN to a group (§4a — how a restricted token gets access back).
   *  The token must belong to the tenant (400 otherwise). Idempotent. */
  async addToken(
    tenantId: string,
    caller: Principal,
    groupId: string,
    tokenId: string,
  ): Promise<void> {
    assertManager(caller);
    await this.getOwned(tenantId, groupId);
    const token = await getPrisma().apiToken.findFirst({
      where: { id: tokenId, tenantId },
      select: { id: true },
    });
    if (!token) {
      throw new BadRequestException(
        "That API token does not belong to this workspace.",
      );
    }
    await getPrisma().groupTokenMember.upsert({
      where: { groupId_tokenId: { groupId, tokenId } },
      create: { groupId, tokenId },
      update: {},
    });
    this.permissions.invalidateTenant(tenantId);
  }

  async removeToken(
    tenantId: string,
    caller: Principal,
    groupId: string,
    tokenId: string,
  ): Promise<void> {
    assertManager(caller);
    await this.getOwned(tenantId, groupId);
    await getPrisma().groupTokenMember.deleteMany({
      where: { groupId, tokenId },
    });
    this.permissions.invalidateTenant(tenantId);
  }

  /** Create a grant on a group. This may be the tenant's FIRST grant — the cliff (§4):
   *  from the next request on, every member and every ungrouped token is deny-by-default. */
  async createGrant(
    tenantId: string,
    caller: Principal,
    groupId: string,
    input: GrantInput,
  ): Promise<GrantView> {
    assertManager(caller);
    await this.getOwned(tenantId, groupId);
    const scope = input.scope === "selected" ? "selected" : "all";
    if (
      input.scope !== undefined &&
      input.scope !== "all" &&
      input.scope !== "selected"
    ) {
      throw new BadRequestException("scope must be 'all' or 'selected'.");
    }
    this.assertCreateCoherent(scope, input.canCreate ?? false);
    const environmentId = await this.resolveGrantEnv(
      tenantId,
      input.environmentId,
    );
    const keys =
      scope === "selected" ? this.normalizeKeys(input.workflowKeys) : [];
    const tagIds =
      scope === "selected"
        ? await this.validTagIds(tenantId, input.tagIds)
        : [];
    const row = await getPrisma().workflowGrant.create({
      data: {
        tenantId,
        groupId,
        environmentId,
        scope,
        canView: input.canView ?? false,
        canRun: input.canRun ?? false,
        canEdit: input.canEdit ?? false,
        canDelete: input.canDelete ?? false,
        canShare: input.canShare ?? false,
        canCreate: input.canCreate ?? false,
        workflows: { create: keys.map((workflowKey) => ({ workflowKey })) },
        ...(tagIds.length > 0
          ? { tagGrants: { create: tagIds.map((tagId) => ({ tagId })) } }
          : {}),
      },
      include: GRANT_INCLUDE,
    });
    this.permissions.invalidateTenant(tenantId);
    return this.grantView(row);
  }

  /** Update a grant (partial: verbs, scope, env, replace-set key list). Validates the
   *  RESULTING canCreate×scope combination, not just the patch (§8.3). */
  async updateGrant(
    tenantId: string,
    caller: Principal,
    groupId: string,
    grantId: string,
    input: GrantInput,
  ): Promise<GrantView> {
    assertManager(caller);
    await this.getOwned(tenantId, groupId);
    const existing = await getPrisma().workflowGrant.findFirst({
      where: { id: grantId, groupId, tenantId },
    });
    if (!existing) throw new NotFoundException("No such grant.");
    if (
      input.scope !== undefined &&
      input.scope !== "all" &&
      input.scope !== "selected"
    ) {
      throw new BadRequestException("scope must be 'all' or 'selected'.");
    }
    const scope =
      (input.scope ?? existing.scope) === "selected" ? "selected" : "all";
    const canCreate = input.canCreate ?? existing.canCreate;
    this.assertCreateCoherent(scope, canCreate);
    const environmentId =
      input.environmentId === undefined
        ? existing.environmentId
        : await this.resolveGrantEnv(tenantId, input.environmentId);
    const p = getPrisma();
    const keys =
      scope === "selected"
        ? input.workflowKeys !== undefined
          ? this.normalizeKeys(input.workflowKeys)
          : undefined // keep the existing key list
        : []; // 'all' scope carries no key list
    const tagIds =
      scope === "selected"
        ? input.tagIds !== undefined
          ? await this.validTagIds(tenantId, input.tagIds)
          : undefined // keep the existing tag list
        : []; // 'all' scope carries no tag list
    const update = p.workflowGrant.update({
      where: { id: grantId },
      data: {
        environmentId,
        scope,
        canView: input.canView ?? existing.canView,
        canRun: input.canRun ?? existing.canRun,
        canEdit: input.canEdit ?? existing.canEdit,
        canDelete: input.canDelete ?? existing.canDelete,
        canShare: input.canShare ?? existing.canShare,
        canCreate,
        ...(keys !== undefined && keys.length > 0
          ? {
              workflows: {
                create: keys.map((workflowKey) => ({ workflowKey })),
              },
            }
          : {}),
        ...(tagIds !== undefined && tagIds.length > 0
          ? { tagGrants: { create: tagIds.map((tagId) => ({ tagId })) } }
          : {}),
      },
      include: GRANT_INCLUDE,
    });
    let row: Awaited<typeof update>;
    if (keys === undefined && tagIds === undefined) {
      // Neither list touched — a single update suffices.
      row = await update;
    } else {
      // Replace-set: for each TOUCHED list, clear the old rows and write the new ones
      // atomically alongside the update. An untouched list never costs a delete.
      const clears = [
        ...(keys !== undefined
          ? [p.workflowGrantKey.deleteMany({ where: { grantId } })]
          : []),
        ...(tagIds !== undefined
          ? [p.tagGrant.deleteMany({ where: { grantId } })]
          : []),
      ];
      const results = await p.$transaction([...clears, update]);
      row = results[results.length - 1] as Awaited<typeof update>;
    }
    this.permissions.invalidateTenant(tenantId);
    return this.grantView(row);
  }

  /** Delete a grant. Removing the tenant's LAST grant lifts the cliff (back to full access). */
  async removeGrant(
    tenantId: string,
    caller: Principal,
    groupId: string,
    grantId: string,
  ): Promise<void> {
    assertManager(caller);
    await this.getOwned(tenantId, groupId);
    const { count } = await getPrisma().workflowGrant.deleteMany({
      where: { id: grantId, groupId, tenantId },
    });
    if (count === 0) throw new NotFoundException("No such grant.");
    this.permissions.invalidateTenant(tenantId);
  }

  /** §8.3: canCreate is coherent only on 'all'-scope grants — a 'selected'-scope creator
   *  would immediately lose sight of their own new workflow. */
  private assertCreateCoherent(scope: string, canCreate: boolean): void {
    if (canCreate && scope !== "all") {
      throw new BadRequestException(
        "canCreate is only valid on 'all'-scope grants — a 'selected'-scope creator " +
          "couldn't see their own new workflow.",
      );
    }
  }

  /** null/undefined ⇒ all-envs grant; otherwise the env must belong to the tenant (400). */
  private async resolveGrantEnv(
    tenantId: string,
    environmentId: string | null | undefined,
  ): Promise<string | null> {
    if (environmentId === undefined || environmentId === null) return null;
    const env = await getPrisma().environment.findFirst({
      where: { id: environmentId, tenantId },
      select: { id: true },
    });
    if (!env) {
      throw new BadRequestException(
        "environmentId does not name an environment of this workspace.",
      );
    }
    return env.id;
  }

  private normalizeKeys(keys: string[] | undefined): string[] {
    return [...new Set((keys ?? []).map((k) => k.trim()).filter(Boolean))];
  }

  /** Dedupe + validate that every tag id belongs to the tenant (400 otherwise — never
   *  reference a foreign tenant's tag from a grant). */
  private async validTagIds(
    tenantId: string,
    tagIds: string[] | undefined,
  ): Promise<string[]> {
    const unique = [...new Set((tagIds ?? []).filter(Boolean))];
    if (unique.length === 0) return [];
    const owned = await getPrisma().tag.findMany({
      where: { id: { in: unique }, tenantId },
      select: { id: true },
    });
    if (owned.length !== unique.length) {
      throw new BadRequestException(
        "One or more tag ids are unknown for this workspace.",
      );
    }
    return unique;
  }

  /** The group, tenant-scoped — 404 when it isn't this workspace's (never cross-tenant). */
  private async getOwned(tenantId: string, groupId: string) {
    const row = await getPrisma().permissionGroup.findFirst({
      where: { id: groupId, tenantId },
      select: { id: true },
    });
    if (!row) throw new NotFoundException("No such group.");
    return row;
  }

  private view(g: {
    id: string;
    name: string;
    createdAt: Date;
    members: { userId: string; createdAt: Date }[];
    tokenMembers: { tokenId: string; createdAt: Date }[];
    grants: GrantRow[];
  }): GroupView {
    return {
      id: g.id,
      name: g.name,
      createdAt: g.createdAt.toISOString(),
      members: g.members.map((m) => ({
        userId: m.userId,
        createdAt: m.createdAt.toISOString(),
      })),
      tokens: g.tokenMembers.map((t) => ({
        tokenId: t.tokenId,
        createdAt: t.createdAt.toISOString(),
      })),
      grants: g.grants.map((gr) => this.grantView(gr)),
    };
  }

  private grantView(r: GrantRow): GrantView {
    return {
      id: r.id,
      environmentId: r.environmentId,
      scope: r.scope === "selected" ? "selected" : "all",
      canView: r.canView,
      canRun: r.canRun,
      canEdit: r.canEdit,
      canDelete: r.canDelete,
      canShare: r.canShare,
      canCreate: r.canCreate,
      workflowKeys: r.workflows.map((w) => w.workflowKey),
      tagIds: (r.tagGrants ?? []).map((t) => t.tagId),
    };
  }
}
