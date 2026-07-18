import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Card, Icon } from "../../components";
import { api, HttpError, type Member, UnauthorizedError } from "../../lib/api";

const ROLE_COLOR: Record<string, string> = {
  owner: "var(--brand)",
  admin: "var(--ink)",
  member: "var(--ink-2)",
};

/**
 * Team (RBAC U1): Membership-backed members + pending invitations. Adding a teammate
 * creates an INVITATION — they join when they sign in with that email verified. Roles are
 * ENFORCED: owner/admin manage the team; only owners grant admin/owner.
 */
export function Team() {
  const navigate = useNavigate();
  const [tenant, setTenant] = useState<string | null>(null);
  const [myRole, setMyRole] = useState<string | null>(null);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only owners may grant/revoke admin/owner (server-enforced) — gate the select to match.
  const roleOptions =
    myRole === "owner" ? ["owner", "admin", "member"] : ["member"];
  const canManage = myRole === "owner" || myRole === "admin";

  async function load() {
    try {
      const me = await api.getMe();
      setTenant(me.tenantId);
      const [rows, workspaces] = await Promise.all([
        api.listMembers(me.tenantId),
        api.getMyWorkspaces().catch(() => []),
      ]);
      setMembers(rows);
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
    setError(null);
    try {
      await api.inviteMember(tenant, email.trim(), role);
      setEmail("");
      setMembers(await api.listMembers(tenant));
    } catch (e) {
      setError(
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

  return (
    <div style={{ padding: "22px 28px 40px", maxWidth: 920 }}>
      <div style={{ marginBottom: 16 }}>
        <div
          style={{
            fontSize: "var(--text-title)",
            fontWeight: "var(--weight-bold)",
            letterSpacing: "var(--tracking-tight)",
            color: "var(--ink)",
          }}
        >
          Team
        </div>
        <div
          style={{
            fontSize: "var(--text-sm)",
            color: "var(--ink-2)",
            marginTop: 2,
          }}
        >
          {members
            ? `${activeCount} member${activeCount === 1 ? "" : "s"}${
                invitedCount ? ` · ${invitedCount} invited` : ""
              } · `
            : ""}
          invitees join when they sign in with a verified matching email.
        </div>
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

      {/* invite form — owner/admin only (server-enforced; hidden for members) */}
      {canManage && (
        <Card style={{ padding: 14, marginBottom: 16 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="teammate@company.com"
              style={inputStyle}
              type="email"
            />
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              style={{ ...inputStyle, width: 120, flex: "none" }}
            >
              {roleOptions.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <Button
              variant="primary"
              icon="plus"
              disabled={busy || !email.trim()}
              onClick={() => void invite()}
            >
              {busy ? "Inviting…" : "Invite"}
            </Button>
          </div>
        </Card>
      )}

      {/* members + pending invitations */}
      <Card style={{ padding: 0, overflow: "hidden" }}>
        {members === null && !error && (
          <div
            style={{
              padding: 16,
              fontSize: "var(--text-sm)",
              color: "var(--ink-3)",
            }}
          >
            Loading…
          </div>
        )}
        {members?.length === 0 && (
          <div
            style={{
              padding: 16,
              fontSize: "var(--text-sm)",
              color: "var(--ink-3)",
            }}
          >
            No members yet — invite your first teammate above.
          </div>
        )}
        {members?.map((m) => (
          <div
            key={m.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "11px 16px",
              borderTop: "1px solid var(--line)",
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: "var(--text-body)",
                  fontWeight: "var(--weight-medium)",
                  color: "var(--ink)",
                }}
              >
                {m.email || m.userId}
              </div>
            </div>
            {m.status === "invited" && (
              <span
                style={{
                  fontSize: "var(--text-xs)",
                  fontWeight: "var(--weight-semibold)",
                  color: "var(--ink-3)",
                  border: "1px solid var(--line-2)",
                  borderRadius: 999,
                  padding: "2px 8px",
                }}
              >
                Invited
              </span>
            )}
            {m.status === "active" && myRole === "owner" ? (
              <select
                value={m.role}
                aria-label="Change role"
                onChange={(e) => void changeRole(m, e.target.value)}
                style={{
                  ...inputStyle,
                  flex: "none",
                  width: 104,
                  padding: "4px 6px",
                  fontSize: "var(--text-xs)",
                  fontWeight: "var(--weight-semibold)",
                  color: ROLE_COLOR[m.role] ?? "var(--ink-2)",
                }}
              >
                {["owner", "admin", "member"].map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            ) : (
              <span
                style={{
                  fontSize: "var(--text-xs)",
                  fontWeight: "var(--weight-semibold)",
                  color: ROLE_COLOR[m.role] ?? "var(--ink-2)",
                }}
              >
                {m.role}
              </span>
            )}
            {canManage && (
              <button
                type="button"
                aria-label={
                  m.status === "invited" ? "Revoke invitation" : "Remove member"
                }
                onClick={() => void remove(m)}
                style={{
                  border: "none",
                  background: "transparent",
                  cursor: "pointer",
                  color: "var(--ink-3)",
                }}
              >
                <Icon name="trash" size={15} />
              </button>
            )}
          </div>
        ))}
      </Card>

      <div style={{ marginTop: 14 }}>
        <Button variant="secondary" onClick={() => navigate("/app/settings")}>
          Workspace settings →
        </Button>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  flex: 1,
  padding: "8px 10px",
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--line-2)",
  background: "var(--card)",
  color: "var(--ink)",
  fontSize: "var(--text-body)",
};
