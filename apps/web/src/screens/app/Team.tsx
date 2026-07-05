import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Card, Icon } from "../../components";
import {
  api,
  type Invitation,
  type Member,
  UnauthorizedError,
} from "../../lib/api";
import { useWorkspace } from "../../workspace/WorkspaceProvider";

const ROLE_COLOR: Record<string, string> = {
  owner: "var(--brand)",
  admin: "var(--ink)",
  member: "var(--ink-2)",
};

export function Team() {
  const navigate = useNavigate();
  const { activeId: tenant, activeRole } = useWorkspace();
  const isAdmin = activeRole === "admin" || activeRole === "owner";

  const [members, setMembers] = useState<Member[] | null>(null);
  const [invites, setInvites] = useState<Invitation[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The most recent invite's shareable link — shown ONCE (the token isn't retrievable again).
  const [freshLink, setFreshLink] = useState<string | null>(null);

  async function load() {
    if (!tenant) return;
    // Member management (listing included) is admin+ (server-enforced) — a non-admin would
    // just 403, so don't fetch the roster for them; show the info banner instead.
    if (!isAdmin) {
      setMembers([]);
      setInvites([]);
      return;
    }
    try {
      const [ms, iv] = await Promise.all([
        api.listMembers(tenant),
        api.listInvitations(tenant),
      ]);
      setMembers(ms);
      setInvites(iv);
      setError(null);
    } catch (e) {
      setError(
        e instanceof UnauthorizedError
          ? "Sign in to manage your team."
          : "Could not reach the control plane (apps/api on :3000).",
      );
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenant, isAdmin]);

  async function invite() {
    if (!tenant || !email.trim()) return;
    setBusy(true);
    setError(null);
    setFreshLink(null);
    try {
      const created = await api.createInvitation(tenant, email.trim(), role);
      setFreshLink(`${window.location.origin}/invite/${created.token}`);
      setEmail("");
      setInvites(await api.listInvitations(tenant));
    } catch (e) {
      setError(
        e instanceof UnauthorizedError
          ? "Sign in to manage your team."
          : "Could not create the invite (are you an admin? is the email valid?).",
      );
    } finally {
      setBusy(false);
    }
  }

  async function removeMember(id: string) {
    if (!tenant) return;
    try {
      await api.removeMember(tenant, id);
      setMembers((ms) => (ms ?? []).filter((m) => m.id !== id));
    } catch {
      setError("Could not remove member.");
    }
  }

  async function revokeInvite(id: string) {
    if (!tenant) return;
    try {
      await api.revokeInvitation(tenant, id);
      setInvites((iv) => iv.filter((i) => i.id !== id));
    } catch {
      setError("Could not revoke the invite.");
    }
  }

  return (
    <div style={{ padding: "22px 28px 40px", maxWidth: 920 }}>
      <div style={{ marginBottom: 16 }}>
        <div
          style={{ fontSize: 21, fontWeight: 700, letterSpacing: "-0.01em" }}
        >
          Team
        </div>
        <div style={{ fontSize: 12.5, color: "var(--ink-2)", marginTop: 2 }}>
          {isAdmin && members
            ? `${members.length} member${members.length === 1 ? "" : "s"} · `
            : ""}
          membership is the access authority — removing a member revokes access
          immediately.
        </div>
      </div>

      {error && <Banner kind="error">{error}</Banner>}

      {/* invite form — admin+ only (server enforces too) */}
      {isAdmin ? (
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
              {/* You can't grant a role at/above your own (server-enforced): an admin may
                  invite only members; owner is never grantable via an invite at all. */}
              <option value="member">member</option>
              {activeRole === "owner" && <option value="admin">admin</option>}
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
          {freshLink && (
            <div
              style={{
                marginTop: 12,
                padding: "10px 12px",
                borderRadius: 8,
                background: "var(--bg-3, rgba(120,160,255,.08))",
                border: "1px solid var(--line)",
              }}
            >
              <div
                style={{ fontSize: 12, color: "var(--ink-2)", marginBottom: 6 }}
              >
                Share this one-time invite link — it won't be shown again:
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <code
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 11.5,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    color: "var(--ink)",
                  }}
                >
                  {freshLink}
                </code>
                <Button
                  variant="secondary"
                  size="sm"
                  icon="copy"
                  onClick={() => void navigator.clipboard?.writeText(freshLink)}
                >
                  Copy
                </Button>
              </div>
            </div>
          )}
        </Card>
      ) : (
        <Banner kind="info">
          You're a {activeRole ?? "member"} of this workspace. Only admins can
          invite or remove teammates.
        </Banner>
      )}

      {/* members list — admin+ (listing is server-gated) */}
      {isAdmin && (
        <Card style={{ padding: 0, overflow: "hidden" }}>
          <SectionRow>Members</SectionRow>
          {members === null && !error && <Muted>Loading…</Muted>}
          {members?.length === 0 && <Muted>No members yet.</Muted>}
          {members?.map((m) => (
            <Row key={m.id}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>
                  {m.email ?? m.userId}
                </div>
              </div>
              <RolePill role={m.role} />
              {m.role !== "owner" && (
                <IconBtn
                  label="Remove member"
                  onClick={() => void removeMember(m.id)}
                />
              )}
            </Row>
          ))}
        </Card>
      )}

      {/* pending invites (admin only) */}
      {isAdmin && invites.length > 0 && (
        <Card style={{ padding: 0, overflow: "hidden", marginTop: 16 }}>
          <SectionRow>Pending invites</SectionRow>
          {invites.map((iv) => (
            <Row key={iv.id}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{iv.email}</div>
                <div style={{ fontSize: 11, color: "var(--ink-3)" }}>
                  expires {new Date(iv.expiresAt).toLocaleDateString()}
                </div>
              </div>
              <RolePill role={iv.role} />
              <IconBtn
                label="Revoke invite"
                onClick={() => void revokeInvite(iv.id)}
              />
            </Row>
          ))}
        </Card>
      )}

      <div style={{ marginTop: 14 }}>
        <Button variant="secondary" onClick={() => navigate("/app/settings")}>
          Workspace settings →
        </Button>
      </div>
    </div>
  );
}

function RolePill({ role }: { role: string }) {
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 600,
        color: ROLE_COLOR[role] ?? "var(--ink-2)",
      }}
    >
      {role}
    </span>
  );
}

function IconBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      style={{
        border: "none",
        background: "transparent",
        cursor: "pointer",
        color: "var(--ink-3)",
      }}
    >
      <Icon name="trash" size={15} />
    </button>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "11px 16px",
        borderTop: "1px solid var(--line)",
      }}
    >
      {children}
    </div>
  );
}

function SectionRow({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "10px 16px",
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        color: "var(--ink-3)",
      }}
    >
      {children}
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: 16,
        fontSize: 12.5,
        color: "var(--ink-2)",
        borderTop: "1px solid var(--line)",
      }}
    >
      {children}
    </div>
  );
}

function Banner({
  kind,
  children,
}: {
  kind: "error" | "info";
  children: React.ReactNode;
}) {
  const err = kind === "error";
  return (
    <div
      style={{
        marginBottom: 14,
        padding: "9px 12px",
        borderRadius: 8,
        background: err
          ? "var(--error-soft)"
          : "var(--bg-3, rgba(120,160,255,.08))",
        color: err ? "var(--state-error)" : "var(--ink-2)",
        fontSize: 12,
      }}
    >
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  flex: 1,
  padding: "8px 10px",
  borderRadius: 7,
  border: "1px solid var(--line-2)",
  background: "var(--card)",
  color: "var(--ink)",
  fontSize: 13,
};
