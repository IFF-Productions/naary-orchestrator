/**
 * Workspace-configuration endpoints: usage/insights, settings, environments,
 * global variables ($vars), environment secrets ($secrets), and the budget.
 */
import { http } from "./http";
import type {
  BudgetView,
  Environment,
  InsightsReport,
  SetBudgetInput,
  TenantSettings,
  UsageReport,
  Variable,
} from "./types";

export const configApi = {
  // Usage ledger (tokens + cost only). Tenant-scoped — pass the tenantId from getMe().
  // Optional from/to (ISO date) window — the server filters events by createdAt.
  getUsage(
    tenantId: string,
    opts: { from?: string; to?: string } = {},
  ): Promise<UsageReport> {
    const q = new URLSearchParams();
    if (opts.from) q.set("from", opts.from);
    if (opts.to) q.set("to", opts.to);
    const qs = q.toString();
    return http(
      `/tenants/${encodeURIComponent(tenantId)}/usage${qs ? `?${qs}` : ""}`,
    );
  },
  // Usage rolled up by day / environment / workflow / model — the Insights dashboard.
  // Optional from/to (ISO date) window + environmentId filter.
  getInsights(
    tenantId: string,
    opts: { from?: string; to?: string; environmentId?: string } = {},
  ): Promise<InsightsReport> {
    const q = new URLSearchParams();
    if (opts.from) q.set("from", opts.from);
    if (opts.to) q.set("to", opts.to);
    if (opts.environmentId) q.set("environmentId", opts.environmentId);
    const qs = q.toString();
    return http(
      `/tenants/${encodeURIComponent(tenantId)}/usage/insights${qs ? `?${qs}` : ""}`,
    );
  },
  // --- Settings ---
  getSettings(tenantId: string): Promise<TenantSettings> {
    return http(`/tenants/${encodeURIComponent(tenantId)}/settings`);
  },
  saveSettings(
    tenantId: string,
    patch: TenantSettings,
  ): Promise<TenantSettings> {
    return http(`/tenants/${encodeURIComponent(tenantId)}/settings`, {
      method: "PUT",
      body: JSON.stringify(patch),
    });
  },
  // --- Environments (per-workspace sandbox/UAT/prod) ---
  listEnvironments(tenantId: string): Promise<Environment[]> {
    return http(`/tenants/${encodeURIComponent(tenantId)}/environments`);
  },
  createEnvironment(
    tenantId: string,
    body: { name: string; slug: string },
  ): Promise<Environment> {
    return http(`/tenants/${encodeURIComponent(tenantId)}/environments`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
  renameEnvironment(
    tenantId: string,
    envId: string,
    name: string,
  ): Promise<Environment> {
    return http(
      `/tenants/${encodeURIComponent(tenantId)}/environments/${encodeURIComponent(envId)}`,
      { method: "PATCH", body: JSON.stringify({ name }) },
    );
  },
  deleteEnvironment(
    tenantId: string,
    envId: string,
  ): Promise<{ deleted: true }> {
    return http(
      `/tenants/${encodeURIComponent(tenantId)}/environments/${encodeURIComponent(envId)}`,
      { method: "DELETE" },
    );
  },
  // --- Global Variables ($vars) ---
  // Non-secret, env-scoped workspace config referenced in expressions as `{{ $vars.KEY }}`.
  // Scoped to the ACTIVE environment via the x-environment-id header (sent by http()), so the
  // same key can hold a different value in sandbox vs prod. NOT for secrets.
  listVariables(): Promise<Variable[]> {
    return http(`/variables`);
  },
  // Set (create or overwrite) one variable in the active environment. The key must be a valid
  // identifier (server-validated) since it's read as a dot-path in `{{ $vars.KEY }}`.
  setVariable(key: string, value: string): Promise<Variable> {
    return http(`/variables/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    });
  },
  // Delete one variable from the active environment (204; no-op if absent).
  deleteVariable(key: string): Promise<void> {
    return http(`/variables/${encodeURIComponent(key)}`, { method: "DELETE" });
  },
  // --- Environment Secrets ($secrets) ---
  // Write-only, env-scoped named secrets referenced as `{{ $secrets.NAME }}`. Scoped to the ACTIVE
  // environment (x-environment-id). The VALUE is never returned — list yields names only; the worker
  // decrypts it in-activity (never reaches the graph/ctx/history). NOT the BYOK provider keys.
  listEnvSecrets(): Promise<{ name: string }[]> {
    return http(`/env-secrets`);
  },
  // Set (create or replace) a secret's value in the active environment (204).
  setEnvSecret(name: string, value: string): Promise<void> {
    return http(`/env-secrets/${encodeURIComponent(name)}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    });
  },
  // Delete a secret from the active environment (204; no-op if absent).
  deleteEnvSecret(name: string): Promise<void> {
    return http(`/env-secrets/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
  },
  // --- Billing ---
  // Budget config + live month-to-date spend. Tenant-scoped. The server returns 404
  // (→ generic Error, not UnauthorizedError) when no budget is configured.
  getBudget(tenantId: string): Promise<BudgetView> {
    return http(`/tenants/${encodeURIComponent(tenantId)}/budget`);
  },
  // Create/replace the tenant's budget config (PUT /tenants/:id/budget — SetBudgetDto).
  // Returns the persisted config (no live-spend fields); callers refetch getBudget for the view.
  setBudget(
    tenantId: string,
    input: SetBudgetInput,
  ): Promise<Omit<BudgetView, "mtdSpendUsd" | "remainingUsd">> {
    return http(`/tenants/${encodeURIComponent(tenantId)}/budget`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },
};
