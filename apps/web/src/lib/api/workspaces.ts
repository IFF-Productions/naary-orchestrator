/**
 * Caller-identity + workspace endpoints: /me, workspaces, per-user preferences
 * (mode + dashboard), team members, API tokens, and the audit log.
 */
import { http } from "./http";
import type {
  ApiTokenRow,
  AuditEvent,
  DashboardItem,
  Member,
  MintedToken,
  Workspace,
} from "./types";

export const workspacesApi = {
  // Who am I — the SPA's tenantId (for tenant-scoped routes) + OIDC subject.
  getMe(): Promise<{ tenantId: string; subject?: string }> {
    return http("/me");
  },
  // The caller's workspaces + role (powers the workspace switcher).
  getMyWorkspaces(): Promise<Workspace[]> {
    return http("/me/workspaces");
  },
  // Per-user preferences (experience mode + dashboard layout) — cross-device, keyed to the
  // user server-side. Fields are null when unset (or for API-token principals with no uid).
  getPreferences(): Promise<{
    mode: string | null;
    dashboard: DashboardItem[] | null;
  }> {
    return http("/me/preferences");
  },
  // Save the experience mode only (the PUT omits `dashboard`, so it's left untouched).
  savePreferences(
    mode: string | null,
  ): Promise<{ mode: string | null; dashboard: DashboardItem[] | null }> {
    return http("/me/preferences", {
      method: "PUT",
      body: JSON.stringify({ mode }),
    });
  },
  // Save the Overview layout only (omits `mode`, so the experience mode is untouched).
  saveDashboard(
    dashboard: DashboardItem[] | null,
  ): Promise<{ mode: string | null; dashboard: DashboardItem[] | null }> {
    return http("/me/preferences", {
      method: "PUT",
      body: JSON.stringify({ dashboard }),
    });
  },
  // Create a new workspace owned by the caller. The tenantId is server-generated (never
  // sent from the client); requires a verified-email Firebase user (server-enforced).
  // `name` (optional) seeds the workspace display name.
  createWorkspace(name?: string): Promise<Workspace> {
    return http("/workspaces", {
      method: "POST",
      body: JSON.stringify(name?.trim() ? { name: name.trim() } : {}),
    });
  },
  // --- API tokens (for the MCP server + CLI/CI). Workspace-scoped via X-Workspace-Id. ---
  listApiTokens(): Promise<ApiTokenRow[]> {
    return http("/tokens");
  },
  // Returns the plaintext token ONCE — it can't be shown again.
  mintApiToken(label?: string): Promise<MintedToken> {
    return http("/tokens", {
      method: "POST",
      body: JSON.stringify(label?.trim() ? { label: label.trim() } : {}),
    });
  },
  revokeApiToken(id: string): Promise<void> {
    return http(`/tokens/${encodeURIComponent(id)}`, { method: "DELETE" });
  },
  // --- Team (members) ---
  listMembers(tenantId: string): Promise<Member[]> {
    return http(`/tenants/${encodeURIComponent(tenantId)}/members`);
  },
  addMember(tenantId: string, email: string, role?: string): Promise<Member> {
    return http(`/tenants/${encodeURIComponent(tenantId)}/members`, {
      method: "POST",
      body: JSON.stringify({ email, ...(role ? { role } : {}) }),
    });
  },
  removeMember(tenantId: string, memberId: string): Promise<void> {
    return http(
      `/tenants/${encodeURIComponent(tenantId)}/members/${encodeURIComponent(memberId)}`,
      { method: "DELETE" },
    );
  },
  // --- Audit log (activity feed) ---
  getAuditLog(tenantId: string): Promise<AuditEvent[]> {
    return http(`/tenants/${encodeURIComponent(tenantId)}/audit`);
  },
};
