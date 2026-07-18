import { randomUUID } from "node:crypto";
import {
  BadRequestException,
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

/** The cost/tokens/calls totals shared by every company-usage bucket. */
export interface CompanyUsageBucket {
  costUsd: number;
  totalTokens: number;
  calls: number;
}

/** Company-wide usage rollup (COMPANIES.md §5, Slice 2). Tokens + cost only — never text. */
export interface CompanyUsageRollup {
  range: { from: string | null; to: string | null };
  totals: CompanyUsageBucket;
  byWorkspace: Array<
    CompanyUsageBucket & {
      tenantId: string;
      displayName: string | null;
      byEnvironment: Array<
        CompanyUsageBucket & { environmentId: string | null }
      >;
    }
  >;
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
    if (!clean) throw new BadRequestException("Company name is required.");
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
      // The only unique constraint is Company.slug (derived from the name + a random suffix), so a
      // collision here is astronomically unlikely — but surface it as a 409 to retry, not a 500.
      if (isUniqueViolation(e)) {
        throw new ConflictException(
          "Could not create the company (slug collision) — please retry.",
        );
      }
      throw e;
    }
  }

  /**
   * Attach a workspace to a company. Requires the caller to be a company member AND the workspace
   * owner (§4 two-sided consent). Rejects if the workspace is already attached elsewhere.
   *
   * Race-safe claim: the write is a single conditional UPDATE (`updateMany WHERE companyId IS NULL
   * OR = companyId`) — atomic, so two concurrent attaches to DIFFERENT companies can't both win
   * (the first sets companyId; the second's WHERE no longer matches → count 0 → 409). If no
   * TenantSettings row exists yet, create it (a lost create race → P2002 → re-claim).
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
    if (await this.claim(tenantId, companyId)) return;
    // count 0 → the row is missing, or it's attached to another company. Try to create it; if a
    // concurrent create won the PK race, re-claim (it may now be ours or someone else's).
    try {
      await getPrisma().tenantSettings.create({
        data: { tenantId, companyId },
      });
      return;
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      if (await this.claim(tenantId, companyId)) return;
    }
    throw new ConflictException(
      "That workspace is already attached to another company.",
    );
  }

  /** Atomically set companyId iff the workspace is unattached or already ours. Returns true on claim. */
  private async claim(tenantId: string, companyId: string): Promise<boolean> {
    const { count } = await getPrisma().tenantSettings.updateMany({
      where: { tenantId, OR: [{ companyId: null }, { companyId }] },
      data: { companyId },
    });
    return count === 1;
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

  /**
   * Company-wide billing/usage rollup (COMPANIES.md §5, Slice 2): total + per-workspace + nested
   * per-environment spend across the company's member workspaces. Read-only — no change to the
   * billing enforcement path (still one TenantBudget per workspace).
   *
   * AUTHZ (§4): `assertCompanyMember` is the ONLY thing authorizing this cross-workspace read —
   * it runs FIRST, before any workspace enumeration or ledger read, and must never be skipped or
   * reordered. It is safe because attach is owner-authorized (the §4 invariant).
   *
   * One IN-query over the ledger (backed by @@index([tenantId, createdAt])), then a single-pass JS
   * rollup. Privacy: tokens + cost only — the ledger holds no prompt/completion text.
   */
  async getCompanyUsage(
    userId: string,
    companyId: string,
    opts: { from?: string; to?: string } = {},
  ): Promise<CompanyUsageRollup> {
    await this.assertCompanyMember(userId, companyId);

    const { from, to } = opts;
    const range = { from: from ?? null, to: to ?? null };

    // Member workspaces (indexed by @@index([companyId])). Every one is listed in the response,
    // even with zero spend, so the company view shows all workspaces.
    const workspaces = await getPrisma().tenantSettings.findMany({
      where: { companyId },
      select: { tenantId: true, displayName: true },
    });
    if (workspaces.length === 0) {
      return {
        range,
        totals: { costUsd: 0, totalTokens: 0, calls: 0 },
        byWorkspace: [],
      };
    }

    const createdAt =
      from || to
        ? {
            ...(from ? { gte: new Date(from) } : {}),
            ...(to ? { lte: new Date(to) } : {}),
          }
        : undefined;

    const rows = await getPrisma().usageEvent.findMany({
      where: {
        tenantId: { in: workspaces.map((w) => w.tenantId) },
        ...(createdAt ? { createdAt } : {}),
      },
    });

    type EnvBucket = CompanyUsageBucket & { environmentId: string | null };
    const byTenant = new Map<
      string,
      CompanyUsageBucket & { byEnv: Map<string | null, EnvBucket> }
    >();
    for (const w of workspaces) {
      byTenant.set(w.tenantId, {
        costUsd: 0,
        totalTokens: 0,
        calls: 0,
        byEnv: new Map(),
      });
    }

    const totals = { costUsd: 0, totalTokens: 0, calls: 0 };
    for (const r of rows) {
      const ws = byTenant.get(r.tenantId);
      if (!ws) continue; // can't happen — the IN-list is exactly byTenant's keys
      const cost = Number(r.costUsd);
      totals.costUsd += cost;
      totals.totalTokens += r.totalTokens;
      totals.calls += 1;
      ws.costUsd += cost;
      ws.totalTokens += r.totalTokens;
      ws.calls += 1;
      // null buckets rows recorded before env tagging (ENVIRONMENTS.md Slice 6a).
      const envId = r.environmentId ?? null;
      const env = ws.byEnv.get(envId) ?? {
        environmentId: envId,
        costUsd: 0,
        totalTokens: 0,
        calls: 0,
      };
      env.costUsd += cost;
      env.totalTokens += r.totalTokens;
      env.calls += 1;
      ws.byEnv.set(envId, env);
    }

    return {
      range,
      totals: {
        costUsd: round6(totals.costUsd),
        totalTokens: totals.totalTokens,
        calls: totals.calls,
      },
      byWorkspace: workspaces
        .map((w) => {
          // biome-ignore lint/style/noNonNullAssertion: seeded above from the same array
          const agg = byTenant.get(w.tenantId)!;
          return {
            tenantId: w.tenantId,
            displayName: w.displayName ?? null,
            costUsd: round6(agg.costUsd),
            totalTokens: agg.totalTokens,
            calls: agg.calls,
            byEnvironment: [...agg.byEnv.values()]
              .map((e) => ({ ...e, costUsd: round6(e.costUsd) }))
              .sort((a, b) => b.costUsd - a.costUsd),
          };
        })
        .sort((a, b) => b.costUsd - a.costUsd),
    };
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

/** Same 6-dp rounding as usage.service.ts — Decimal(12,6) ledger, avoid float-noise digits. */
const round6 = (n: number) => Number(n.toFixed(6));

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
