import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Card, Icon } from "../../components";
import { api, type Member, UnauthorizedError } from "../../lib/api";

const ROLES = ["owner", "admin", "member"];
const ROLE_COLOR: Record<string, string> = {
  owner: "var(--brand)",
  admin: "var(--ink)",
  member: "var(--ink-2)",
};

export function Team() {
  const navigate = useNavigate();
  const [tenant, setTenant] = useState<string | null>(null);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const me = await api.getMe();
      setTenant(me.tenantId);
      setMembers(await api.listMembers(me.tenantId));
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

  async function invite() {
    if (!tenant || !email.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.addMember(tenant, email.trim(), role);
      setEmail("");
      setMembers(await api.listMembers(tenant));
    } catch (e) {
      setError(
        e instanceof UnauthorizedError
          ? "Sign in to manage your team."
          : "Could not add member (is the email valid?).",
      );
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!tenant) return;
    try {
      await api.removeMember(tenant, id);
      setMembers((ms) => (ms ?? []).filter((m) => m.id !== id));
    } catch {
      setError("Could not remove member.");
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
          {members ? `${members.length} members · ` : ""}roles are advisory
          metadata (auth itself is Firebase / API tokens).
        </div>
      </div>

      {error && (
        <div
          style={{
            marginBottom: 14,
            padding: "9px 12px",
            borderRadius: 8,
            background: "var(--error-soft)",
            color: "var(--state-error)",
            fontSize: 12,
          }}
        >
          {error}
        </div>
      )}

      {/* invite form */}
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
            {ROLES.map((r) => (
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
            {busy ? "Adding…" : "Invite"}
          </Button>
        </div>
      </Card>

      {/* members list */}
      <Card style={{ padding: 0, overflow: "hidden" }}>
        {members === null && !error && (
          <div style={{ padding: 16, fontSize: 12.5, color: "var(--ink-3)" }}>
            Loading…
          </div>
        )}
        {members?.length === 0 && (
          <div style={{ padding: 16, fontSize: 12.5, color: "var(--ink-2)" }}>
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
              <div style={{ fontSize: 13, fontWeight: 500 }}>{m.email}</div>
            </div>
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: ROLE_COLOR[m.role] ?? "var(--ink-2)",
              }}
            >
              {m.role}
            </span>
            <button
              type="button"
              aria-label="Remove member"
              onClick={() => void remove(m.id)}
              style={{
                border: "none",
                background: "transparent",
                cursor: "pointer",
                color: "var(--ink-3)",
              }}
            >
              <Icon name="trash" size={15} />
            </button>
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
  borderRadius: 7,
  border: "1px solid var(--line-2)",
  background: "var(--card)",
  color: "var(--ink)",
  fontSize: 13,
};
