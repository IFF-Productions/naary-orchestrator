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
  MemberRemoval,
  MintedToken,
  Workspace,
} from "./types";

export const workspacesApi = {
  // Who am I — the SPA's tenantId (for tenant-scoped routes) + OIDC subject, plus whether this caller
  // operates the DEPLOYMENT (PLATFORM_OPERATORS allowlist), which gates operator-only surfaces like the
  // Workers fleet view. `isOperator` is optional here so an older API (or a cached response) without it
  // reads as false — the safe direction, and the server re-checks regardless.
  getMe(): Promise<{
    tenantId: string;
    subject?: string;
    isOperator?: boolean;
  }> {
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
  // This workspace's feature flags (flag key → enabled), evaluated server-side for the
  // caller's tenant only. The SPA gates UI on these (#491); unwrap the { flags } envelope.
  getFlags(): Promise<Record<string, boolean>> {
    return http<{ flags: Record<string, boolean> }>("/me/flags").then(
      (r) => r.flags,
    );
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
  // --- Team (RBAC U1: Membership-backed members + pending invitations) ---
  // Active members ∪ pending invitations; rows discriminate on `status`.
  listMembers(tenantId: string): Promise<Member[]> {
    return http(`/tenants/${encodeURIComponent(tenantId)}/members`);
  },
  // Creates a pending INVITATION (not a membership) — the invitee joins when they sign in
  // with this email verified. 409 (HttpError.status) when already a member/invited.
  inviteMember(
    tenantId: string,
    email: string,
    role?: string,
  ): Promise<Member> {
    return http(`/tenants/${encodeURIComponent(tenantId)}/members`, {
      method: "POST",
      body: JSON.stringify({ email, ...(role ? { role } : {}) }),
    });
  },
  // Change an active member's role (by Firebase uid). Owner-only for admin/owner grants;
  // 409 when demoting the last owner.
  changeMemberRole(
    tenantId: string,
    userId: string,
    role: string,
  ): Promise<Member> {
    return http(
      `/tenants/${encodeURIComponent(tenantId)}/members/${encodeURIComponent(userId)}`,
      { method: "PATCH", body: JSON.stringify({ role }) },
    );
  },
  // Remove an active member (by Firebase uid). 409 when removing the last owner.
  // 200, not 204: the body reports the paused approvals the removal stranded (#1053). The
  // removal itself has already committed — this is never a veto.
  async removeMember(tenantId: string, userId: string): Promise<MemberRemoval> {
    const res = await http<MemberRemoval | undefined>(
      `/tenants/${encodeURIComponent(tenantId)}/members/${encodeURIComponent(userId)}`,
      { method: "DELETE" },
    );
    // A staged deploy puts this (new) SPA in front of an OLD api for a window, and that api
    // still answers 204 — `http` returns undefined for an empty body. Without this the caller
    // would read `.strandedApprovals` off undefined and report "Could not remove member" for a
    // removal that SUCCEEDED. Nothing known ⇒ nothing claimed, so `partial`.
    return (
      res ?? {
        removed: true,
        strandedApprovals: {
          total: 0,
          needsOwnerOrAdmin: 0,
          partial: true,
          runs: [],
        },
      }
    );
  },
  // Revoke a pending invitation (by invitation id).
  revokeInvitation(tenantId: string, invitationId: string): Promise<void> {
    return http(
      `/tenants/${encodeURIComponent(tenantId)}/members/invitations/${encodeURIComponent(invitationId)}`,
      { method: "DELETE" },
    );
  },
  // --- Audit log (activity feed) ---
  getAuditLog(tenantId: string): Promise<AuditEvent[]> {
    return http(`/tenants/${encodeURIComponent(tenantId)}/audit`);
  },
};
