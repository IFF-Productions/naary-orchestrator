/**
 * Pure derivations for the Team screen — no I/O.
 *
 * DATA HONESTY: the redesign comp shows a 5-role model (owner/admin/editor/
 * approver/viewer) with per-gate approval routing. The real model is 3 workspace
 * roles (owner/admin/member) + permission groups (six-verb grants, the Groups
 * screen). Everything here derives ONLY from that real model:
 *  - approving a run is authorized as the `run` verb on its workflow
 *    (apps/api/src/executions/executions.service.ts — "run for approve/cancel"),
 *  - owner/admin USER principals bypass groups entirely,
 *  - a member is unrestricted until the workspace's FIRST grant exists (the
 *    cliff), then deny-by-default outside their groups
 *    (apps/api/src/permissions/permissions.service.ts §4).
 */
import type { Member, PermissionGroup } from "../../../lib/api";

/** Role accents (design: Owner ember / Admin violet / Member blue). The node/state
 *  tokens carry the exact design hues in BOTH themes, so we reuse them. */
export const ROLE_COLOR: Record<string, string> = {
  owner: "var(--brand)",
  admin: "var(--node-agent)",
  member: "var(--state-info)",
};

/** Avatar gradients keyed by role (the comp colors avatars by role). Fixed hex —
 *  white initials read on these in both themes. */
export const ROLE_AVATAR: Record<string, string> = {
  owner: "linear-gradient(140deg,#f2622e,#c8331f)",
  admin: "linear-gradient(140deg,#c07bff,#7d4fd0)",
  member: "linear-gradient(140deg,#4a9dff,#2f76d0)",
};

export function roleColor(role: string): string {
  return ROLE_COLOR[role] ?? "var(--ink-2)";
}

/** "maria.alvarez@x.io" → "Maria Alvarez" — a direct transform of the email local
 *  part (the backend stores no display name). Never invents anything. */
export function displayName(email: string): string {
  const local = email.split("@")[0] ?? email;
  const words = local.split(/[._-]+/).filter(Boolean);
  if (words.length === 0) return email;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/** Two-letter initials from the derived display name. */
export function initials(email: string): string {
  const words = displayName(email).split(" ");
  const first = words[0]?.charAt(0) ?? "?";
  const second =
    words.length > 1
      ? words[words.length - 1].charAt(0)
      : (words[0]?.charAt(1) ?? "");
  return (first + second).toUpperCase();
}

/** Count active members per role (legend chips). */
export function roleCounts(members: Member[]): Record<string, number> {
  const counts: Record<string, number> = { owner: 0, admin: 0, member: 0 };
  for (const m of members) {
    if (m.status !== "active") continue;
    counts[m.role] = (counts[m.role] ?? 0) + 1;
  }
  return counts;
}

/** The groups a user belongs to. */
export function groupsOf(
  groups: PermissionGroup[],
  userId: string | undefined,
): PermissionGroup[] {
  if (!userId) return [];
  return groups.filter((g) => g.members.some((m) => m.userId === userId));
}

export interface CanApprove {
  /** Short cell text, e.g. "Any gate". */
  label: string;
  /** Faint second line explaining WHY (the honest part). */
  detail: string;
  /** True when the member currently cannot approve anything. */
  none: boolean;
}

/**
 * What a member can honestly be said to approve, given the real authorization
 * semantics (approve = the `run` verb on the gate's workflow).
 *
 * `restricted` is null when the caller can't see groups (GET /tenants/:id/groups
 * is owner/admin-only) — then we state the rule, not a per-member verdict.
 */
export function deriveCanApprove(
  member: Member,
  restricted: boolean | null,
  memberGroups: PermissionGroup[],
): CanApprove {
  if (member.role === "owner" || member.role === "admin") {
    return {
      label: "Any gate",
      detail: `${member.role} bypasses group grants`,
      none: false,
    };
  }
  // role === member (or unknown): approval requires Run access on the workflow.
  if (restricted === false) {
    return {
      label: "Any gate",
      detail: "no group grants yet — unrestricted",
      none: false,
    };
  }
  if (restricted === null) {
    return {
      label: "Gates they can run",
      detail: "run access = approve access",
      none: false,
    };
  }
  const runGroups = memberGroups.filter((g) =>
    g.grants.some((gr) => gr.canRun),
  );
  const fullRun = memberGroups.find((g) =>
    g.grants.some(
      (gr) => gr.canRun && gr.scope === "all" && gr.environmentId === null,
    ),
  );
  if (fullRun) {
    return {
      label: "Any gate",
      detail: `via ${fullRun.name} (Run on all workflows)`,
      none: false,
    };
  }
  if (runGroups.length > 0) {
    return {
      label: "Gates their groups can run",
      detail: `via ${runGroups.map((g) => g.name).join(", ")}`,
      none: false,
    };
  }
  return {
    label: "None",
    detail: "needs a group with Run access",
    none: true,
  };
}

/** One capability chip on a role card; `approval` = the teal HITL highlight. */
export interface RoleCap {
  label: string;
  approval?: boolean;
}

export interface RoleCardDef {
  role: string;
  name: string;
  caps: RoleCap[];
  note?: string;
}

/**
 * The REAL capabilities of the three workspace roles, from the codebase's
 * authorization gates (members.service §4, groups.service, tokens.controller,
 * permissions.service §4 bypass). Approval-related caps carry `approval: true`.
 */
export const ROLE_CARDS: RoleCardDef[] = [
  {
    role: "owner",
    name: "Owner",
    caps: [
      { label: "Full workspace control" },
      { label: "Grant or revoke admin & owner" },
      { label: "Manage permission groups & API tokens" },
      { label: "Approve any gate", approval: true },
      { label: "Bypasses group restrictions" },
    ],
    note: "The last owner can't be removed or demoted.",
  },
  {
    role: "admin",
    name: "Admin",
    caps: [
      { label: "Invite & remove members" },
      { label: "Manage permission groups & API tokens" },
      { label: "Full workflow access, every environment" },
      { label: "Approve any gate", approval: true },
      { label: "Bypasses group restrictions" },
    ],
    note: "Only the owner can grant admin or owner roles.",
  },
  {
    role: "member",
    name: "Member",
    caps: [
      { label: "Build, run & view workflows" },
      { label: "Approve gates on workflows they can run", approval: true },
      { label: "Restricted by permission groups once the first grant exists" },
      { label: "No team, group or token management" },
    ],
  },
];

/** "Mar 12" (adds the year when it isn't the current one). */
export function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const opts: Intl.DateTimeFormatOptions =
    d.getFullYear() === new Date().getFullYear()
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" };
  return d.toLocaleDateString(undefined, opts);
}
