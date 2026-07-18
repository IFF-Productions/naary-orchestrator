/**
 * Permission groups + grants (RBAC-GROUPS.md, slice G2): groups CRUD, member/token
 * attachment, grants CRUD, and the caller's effective matrix (GET /me/permissions).
 * All group/grant management is owner/admin-only server-side (403 otherwise).
 */
import { http } from "./http";
import type {
  EffectivePermissions,
  GrantInput,
  GroupGrant,
  PermissionGroup,
} from "./types";

const enc = encodeURIComponent;

export const permissionsApi = {
  // --- groups ---
  listGroups(tenantId: string): Promise<PermissionGroup[]> {
    return http(`/tenants/${enc(tenantId)}/groups`);
  },
  createGroup(tenantId: string, name: string): Promise<PermissionGroup> {
    return http(`/tenants/${enc(tenantId)}/groups`, {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  },
  renameGroup(
    tenantId: string,
    groupId: string,
    name: string,
  ): Promise<PermissionGroup> {
    return http(`/tenants/${enc(tenantId)}/groups/${enc(groupId)}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
  },
  /** Removes the group with its members, token attachments, and grants. Deleting the
   *  workspace's last grant lifts the restriction cliff. */
  deleteGroup(tenantId: string, groupId: string): Promise<void> {
    return http(`/tenants/${enc(tenantId)}/groups/${enc(groupId)}`, {
      method: "DELETE",
    });
  },
  // --- members (Firebase uid; must hold a Membership in the workspace) ---
  addGroupMember(
    tenantId: string,
    groupId: string,
    userId: string,
  ): Promise<void> {
    return http(
      `/tenants/${enc(tenantId)}/groups/${enc(groupId)}/members/${enc(userId)}`,
      { method: "POST" },
    );
  },
  removeGroupMember(
    tenantId: string,
    groupId: string,
    userId: string,
  ): Promise<void> {
    return http(
      `/tenants/${enc(tenantId)}/groups/${enc(groupId)}/members/${enc(userId)}`,
      { method: "DELETE" },
    );
  },
  // --- API tokens as grant subjects (§4a — how a restricted token gets access back) ---
  addGroupToken(
    tenantId: string,
    groupId: string,
    tokenId: string,
  ): Promise<void> {
    return http(
      `/tenants/${enc(tenantId)}/groups/${enc(groupId)}/tokens/${enc(tokenId)}`,
      { method: "POST" },
    );
  },
  removeGroupToken(
    tenantId: string,
    groupId: string,
    tokenId: string,
  ): Promise<void> {
    return http(
      `/tenants/${enc(tenantId)}/groups/${enc(groupId)}/tokens/${enc(tokenId)}`,
      { method: "DELETE" },
    );
  },
  // --- grants (the workspace's FIRST grant flips members + ungrouped tokens to
  //     deny-by-default — the caller shows the §8.6 warning before this) ---
  createGrant(
    tenantId: string,
    groupId: string,
    input: GrantInput,
  ): Promise<GroupGrant> {
    return http(`/tenants/${enc(tenantId)}/groups/${enc(groupId)}/grants`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  updateGrant(
    tenantId: string,
    groupId: string,
    grantId: string,
    input: GrantInput,
  ): Promise<GroupGrant> {
    return http(
      `/tenants/${enc(tenantId)}/groups/${enc(groupId)}/grants/${enc(grantId)}`,
      { method: "PATCH", body: JSON.stringify(input) },
    );
  },
  deleteGrant(
    tenantId: string,
    groupId: string,
    grantId: string,
  ): Promise<void> {
    return http(
      `/tenants/${enc(tenantId)}/groups/${enc(groupId)}/grants/${enc(grantId)}`,
      { method: "DELETE" },
    );
  },
  // --- effective matrix for the ACTIVE workspace + environment (affordance gating) ---
  getMyPermissions(): Promise<EffectivePermissions> {
    return http("/me/permissions");
  },
};
