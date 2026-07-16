import { randomUUID } from "node:crypto";
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { getPrisma } from "@naary/db";

export interface CompanyView {
  id: string;
  name: string;
  slug: string;
  /** The caller's role in this company. */
  role: string;
}

/**
 * Companies foundation (COMPANIES.md Slice 1). A Company groups workspaces for a cross-workspace
 * admin/billing-rollup path; it is NOT an isolation boundary. Everything here is additive — no
 * existing tenantId-scoped query changes.
 *
 * The load-bearing rule is the ATTACH authorization (§4): linking a workspace to a company MUST be
 * authorized by the WORKSPACE OWNER, never by a company admin alone — otherwise a company admin
 * could pull a victim's workspace in and gain cross-workspace read. So attach requires the caller
 * to be BOTH a member of the company AND the owner of the workspace.
 */
@Injectable()
export class CompanyService {
  /** Companies the user is a member of (powers a future "my companies" switcher). */
  async listForUser(userId: string): Promise<CompanyView[]> {
    const rows = await getPrisma().companyMembership.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
      select: {
        role: true,
        company: { select: { id: true, name: true, slug: true } },
      },
    });
    return rows.map((r) => ({
      id: r.company.id,
      name: r.company.name,
      slug: r.company.slug,
      role: r.role,
    }));
  }

  /**
   * Create a company owned by the caller. The id is server-generated; the slug is derived from
   * the name (kebab + short random suffix) so it's URL-safe and collision-resistant. A duplicate
   * slug surfaces as 409, not a 500.
   */
  async create(userId: string, name?: string): Promise<CompanyView> {
    const clean = (name ?? "").trim();
    if (!clean) throw new ConflictException("Company name is required.");
    const slug = `${slugify(clean)}-${randomUUID().slice(0, 6)}`;
    try {
      const company = await getPrisma().company.create({
        data: {
          name: clean,
          slug,
          memberships: { create: { userId, role: "owner" } },
        },
        select: { id: true, name: true, slug: true },
      });
      return { ...company, role: "owner" };
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new ConflictException("A company with that name already exists.");
      }
      throw e;
    }
  }

  /**
   * Attach a workspace to a company. Requires the caller to be a company member AND the workspace
   * owner (§4 two-sided consent). Rejects if the workspace is already attached elsewhere.
   */
  async attachWorkspace(
    userId: string,
    companyId: string,
    tenantId: string,
    ctx: { activeTenantId?: string; activeRole?: string },
  ): Promise<void> {
    await this.assertCompanyMember(userId, companyId);
    if (!(await this.isWorkspaceOwner(userId, tenantId, ctx))) {
      throw new ForbiddenException(
        "Only the workspace owner can attach it to a company.",
      );
    }
    const current = await getPrisma().tenantSettings.findUnique({
      where: { tenantId },
      select: { companyId: true },
    });
    if (current?.companyId && current.companyId !== companyId) {
      throw new ConflictException(
        "That workspace is already attached to another company.",
      );
    }
    await getPrisma().tenantSettings.upsert({
      where: { tenantId },
      create: { tenantId, companyId },
      update: { companyId },
    });
  }

  /**
   * Detach a workspace from a company. Allowed from EITHER side (§4): a company admin/owner, OR
   * the workspace owner. Only clears the link if the workspace is actually attached to THIS company.
   */
  async detachWorkspace(
    userId: string,
    companyId: string,
    tenantId: string,
    ctx: { activeTenantId?: string; activeRole?: string },
  ): Promise<void> {
    const settings = await getPrisma().tenantSettings.findUnique({
      where: { tenantId },
      select: { companyId: true },
    });
    if (settings?.companyId !== companyId) {
      throw new NotFoundException(
        "That workspace is not attached to this company.",
      );
    }
    const isCompanyAdmin = (await this.companyRole(userId, companyId)) !== null;
    const isOwner = await this.isWorkspaceOwner(userId, tenantId, ctx);
    if (!isCompanyAdmin && !isOwner) {
      throw new ForbiddenException(
        "Only a company admin or the workspace owner can detach it.",
      );
    }
    await getPrisma().tenantSettings.update({
      where: { tenantId },
      data: { companyId: null },
    });
  }

  /** The caller's role in a company, or null if they're not a member. */
  private async companyRole(
    userId: string,
    companyId: string,
  ): Promise<string | null> {
    const m = await getPrisma().companyMembership.findUnique({
      where: { companyId_userId: { companyId, userId } },
      select: { role: true },
    });
    return m?.role ?? null;
  }

  private async assertCompanyMember(
    userId: string,
    companyId: string,
  ): Promise<void> {
    if ((await this.companyRole(userId, companyId)) === null) {
      throw new ForbiddenException("You are not a member of this company.");
    }
  }

  /**
   * Is the user the OWNER of the workspace? Reads the (userId, tenantId) Membership. Membership
   * rows are lazily backfilled on /me/workspaces, so a claim-provisioned owner may not have one
   * yet — accept the AuthGuard-resolved active-workspace role as owner-proof for that case.
   */
  private async isWorkspaceOwner(
    userId: string,
    tenantId: string,
    ctx: { activeTenantId?: string; activeRole?: string },
  ): Promise<boolean> {
    const m = await getPrisma().membership.findUnique({
      where: { userId_tenantId: { userId, tenantId } },
      select: { role: true },
    });
    if (m?.role === "owner") return true;
    return ctx.activeTenantId === tenantId && ctx.activeRole === "owner";
  }
}

/** name → url-safe kebab slug (letters/digits, single dashes). Empty → "company". */
function slugify(s: string): string {
  const out = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return out || "company";
}

function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { code?: string }).code === "P2002"
  );
}
