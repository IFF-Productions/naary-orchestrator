import { useEffect, useState } from "react";
import { Button, Dialog, Skeleton, Tabs, TextInput } from "../../components";
import {
  api,
  HttpError,
  type Member,
  type PermissionGroup,
  UnauthorizedError,
} from "../../lib/api";
import { workspaceHasAnyGrant } from "../../lib/permissions-logic";
import { PHONE_QUERY, useMediaQuery } from "../../lib/useMediaQuery";
import { MembersTable } from "./team/MembersTable";
import { roleCounts } from "./team/model";
import { RolesAccess } from "./team/RolesAccess";

type Tab = "members" | "roles";

/**
 * Team (redesign, RBAC U1 data): Membership-backed members + pending invitations,
 * with the honest capability/approval story. Two tabs — Members (legend chips,
 * table, pending-invite footer rows, invite dialog) and Roles & access (real
 * owner/admin/member capabilities + the permission-groups bridge to /app/groups).
 *
 * Roles are ENFORCED server-side: owner/admin manage the team; only owners grant
 * admin/owner. The UI mirrors those gates — it never invents an affordance the
 * API would 403.
 */
export function Team({ initialTab = "members" }: { initialTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const phone = useMediaQuery(PHONE_QUERY);
  const [tenant, setTenant] = useState<string | null>(null);
  const [myRole, setMyRole] = useState<string | null>(null);
  const [members, setMembers] = useState<Member[] | null>(null);
  // null = not fetchable for this caller (GET groups is owner/admin-only).
  const [groups, setGroups] = useState<PermissionGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // invite dialog
  const [inviteOpen, setInviteOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [busy, setBusy] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);

  const canManage = myRole === "owner" || myRole === "admin";
  // Only owners may grant/revoke admin/owner (server-enforced) — gate the select.
  const roleOptions =
    myRole === "owner" ? ["owner", "admin", "member"] : ["member"];

  async function load() {
    try {
      const me = await api.getMe();
      setTenant(me.tenantId);
      const [rows, workspaces, grps] = await Promise.all([
        api.listMembers(me.tenantId),
        api.getMyWorkspaces().catch(() => []),
        // Owner/admin-only endpoint — members get the honest fallback copy.
        api.listGroups(me.tenantId).catch(() => null),
      ]);
      setMembers(rows);
      setGroups(grps);
      setMyRole(
        workspaces.find((w) => w.tenantId === me.tenantId)?.role ?? null,
      );
      setError(null);
    } catch (e) {
      if (e instanceof UnauthorizedError) {
        setError("Sign in to manage your team.");
      } else {
        setError("Could not reach the control plane (apps/api on :3000).");
      }
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function describe(e: unknown, fallback: string): string {
    if (e instanceof UnauthorizedError) return "Sign in to manage your team.";
    if (e instanceof HttpError) {
      if (e.status === 409) {
        return (
          e.serverMessage ??
          "That email is already a member or already invited."
        );
      }
      if (e.status === 403) {
        return e.serverMessage ?? "Your role doesn't allow that.";
      }
      return e.serverMessage ?? fallback;
    }
    return fallback;
  }

  async function invite() {
    if (!tenant || !email.trim()) return;
    setBusy(true);
    setInviteError(null);
    try {
      await api.inviteMember(tenant, email.trim(), role);
      setEmail("");
      setInviteOpen(false);
      setMembers(await api.listMembers(tenant));
    } catch (e) {
      setInviteError(
        describe(e, "Could not send the invitation (is the email valid?)."),
      );
    } finally {
      setBusy(false);
    }
  }

  async function remove(row: Member) {
    if (!tenant) return;
    setError(null);
    try {
      if (row.status === "invited") {
        await api.revokeInvitation(tenant, row.id);
      } else {
        await api.removeMember(tenant, row.id);
      }
      setMembers((ms) => (ms ?? []).filter((m) => m.id !== row.id));
    } catch (e) {
      setError(
        describe(
          e,
          row.status === "invited"
            ? "Could not revoke the invitation."
            : "Could not remove member.",
        ),
      );
    }
  }

  async function changeRole(row: Member, newRole: string) {
    if (!tenant || newRole === row.role) return;
    setError(null);
    try {
      const updated = await api.changeMemberRole(tenant, row.id, newRole);
      setMembers((ms) =>
        (ms ?? []).map((m) => (m.id === row.id ? updated : m)),
      );
    } catch (e) {
      setError(describe(e, "Could not change the role."));
    }
  }

  const activeCount = members?.filter((m) => m.status === "active").length ?? 0;
  const invitedCount =
    members?.filter((m) => m.status === "invited").length ?? 0;
  const restricted = groups ? workspaceHasAnyGrant(groups) : null;

  return (
    <div
      style={{
        padding: phone ? "18px 16px 32px" : "22px 28px 40px",
        maxWidth: 1180,
      }}
    >
      {/* header: title + summary · tabs · Invite CTA */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 12,
          marginBottom: 18,
        }}
      >
        <div style={{ marginRight: "auto" }}>
          <h1
            style={{
              fontSize: "var(--text-title)",
              fontWeight: "var(--weight-bold)",
              letterSpacing: "var(--tracking-tight)",
              color: "var(--ink)",
              margin: 0,
            }}
          >
            Team
          </h1>
          <div
            style={{
              fontSize: "var(--text-sm)",
              color: "var(--ink-2)",
              marginTop: 2,
            }}
          >
            {members
              ? `${activeCount} member${activeCount === 1 ? "" : "s"}` +
                (invitedCount
                  ? ` · ${invitedCount} pending invite${invitedCount === 1 ? "" : "s"}`
                  : "") +
                " · roles gate who can approve"
              : "Invitees join when they sign in with a verified matching email."}
          </div>
        </div>
        <Tabs<Tab>
          tabs={[
            { value: "members", label: "Members" },
            { value: "roles", label: "Roles & access" },
          ]}
          active={tab}
          onChange={setTab}
        />
        {canManage && (
          <Button
            variant="primary"
            icon="plus"
            onClick={() => {
              setInviteError(null);
              setInviteOpen(true);
            }}
          >
            Invite
          </Button>
        )}
      </div>

      {error && (
        <div
          style={{
            marginBottom: 14,
            padding: "9px 12px",
            borderRadius: "var(--radius-sm)",
            background: "var(--error-soft)",
            color: "var(--state-error)",
            fontSize: "var(--text-sm)",
          }}
        >
          {error}
        </div>
      )}

      {members === null && !error && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Skeleton height={30} width={340} radius={20} />
          <Skeleton height={220} radius={14} />
        </div>
      )}

      {members !== null && tab === "members" && (
        <div style={{ animation: "naaryFadeUp .25s ease" }}>
          <MembersTable
            members={members}
            groups={groups}
            restricted={restricted}
            myRole={myRole}
            onChangeRole={(m, r) => void changeRole(m, r)}
            onRemove={(m) => void remove(m)}
            onRevoke={(m) => void remove(m)}
          />
        </div>
      )}

      {members !== null && tab === "roles" && (
        <div style={{ animation: "naaryFadeUp .25s ease" }}>
          <RolesAccess groups={groups} counts={roleCounts(members)} />
        </div>
      )}

      {/* invite dialog (the existing invite flow, restyled) */}
      <Dialog
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        title="Invite a teammate"
        footer={
          <>
            <Button variant="ghost" onClick={() => setInviteOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              icon="plus"
              loading={busy}
              disabled={!email.trim()}
              onClick={() => void invite()}
            >
              Send invite
            </Button>
          </>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div
            style={{
              fontSize: "var(--text-sm)",
              color: "var(--ink-2)",
              lineHeight: 1.5,
            }}
          >
            They join the moment they sign in with this email verified — no
            email is sent by Naary.
          </div>
          <TextInput
            type="email"
            placeholder="teammate@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
          />
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              fontSize: "var(--text-sm)",
              color: "var(--ink-2)",
            }}
          >
            Role
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              style={{
                flex: 1,
                padding: "8px 10px",
                borderRadius: "var(--radius-sm)",
                border: "1px solid var(--line-2)",
                background: "var(--card)",
                color: "var(--ink)",
                fontSize: "var(--text-body)",
                fontFamily: "var(--font-sans)",
              }}
            >
              {roleOptions.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          {myRole !== "owner" && (
            <div style={{ fontSize: "var(--text-2xs)", color: "var(--ink-3)" }}>
              Only the workspace owner can invite admins or owners.
            </div>
          )}
          {inviteError && (
            <div
              style={{
                padding: "8px 11px",
                borderRadius: "var(--radius-sm)",
                background: "var(--error-soft)",
                color: "var(--state-error)",
                fontSize: "var(--text-sm)",
              }}
            >
              {inviteError}
            </div>
          )}
        </div>
      </Dialog>
    </div>
  );
}
