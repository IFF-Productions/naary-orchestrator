import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { getPrisma, Prisma } from "@naary/db";
import { monthToDateSpendForTenants } from "@naary/usage";
import { EnvironmentsService } from "../environments/environments.service";
import {
  ExecutionsService,
  type RunPage,
} from "../executions/executions.service";
import { GraphsService, type GraphSummary } from "../graphs/graphs.service";
import { PermissionsService } from "../permissions/permissions.service";

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
      /** Soft-archived (TenantSettings.archivedAt — Slice 4). Additive; rows are never dropped. */
      archived: boolean;
      byEnvironment: Array<
        CompanyUsageBucket & { environmentId: string | null }
      >;
    }
  >;
}

/** One company member (COMPANIES.md Slice 4). Email is enriched from Membership (may be null). */
export interface CompanyMemberView {
  userId: string;
  email: string | null;
  role: string;
}

/** The persisted company-wide budget config (COMPANIES.md §8, Slice 5). */
export interface CompanyBudgetConfig {
  monthlyCapUsd: number;
  onBudgetExceeded: string;
}

/** Company budget view: config (null when unset) + live company-wide month-to-date spend. */
export interface CompanyBudgetView {
  budget: CompanyBudgetConfig | null;
  mtdSpendUsd: number;
  /** monthlyCapUsd − mtdSpendUsd (may be negative); null when no budget is configured. */
  remainingUsd: number | null;
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
  constructor(
    private readonly executions: ExecutionsService,
    private readonly graphs: GraphsService,
    private readonly environments: EnvironmentsService,
    // From the @Global PermissionsModule — no CompaniesModule↔PermissionsModule import edge,
    // so no module cycle. Used for the attach/detach cache fan-out (company grants are part
    // of every attached workspace's permission resolution).
    private readonly permissions: PermissionsService,
  ) {}

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
    if (await this.claim(tenantId, companyId)) {
      await this.permissions.invalidateCompany(companyId);
      return;
    }
    // count 0 → the row is missing, or it's attached to another company. Try to create it; if a
    // concurrent create won the PK race, re-claim (it may now be ours or someone else's).
    try {
      await getPrisma().tenantSettings.create({
        data: { tenantId, companyId },
      });
      await this.permissions.invalidateCompany(companyId);
      return;
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      if (await this.claim(tenantId, companyId)) {
        await this.permissions.invalidateCompany(companyId);
        return;
      }
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
    // Fan-out AFTER the write: the detached tenant is no longer enumerated by
    // invalidateCompany, so drop it explicitly (its members just lost their company grants).
    this.permissions.invalidateTenant(tenantId);
    await this.permissions.invalidateCompany(companyId);
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
      select: { tenantId: true, displayName: true, archivedAt: true },
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
            archived: w.archivedAt != null,
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

  // ---- Slice 3: cross-workspace data VISIBILITY (§7.3) --------------------------------------

  /**
   * §4 gate for every company-path read INTO a workspace: company membership FIRST (the sole
   * cross-workspace authorization), then verify the target workspace is attached to THIS
   * company. Order is non-negotiable; the equality check stops a member of company A reading
   * company B's workspaces by mixing ids.
   */
  private async assertCompanyWorkspace(
    userId: string,
    companyId: string,
    tenantId: string,
  ): Promise<void> {
    await this.assertCompanyMember(userId, companyId);
    const row = await getPrisma().tenantSettings.findUnique({
      where: { tenantId },
      select: { companyId: true },
    });
    if (row?.companyId !== companyId) {
      throw new NotFoundException(
        "That workspace is not attached to this company.",
      );
    }
  }

  /**
   * READ-ONLY page of a member workspace's runs for the company console. Delegates to the
   * tenant-parameterized ExecutionsService.listPage with the TARGET tenant — safe because the
   * §4 gate above ran first (this is the only sanctioned cross-workspace path). Run DETAIL
   * (state/history/graph) stays workspace-gated and is deliberately NOT exposed here.
   */
  async listWorkspaceRuns(
    userId: string,
    companyId: string,
    tenantId: string,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<RunPage> {
    await this.assertCompanyWorkspace(userId, companyId, tenantId);
    return this.executions.listPage(tenantId, opts);
  }

  /**
   * READ-ONLY workflow summaries (names/keys/versions — never graph bodies) of a member
   * workspace, from its DEFAULT environment. NB: defaultEnvId lazily CREATES the default env
   * row on a never-touched workspace — idempotent and identical to any tenant-scoped read.
   */
  async listWorkspaceWorkflows(
    userId: string,
    companyId: string,
    tenantId: string,
  ): Promise<GraphSummary[]> {
    await this.assertCompanyWorkspace(userId, companyId, tenantId);
    const envId = await this.environments.defaultEnvId(tenantId);
    return this.graphs.list(tenantId, envId);
  }

  // ---- Slice 4: company management (§7.4) — workspace rename/archive + member admin ---------

  /**
   * Rename a member workspace's display name (the same TenantSettings.displayName the
   * workspace's own Settings screen edits). §4-gated: company membership + attached-to-THIS-
   * company, checked FIRST, before any write.
   */
  async renameWorkspace(
    userId: string,
    companyId: string,
    tenantId: string,
    displayName: string,
  ): Promise<void> {
    await this.assertCompanyWorkspace(userId, companyId, tenantId);
    const clean = (displayName ?? "").trim();
    if (!clean) throw new BadRequestException("Workspace name is required.");
    if (clean.length > 80) {
      throw new BadRequestException(
        "Workspace name is too long (80 characters max).",
      );
    }
    await getPrisma().tenantSettings.update({
      where: { tenantId },
      data: { displayName: clean },
    });
  }

  /**
   * Soft-archive (or unarchive) a member workspace. Sets/clears TenantSettings.archivedAt —
   * reversible, hides it from the switcher; runs/schedules/budgets are untouched. Idempotent:
   * archiving an archived workspace just refreshes the timestamp; unarchiving a live one is a
   * no-op null write.
   */
  async setWorkspaceArchived(
    userId: string,
    companyId: string,
    tenantId: string,
    archived: boolean,
  ): Promise<void> {
    await this.assertCompanyWorkspace(userId, companyId, tenantId);
    await getPrisma().tenantSettings.update({
      where: { tenantId },
      data: { archivedAt: archived ? new Date() : null },
    });
  }

  /**
   * The company's members, with emails enriched from the per-workspace `Membership` table
   * (CompanyMembership stores only the uid; Membership rows carry the email the user joined
   * with — nullable, so we take the first non-null email per uid). Any company member may list.
   */
  async listMembers(
    userId: string,
    companyId: string,
  ): Promise<CompanyMemberView[]> {
    await this.assertCompanyMember(userId, companyId);
    const rows = await getPrisma().companyMembership.findMany({
      where: { companyId },
      orderBy: { createdAt: "asc" },
      select: { userId: true, role: true },
    });
    const uids = rows.map((r) => r.userId);
    const emails = new Map<string, string>();
    if (uids.length > 0) {
      const memberships = await getPrisma().membership.findMany({
        where: { userId: { in: uids } },
        select: { userId: true, email: true },
      });
      for (const m of memberships) {
        if (m.email && !emails.has(m.userId)) emails.set(m.userId, m.email);
      }
    }
    return rows.map((r) => ({
      userId: r.userId,
      email: emails.get(r.userId) ?? null,
      role: r.role,
    }));
  }

  /**
   * Add (or re-role) a company member by EMAIL. Company OWNER only — the first real
   * owner-vs-admin distinction on the membership surface. NO invitations machinery (that lands
   * with RBAC-GROUPS U1): the email must already resolve to a signed-in account, via the
   * `Membership` table — the uid-carrying authority for who a user is (NOT the inert `Member`
   * directory table, which has no uid). Case-insensitive match, newest row wins.
   *
   * THE LOOKUP IS COMPANY-SCOPED (#1075 decision 3, LDAP-DIRECTORY.md §5 / SAML-SSO.md:136).
   * It used to resolve an email across the ENTIRE INSTANCE with `orderBy: createdAt desc`, so
   * whichever workspace most recently created a `Membership` for that address won — including
   * a workspace with no relationship to this company. That was contained while every
   * Membership was written by a human invite; SCIM makes bulk membership creation routine and
   * automatic, so "newest row wins" becomes easy to hit BY ACCIDENT: an IdP provisioning
   * `finance@acme.example` into its own workspace could hand a stranger's uid to a company
   * owner adding the colleague they actually meant. Restricting the candidate set to the
   * company's OWN workspaces (`TenantSettings.companyId`) makes that unreachable — the target
   * must already be someone this company can see. `orderBy` is kept for the multi-workspace
   * case, but it now only ever picks between rows for the same person inside this company.
   *
   * LAST-OWNER GUARD: re-adding the final owner as "admin" is a demote — refused (409). A
   * company must keep at least one owner or it becomes unadministerable.
   */
  async addMember(
    userId: string,
    companyId: string,
    email: string,
    role: string,
  ): Promise<CompanyMemberView> {
    await this.assertCompanyOwner(userId, companyId);
    if (role !== "owner" && role !== "admin") {
      throw new BadRequestException('Role must be "owner" or "admin".');
    }
    const clean = (email ?? "").trim();
    if (!clean) throw new BadRequestException("Email is required.");
    // The company's own workspaces — the ONLY place an email may resolve from (see above).
    const workspaces = await getPrisma().tenantSettings.findMany({
      where: { companyId },
      select: { tenantId: true },
    });
    const tenantIds = workspaces.map((w) => w.tenantId);
    const account =
      tenantIds.length === 0
        ? null
        : await getPrisma().membership.findFirst({
            where: {
              email: { equals: clean, mode: "insensitive" },
              tenantId: { in: tenantIds },
            },
            orderBy: { createdAt: "desc" },
            select: { userId: true },
          });
    if (!account) {
      throw new NotFoundException(
        "No account with that email in this company's workspaces — they must sign in to one of them first.",
      );
    }
    if (role !== "owner") {
      // Demote guard: only bites when the target is CURRENTLY an owner (a fresh add of an
      // admin, or re-adding an existing admin, never trips it).
      const existing = await getPrisma().companyMembership.findUnique({
        where: { companyId_userId: { companyId, userId: account.userId } },
        select: { role: true },
      });
      if (existing?.role === "owner") {
        await this.assertNotLastOwner(companyId, "demote");
      }
    }
    await getPrisma().companyMembership.upsert({
      where: { companyId_userId: { companyId, userId: account.userId } },
      create: { companyId, userId: account.userId, role },
      update: { role }, // re-add = role change
    });
    return { userId: account.userId, email: clean, role };
  }

  /**
   * Remove a company member. Allowed for a company OWNER (admin of others is owner-only) OR
   * for the member themselves (self-leave). LAST-OWNER GUARD: removing the final owner is
   * refused (409) — even by themselves.
   */
  async removeMember(
    userId: string,
    companyId: string,
    targetUserId: string,
  ): Promise<void> {
    const callerRole = await this.companyRole(userId, companyId);
    if (callerRole === null) {
      throw new ForbiddenException("You are not a member of this company.");
    }
    if (callerRole !== "owner" && userId !== targetUserId) {
      throw new ForbiddenException(
        "Only the company owner can remove other members.",
      );
    }
    const target = await getPrisma().companyMembership.findUnique({
      where: { companyId_userId: { companyId, userId: targetUserId } },
      select: { role: true },
    });
    if (!target) {
      throw new NotFoundException("That user is not a member of this company.");
    }
    if (target.role === "owner") {
      await this.assertNotLastOwner(companyId, "remove");
    }
    await getPrisma().companyMembership.delete({
      where: { companyId_userId: { companyId, userId: targetUserId } },
    });
  }

  /**
   * 409 when the company has only ONE owner left — demoting/removing them would leave the
   * company with no one able to administer it. Call only when the target IS currently an owner.
   */
  private async assertNotLastOwner(
    companyId: string,
    verb: "demote" | "remove",
  ): Promise<void> {
    const owners = await getPrisma().companyMembership.count({
      where: { companyId, role: "owner" },
    });
    if (owners <= 1) {
      throw new ConflictException(
        `Cannot ${verb} the last owner — a company must keep at least one owner.`,
      );
    }
  }

  // ---- Slice 5: CompanyBudget (§8 cap) ------------------------------------------------------

  /**
   * The company's budget config + live company-wide month-to-date spend (COMPANIES.md §8,
   * Slice 5). Any company member may read it (same authz altitude as the usage rollup — the
   * §4 owner-authorized attach is what makes the cross-workspace read safe). `budget` is null
   * when no cap is configured; `remainingUsd` is null in that case too (nothing to subtract
   * from), while `mtdSpendUsd` is always the live company-wide sum.
   */
  async getCompanyBudget(
    userId: string,
    companyId: string,
  ): Promise<CompanyBudgetView> {
    await this.assertCompanyMember(userId, companyId);
    const row = await getPrisma().companyBudget.findUnique({
      where: { companyId },
    });
    const members = await getPrisma().tenantSettings.findMany({
      where: { companyId },
      select: { tenantId: true },
    });
    const mtdSpendUsd = await monthToDateSpendForTenants(
      members.map((m) => m.tenantId),
    );
    const budget = row
      ? {
          monthlyCapUsd: Number(row.monthlyCapUsd),
          onBudgetExceeded: row.onBudgetExceeded,
        }
      : null;
    return {
      budget,
      mtdSpendUsd,
      remainingUsd: budget
        ? Number((budget.monthlyCapUsd - mtdSpendUsd).toFixed(6))
        : null,
    };
  }

  /**
   * Set (upsert) the company-wide monthly cap. Company OWNER only — the cap gates run starts
   * across EVERY member workspace, so a mere admin must not be able to throttle the fleet.
   * Same Decimal(12,2) write discipline as the per-tenant setBudget (toFixed(2) → Decimal).
   */
  async setCompanyBudget(
    userId: string,
    companyId: string,
    input: { monthlyCapUsd: number; onBudgetExceeded?: "reject" },
  ): Promise<CompanyBudgetConfig> {
    await this.assertCompanyOwner(userId, companyId);
    const data = {
      monthlyCapUsd: new Prisma.Decimal(input.monthlyCapUsd.toFixed(2)),
      ...(input.onBudgetExceeded
        ? { onBudgetExceeded: input.onBudgetExceeded }
        : {}),
    };
    const row = await getPrisma().companyBudget.upsert({
      where: { companyId },
      create: { companyId, ...data },
      update: data,
    });
    return {
      monthlyCapUsd: Number(row.monthlyCapUsd),
      onBudgetExceeded: row.onBudgetExceeded,
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

  /** Company OWNER or 403 — for actions that affect every member workspace (budget,
   *  permission groups — see CompanyGroupsService) or the company's own administration
   *  (member add/role changes). Public so sibling company services reuse the same gate. */
  async assertCompanyOwner(userId: string, companyId: string): Promise<void> {
    if ((await this.companyRole(userId, companyId)) !== "owner") {
      throw new ForbiddenException("Only the company owner can do that.");
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
