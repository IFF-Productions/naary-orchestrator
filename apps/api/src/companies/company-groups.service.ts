import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { getPrisma } from "@naary/db";
import { PermissionsService } from "../permissions/permissions.service";
import { CompanyService } from "./company.service";

/** The six verbs of a company-wide grant (v1: always 'all'-scope + all-environments —
 *  CompanyWorkflowGrant deliberately has no scope/keys/env columns; see the model comment). */
export interface CompanyGrantView {
  id: string;
  canView: boolean;
  canRun: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canShare: boolean;
  canCreate: boolean;
  createdAt: string;
}

export interface CompanyGroupView {
  id: string;
  name: string;
  createdAt: string;
  members: { userId: string; createdAt: string }[];
  /** The group's single grant, or null while none is set. ONE grant per group: at
   *  'all'-scope the union of several rows is just the OR of their booleans, so a second
   *  row could never express anything a single row can't — PUT upserts it. */
  grant: CompanyGrantView | null;
}

/** The verb set a grant PUT carries (replace semantics: absent = false). */
export interface CompanyGrantInput {
  canView?: boolean;
  canRun?: boolean;
  canEdit?: boolean;
  canDelete?: boolean;
  canShare?: boolean;
  canCreate?: boolean;
}

const GROUP_INCLUDE = {
  members: { orderBy: { createdAt: "asc" } },
  grants: { orderBy: { createdAt: "asc" } },
} as const;

interface GroupRow {
  id: string;
  name: string;
  createdAt: Date;
  members: { userId: string; createdAt: Date }[];
  grants: {
    id: string;
    canView: boolean;
    canRun: boolean;
    canEdit: boolean;
    canDelete: boolean;
    canShare: boolean;
    canCreate: boolean;
    createdAt: Date;
  }[];
}

/**
 * Company-wide permission groups (RBAC-GROUPS §9 / COMPANIES §9): a SECOND grant source
 * unioned into workspace permission resolution for COMPANY-group members — but only where a
 * workspace has ALREADY restricted them (its own first-grant cliff). Company grants never
 * flip a workspace's cliff, apply to every workflow in every attached workspace in every
 * environment (v1 bounds), and are uid-keyed only (never tokens).
 *
 * Every method is company-OWNER-gated (CompanyService.assertCompanyOwner — the same altitude
 * as the company budget: these grants reach into every member workspace). Every WRITE fans
 * out invalidation to EVERY attached tenant (PermissionsService.invalidateCompany) so a
 * change — especially a revocation — is visible on the very next request.
 */
@Injectable()
export class CompanyGroupsService {
  constructor(
    private readonly companies: CompanyService,
    private readonly permissions: PermissionsService,
  ) {}

  async list(userId: string, companyId: string): Promise<CompanyGroupView[]> {
    await this.companies.assertCompanyOwner(userId, companyId);
    const rows = await getPrisma().companyPermissionGroup.findMany({
      where: { companyId },
      orderBy: { createdAt: "asc" },
      include: GROUP_INCLUDE,
    });
    return rows.map((g) => this.view(g));
  }

  async create(
    userId: string,
    companyId: string,
    name: string,
  ): Promise<CompanyGroupView> {
    await this.companies.assertCompanyOwner(userId, companyId);
    const trimmed = name?.trim();
    if (!trimmed) throw new BadRequestException("Group name is required.");
    try {
      const row = await getPrisma().companyPermissionGroup.create({
        data: { companyId, name: trimmed },
        include: GROUP_INCLUDE,
      });
      await this.permissions.invalidateCompany(companyId);
      return this.view(row);
    } catch (err) {
      if ((err as { code?: string })?.code === "P2002") {
        throw new ConflictException(
          `A group named '${trimmed}' already exists in this company.`,
        );
      }
      throw err;
    }
  }

  async rename(
    userId: string,
    companyId: string,
    groupId: string,
    name: string,
  ): Promise<CompanyGroupView> {
    await this.companies.assertCompanyOwner(userId, companyId);
    const trimmed = name?.trim();
    if (!trimmed) throw new BadRequestException("Group name is required.");
    await this.getOwned(companyId, groupId);
    try {
      const row = await getPrisma().companyPermissionGroup.update({
        where: { id: groupId },
        data: { name: trimmed },
        include: GROUP_INCLUDE,
      });
      return this.view(row);
    } catch (err) {
      if ((err as { code?: string })?.code === "P2002") {
        throw new ConflictException(
          `A group named '${trimmed}' already exists in this company.`,
        );
      }
      throw err;
    }
  }

