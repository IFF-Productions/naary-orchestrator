/**
 * Company endpoints (COMPANIES.md — the admin/billing-rollup layer above
 * workspaces): membership, owner-authorized attach, usage rollups, read-only
 * workspace drill-downs, and the company-wide budget.
 */
import { http } from "./http";
import type {
  Company,
  CompanyBudgetConfig,
  CompanyBudgetView,
  CompanyMember,
  CompanyUsage,
  CompanyWorkspaceRuns,
  CompanyWorkspaceWorkflow,
} from "./types";

export const companiesApi = {
  // --- Companies (COMPANIES.md): user-scoped (uid-keyed) — the workspace header is ignored. ---
  getMyCompanies(): Promise<Company[]> {
    return http("/me/companies");
  },
  createCompany(name: string): Promise<Company> {
    return http("/companies", {
      method: "POST",
      body: JSON.stringify({ name: name.trim() }),
    });
  },
  // Owner-authorized attach (§4): the caller must be a company member AND the workspace owner.
  attachWorkspaceToCompany(companyId: string, tenantId: string): Promise<void> {
    return http(
      `/companies/${encodeURIComponent(companyId)}/workspaces/${encodeURIComponent(tenantId)}`,
      { method: "POST" },
    );
  },
  getCompanyUsage(
    companyId: string,
    opts: { from?: string; to?: string } = {},
  ): Promise<CompanyUsage> {
    const q = new URLSearchParams();
    if (opts.from) q.set("from", opts.from);
    if (opts.to) q.set("to", opts.to);
    const qs = q.toString();
    return http(
      `/companies/${encodeURIComponent(companyId)}/usage${qs ? `?${qs}` : ""}`,
    );
  },
  // READ-ONLY console drill-downs (§7.3) — summaries only, never run detail or graph bodies.
  listCompanyWorkspaceRuns(
    companyId: string,
    tenantId: string,
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<CompanyWorkspaceRuns> {
    const q = new URLSearchParams();
    if (opts.limit) q.set("limit", String(opts.limit));
    if (opts.cursor) q.set("cursor", opts.cursor);
    const qs = q.toString();
    return http(
      `/companies/${encodeURIComponent(companyId)}/workspaces/${encodeURIComponent(tenantId)}/runs${qs ? `?${qs}` : ""}`,
    );
  },
  listCompanyWorkspaceWorkflows(
    companyId: string,
    tenantId: string,
  ): Promise<CompanyWorkspaceWorkflow[]> {
    return http(
      `/companies/${encodeURIComponent(companyId)}/workspaces/${encodeURIComponent(tenantId)}/workflows`,
    );
  },
  // ---- Slice 4: company management (§7.4). ----
  // Rename a member workspace (same displayName the workspace's Settings edits). §4-gated.
  renameCompanyWorkspace(
    companyId: string,
    tenantId: string,
    displayName: string,
  ): Promise<void> {
    return http(
      `/companies/${encodeURIComponent(companyId)}/workspaces/${encodeURIComponent(tenantId)}`,
      { method: "PATCH", body: JSON.stringify({ displayName }) },
    );
  },
  // Soft + reversible archive toggle — hides the workspace from the switcher only.
  setCompanyWorkspaceArchived(
    companyId: string,
    tenantId: string,
    archived: boolean,
  ): Promise<void> {
    return http(
      `/companies/${encodeURIComponent(companyId)}/workspaces/${encodeURIComponent(tenantId)}/${archived ? "archive" : "unarchive"}`,
      { method: "POST" },
    );
  },
  listCompanyMembers(companyId: string): Promise<CompanyMember[]> {
    return http(`/companies/${encodeURIComponent(companyId)}/members`);
  },
  // Company OWNER only. 404 = no account with that email (they must sign in first — real
  // invitations land with the RBAC program); 409 = would demote the last owner.
  addCompanyMember(
    companyId: string,
    email: string,
    role: "owner" | "admin",
  ): Promise<CompanyMember> {
    return http(`/companies/${encodeURIComponent(companyId)}/members`, {
      method: "POST",
      body: JSON.stringify({ email: email.trim(), role }),
    });
  },
  // Owner-only, except removing yourself (self-leave). 409 = last owner.
  removeCompanyMember(companyId: string, userId: string): Promise<void> {
    return http(
      `/companies/${encodeURIComponent(companyId)}/members/${encodeURIComponent(userId)}`,
      { method: "DELETE" },
    );
  },
  // Company-wide budget (COMPANIES.md §8, Slice 5). Company members only; `budget`
  // is null when no cap is configured yet (unlike getBudget, no 404).
  getCompanyBudget(companyId: string): Promise<CompanyBudgetView> {
    return http(`/companies/${encodeURIComponent(companyId)}/budget`);
  },
  // Company OWNER only (403 otherwise) — the cap gates run starts across every
  // member workspace, as an OUTER gate above per-workspace budgets.
  setCompanyBudget(
    companyId: string,
    input: { monthlyCapUsd: number; onBudgetExceeded?: "reject" },
  ): Promise<CompanyBudgetConfig> {
    return http(`/companies/${encodeURIComponent(companyId)}/budget`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },
};
