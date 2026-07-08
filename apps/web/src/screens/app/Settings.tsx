import { useEffect, useState } from "react";
import { Button, Card } from "../../components";
import {
  api,
  type NotificationSettings,
  type TenantSettings,
  UnauthorizedError,
} from "../../lib/api";
import { type Mode, useMode } from "../../mode";
import { useWorkspace } from "../../workspace/WorkspaceProvider";

const MODELS = ["", "claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"];

export function Settings() {
  const { refresh: refreshWorkspaces } = useWorkspace();
  const { mode, setMode } = useMode();
  const [tenant, setTenant] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Notifications
  const [notif, setNotif] = useState<NotificationSettings>({
    webhookUrl: "",
    onApprovalPending: true,
    onRunFailed: true,
  });
  const [notifBusy, setNotifBusy] = useState(false);
  const [notifStatus, setNotifStatus] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const me = await api.getMe();
        if (!live) return;
        setTenant(me.tenantId);
        const s = await api.getSettings(me.tenantId);
        if (!live) return;
        setDisplayName(s.displayName ?? "");
        setDefaultModel(s.defaultModel ?? "");
        const n = await api.getNotifications(me.tenantId);
        if (!live) return;
        setNotif({ ...n, webhookUrl: n.webhookUrl ?? "" });
        setLoaded(true);
      } catch (e) {
        if (live)
          setError(
            e instanceof UnauthorizedError
              ? "Sign in to view workspace settings."
              : "Could not reach the control plane (apps/api on :3000).",
          );
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  async function save() {
    if (!tenant) return;
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      const patch: TenantSettings = {
        displayName: displayName.trim() || null,
        defaultModel: defaultModel || null,
      };
      const saved = await api.saveSettings(tenant, patch);
      setDisplayName(saved.displayName ?? "");
      setDefaultModel(saved.defaultModel ?? "");
      // The display name IS the workspace name — refresh the switcher so a rename shows
      // immediately (no page reload).
      await refreshWorkspaces().catch(() => undefined);
      setStatus("Saved.");
    } catch (e) {
      setError(
        e instanceof UnauthorizedError
          ? "Sign in to save settings."
          : "Could not save settings.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function saveNotif() {
    if (!tenant) return;
    setNotifBusy(true);
    setNotifStatus(null);
    setError(null);
    try {
      const saved = await api.saveNotifications(tenant, {
        webhookUrl: notif.webhookUrl?.trim() || null,
        onApprovalPending: notif.onApprovalPending,
        onRunFailed: notif.onRunFailed,
      });
      setNotif({ ...saved, webhookUrl: saved.webhookUrl ?? "" });
      setNotifStatus("Saved.");
    } catch (e) {
      setError(
        e instanceof UnauthorizedError
          ? "Sign in to save notifications."
          : "Could not save notifications.",
      );
    } finally {
      setNotifBusy(false);
    }
  }

  return (
    <div style={{ padding: "22px 28px 40px", maxWidth: 720 }}>
      <div style={{ marginBottom: 20 }}>
        <div
          style={{
            fontSize: "var(--text-title)",
            fontWeight: "var(--weight-bold)",
            color: "var(--ink)",
            letterSpacing: "var(--tracking-tight)",
          }}
        >
          Settings
        </div>
        <div
          style={{
            fontSize: "var(--text-body)",
            color: "var(--ink-2)",
            marginTop: 4,
          }}
        >
          Workspace settings{tenant ? ` · tenant ${tenant}` : ""}.
        </div>
      </div>

      {/* Experience mode — Builder (full canvas) vs Simple (describe + step list). Per-user. */}
      <Card style={{ padding: 18, marginBottom: 16 }}>
        <div
          style={{
            fontSize: "var(--text-md)",
            fontWeight: "var(--weight-semibold)",
            color: "var(--ink)",
            marginBottom: 4,
          }}
        >
          Experience
        </div>
        <div
          style={{
            fontSize: "var(--text-sm)",
            color: "var(--ink-2)",
            marginBottom: 12,
          }}
        >
          Choose how you build automations. This is your personal preference.
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {[
            {
              m: "simple" as Mode,
              title: "Simple",
              blurb: "Describe it in English, review friendly steps.",
            },
            {
              m: "builder" as Mode,
              title: "Builder",
              blurb: "The full visual canvas + advanced features.",
            },
          ].map((o) => {
            const active = mode === o.m;
            return (
              <button
                key={o.m}
                type="button"
                onClick={() => setMode(o.m)}
                style={{
                  all: "unset",
                  cursor: "pointer",
                  flex: "1 1 220px",
                  padding: "12px 14px",
                  borderRadius: "var(--radius-md)",
                  border: `1px solid ${active ? "var(--brand)" : "var(--line-2)"}`,
                  background: active ? "var(--brand-soft)" : "var(--card-2)",
                }}
              >
                <div
                  style={{
                    fontSize: "var(--text-body)",
                    fontWeight: "var(--weight-semibold)",
                    color: active ? "var(--brand)" : "var(--ink)",
                  }}
                >
                  {o.title}
                  {active ? " ✓" : ""}
                </div>
                <div
                  style={{
                    fontSize: "var(--text-xs)",
                    color: "var(--ink-3)",
                    marginTop: 2,
                  }}
                >
                  {o.blurb}
                </div>
              </button>
            );
          })}
        </div>
      </Card>

      {error && (
        <div
          style={{
            marginBottom: 14,
            padding: "10px 12px",
            borderRadius: "var(--radius-md)",
            background: "var(--error-soft)",
            border:
              "1px solid color-mix(in srgb, var(--state-error) 40%, transparent)",
            color: "var(--state-error)",
            fontSize: "var(--text-sm)",
          }}
        >
          {error}
        </div>
      )}

      <Card style={{ padding: 18 }}>
        <Field label="Workspace display name">
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Acme Inc."
            style={inputStyle}
            disabled={!loaded}
          />
        </Field>

        <Field label="Default agent model">
          <select
            value={defaultModel}
            onChange={(e) => setDefaultModel(e.target.value)}
            style={inputStyle}
            disabled={!loaded}
          >
            {MODELS.map((m) => (
              <option key={m || "none"} value={m}>
                {m || "— none —"}
              </option>
            ))}
          </select>
        </Field>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            marginTop: 6,
          }}
        >
          <Button
            variant="primary"
            disabled={busy || !loaded}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : "Save settings"}
          </Button>
          {status && (
            <span
              style={{ fontSize: "var(--text-sm)", color: "var(--state-done)" }}
            >
              {status}
            </span>
          )}
        </div>
      </Card>

      <div
        className="mono"
        style={{
          fontSize: "var(--text-2xs)",
          fontWeight: "var(--weight-semibold)",
          letterSpacing: "var(--tracking-label)",
          textTransform: "uppercase",
          color: "var(--ink-3)",
          margin: "24px 0 12px",
        }}
      >
        Notifications
      </div>
      <Card style={{ padding: 18 }}>
        <div
          style={{
            fontSize: "var(--text-body)",
            lineHeight: "var(--leading-snug)",
            color: "var(--ink-2)",
            marginBottom: 12,
          }}
        >
          Get pinged when a run needs a human — an approval can wait for days,
          so it shouldn't rely on someone watching the inbox. Paste a Slack,
          Teams, or generic incoming-webhook URL; we POST a JSON message on each
          event.
        </div>
        <Field label="Webhook URL">
          <input
            value={notif.webhookUrl ?? ""}
            onChange={(e) =>
              setNotif((n) => ({ ...n, webhookUrl: e.target.value }))
            }
            placeholder="https://hooks.slack.com/services/…"
            style={inputStyle}
            disabled={!loaded}
          />
        </Field>
        <label
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            marginBottom: 10,
          }}
        >
          <input
            type="checkbox"
            checked={notif.onApprovalPending}
            onChange={(e) =>
              setNotif((n) => ({ ...n, onApprovalPending: e.target.checked }))
            }
            disabled={!loaded}
          />
          <span style={{ fontSize: "var(--text-body)", color: "var(--ink)" }}>
            When an approval is waiting
          </span>
        </label>
        <label
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            marginBottom: 14,
          }}
        >
          <input
            type="checkbox"
            checked={notif.onRunFailed}
            onChange={(e) =>
              setNotif((n) => ({ ...n, onRunFailed: e.target.checked }))
            }
            disabled={!loaded}
          />
          <span style={{ fontSize: "var(--text-body)", color: "var(--ink)" }}>
            When a run fails
          </span>
        </label>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Button
            variant="primary"
            disabled={notifBusy || !loaded}
            onClick={() => void saveNotif()}
          >
            {notifBusy ? "Saving…" : "Save notifications"}
          </Button>
          {notifStatus && (
            <span
              style={{ fontSize: "var(--text-sm)", color: "var(--state-done)" }}
            >
              {notifStatus}
            </span>
          )}
        </div>
      </Card>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "block", marginBottom: 16 }}>
      <span style={{ fontSize: "var(--text-sm)", color: "var(--ink-2)" }}>
        {label}
      </span>
      <div style={{ marginTop: 6 }}>{children}</div>
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--line-2)",
  background: "var(--card)",
  color: "var(--ink)",
  fontSize: "var(--text-body)",
};