  /** Delete a group — cascades its members and grant, revoking that access in EVERY
   *  attached workspace where the subjects were restricted. */
  async remove(
    userId: string,
    companyId: string,
    groupId: string,
  ): Promise<void> {
    await this.companies.assertCompanyOwner(userId, companyId);
    await this.getOwned(companyId, groupId);
    await getPrisma().companyPermissionGroup.delete({ where: { id: groupId } });
    await this.permissions.invalidateCompany(companyId);
  }

  /** Add a user to a group. The target must hold a CompanyMembership in THIS company
   *  (400 otherwise) — company groups reference company members, never free uids.
   *  Idempotent. */
  async addMember(
    userId: string,
    companyId: string,
    groupId: string,
    targetUserId: string,
  ): Promise<void> {
    await this.companies.assertCompanyOwner(userId, companyId);
    await this.getOwned(companyId, groupId);
    const membership = await getPrisma().companyMembership.findUnique({
      where: { companyId_userId: { companyId, userId: targetUserId } },
      select: { userId: true },
    });
    if (!membership) {
      throw new BadRequestException(
        "That user is not a member of this company — add them to the company first.",
      );
    }
    await getPrisma().companyGroupMember.upsert({
      where: { groupId_userId: { groupId, userId: targetUserId } },
      create: { groupId, userId: targetUserId },
      update: {},
    });
    await this.permissions.invalidateCompany(companyId);
  }

  async removeMember(
    userId: string,
    companyId: string,
    groupId: string,
    targetUserId: string,
  ): Promise<void> {
    await this.companies.assertCompanyOwner(userId, companyId);
    await this.getOwned(companyId, groupId);
    await getPrisma().companyGroupMember.deleteMany({
      where: { groupId, userId: targetUserId },
    });
    await this.permissions.invalidateCompany(companyId);
  }

  /**
   * Upsert the group's single grant row (PUT replace semantics: absent verbs = false).
   * An all-false grant is legal and contributes nothing to the union — functionally a
   * revocation without deleting the row.
   */
  async setGrant(
    userId: string,
    companyId: string,
    groupId: string,
    input: CompanyGrantInput,
  ): Promise<CompanyGrantView> {
    await this.companies.assertCompanyOwner(userId, companyId);
    await this.getOwned(companyId, groupId);
    const data = {
      canView: input.canView ?? false,
      canRun: input.canRun ?? false,
      canEdit: input.canEdit ?? false,
      canDelete: input.canDelete ?? false,
      canShare: input.canShare ?? false,
      canCreate: input.canCreate ?? false,
    };
    const p = getPrisma();
    const existing = await p.companyWorkflowGrant.findFirst({
      where: { groupId },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    const row = existing
      ? await p.companyWorkflowGrant.update({
          where: { id: existing.id },
          data,
        })
      : await p.companyWorkflowGrant.create({ data: { groupId, ...data } });
    await this.permissions.invalidateCompany(companyId);
    return this.grantView(row);
  }

  /** The group, company-scoped — 404 when it isn't THIS company's (never cross-company). */
  private async getOwned(companyId: string, groupId: string): Promise<void> {
    const row = await getPrisma().companyPermissionGroup.findFirst({
      where: { id: groupId, companyId },
      select: { id: true },
    });
    if (!row) throw new NotFoundException("No such group.");
  }

  private view(g: GroupRow): CompanyGroupView {
    return {
      id: g.id,
      name: g.name,
      createdAt: g.createdAt.toISOString(),
      members: g.members.map((m) => ({
        userId: m.userId,
        createdAt: m.createdAt.toISOString(),
      })),
      grant: g.grants.length > 0 ? this.grantView(g.grants[0]) : null,
    };
  }

  private grantView(r: GroupRow["grants"][number]): CompanyGrantView {
    return {
      id: r.id,
      canView: r.canView,
      canRun: r.canRun,
      canEdit: r.canEdit,
      canDelete: r.canDelete,
      canShare: r.canShare,
      canCreate: r.canCreate,
      createdAt: r.createdAt.toISOString(),
    };
  }
}
