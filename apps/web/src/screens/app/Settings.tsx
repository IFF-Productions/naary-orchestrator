import { useEffect, useState } from "react";
import { Button, Card } from "../../components";
import {
  api,
  type NotificationChannel,
  type NotificationChannelType,
  type TenantSettings,
  UnauthorizedError,
  type Variable,
} from "../../lib/api";
import { PHONE_QUERY, useMediaQuery } from "../../lib/useMediaQuery";
import { type Mode, useMode } from "../../mode";
import { useWorkspace } from "../../workspace/WorkspaceProvider";

const MODELS = ["", "claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"];

/** The notification channels the UI renders — each configured + toggled INDEPENDENTLY.
 *  Adding email later = one more entry here + the server-side type. */
const NOTIFICATION_CHANNELS: {
  type: NotificationChannelType;
  label: string;
  placeholder: string;
  hint?: string;
}[] = [
  {
    type: "slack",
    label: "Slack",
    placeholder: "https://hooks.slack.com/services/…",
  },
  {
    type: "teams",
    label: "Microsoft Teams",
    placeholder: "https://prod-00.westus.logic.azure.com/workflows/…",
    hint: "Paste a Teams Workflows (Power Automate) webhook URL — “When a Teams webhook request is received”. We send an Adaptive Card; the legacy Office 365 connector format isn’t supported.",
  },
];

/** Channel config as held in edit state — webhookUrl is a string ("" not null) for the input. */
type EditableChannel = Omit<NotificationChannel, "webhookUrl"> & {
  webhookUrl: string;
};

function defaultChannel(type: NotificationChannelType): EditableChannel {
  return {
    type,
    enabled: false,
    webhookUrl: "",
    onApprovalPending: true,
    onRunFailed: true,
  };
}

export function Settings() {
  const { refresh: refreshWorkspaces } = useWorkspace();
  const phone = useMediaQuery(PHONE_QUERY);
  const { mode, setMode } = useMode();
  const [tenant, setTenant] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Notifications — one editable config per channel, keyed by type, each saved/tested on its own.
  const [channels, setChannels] = useState<Record<string, EditableChannel>>(
    () =>
      Object.fromEntries(
        NOTIFICATION_CHANNELS.map((c) => [c.type, defaultChannel(c.type)]),
      ),
  );
  // Per-channel transient UI state (keyed by channel type).
  const [notifBusy, setNotifBusy] = useState<Record<string, boolean>>({});
  const [notifStatus, setNotifStatus] = useState<Record<string, string>>({});
  const [notifTestBusy, setNotifTestBusy] = useState<Record<string, boolean>>(
    {},
  );
  const [notifTest, setNotifTest] = useState<
    Record<string, { ok: boolean; message?: string }>
  >({});
  // Global Variables ($vars) — non-secret, env-scoped config. Edited independently of settings.
  const [variables, setVariables] = useState<Variable[]>([]);
  const [newVar, setNewVar] = useState<{ key: string; value: string }>({
    key: "",
    value: "",
  });
  const [varBusy, setVarBusy] = useState(false);
  const [varError, setVarError] = useState<string | null>(null);
  // Environment Secrets ($secrets) — WRITE-ONLY: names are listed, values are set but never shown.
  const [secretNames, setSecretNames] = useState<string[]>([]);
  const [newSecret, setNewSecret] = useState<{ name: string; value: string }>({
    name: "",
    value: "",
  });
  // Per-name replacement value (password input); the stored value is never fetched.
  const [secretReplace, setSecretReplace] = useState<Record<string, string>>(
    {},
  );
  const [secretBusy, setSecretBusy] = useState(false);
  const [secretError, setSecretError] = useState<string | null>(null);

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
        const list = await api.listNotificationChannels(me.tenantId);
        if (!live) return;
        setChannels((prev) => {
          const next = { ...prev };
          for (const c of list)
            next[c.type] = { ...c, webhookUrl: c.webhookUrl ?? "" };
          return next;
        });
        const vars = await api.listVariables();
        if (!live) return;
        setVariables(vars);
        const secrets = await api.listEnvSecrets();
        if (!live) return;
        setSecretNames(secrets.map((s) => s.name));
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

  /** Update one channel's edit state without touching the others. */
  function patchChannel(
    type: NotificationChannelType,
    patch: Partial<EditableChannel>,
  ) {
    setChannels((prev) => ({ ...prev, [type]: { ...prev[type], ...patch } }));
  }

  async function saveChannel(type: NotificationChannelType) {
    if (!tenant) return;
    setNotifBusy((b) => ({ ...b, [type]: true }));
    setNotifStatus((s) => ({ ...s, [type]: "" }));
    setError(null);
    try {
      const ch = channels[type];
      const saved = await api.saveNotificationChannel(tenant, type, {
        enabled: ch.enabled,
        webhookUrl: ch.webhookUrl.trim() || null,
        onApprovalPending: ch.onApprovalPending,
        onRunFailed: ch.onRunFailed,
      });
      patchChannel(type, { ...saved, webhookUrl: saved.webhookUrl ?? "" });
      setNotifStatus((s) => ({ ...s, [type]: "Saved." }));
    } catch (e) {
      setError(
        e instanceof UnauthorizedError
          ? "Sign in to save notifications."
          : "Could not save notifications.",
      );
    } finally {
      setNotifBusy((b) => ({ ...b, [type]: false }));
    }
  }

  async function testChannel(type: NotificationChannelType) {
    if (!tenant) return;
    setNotifTestBusy((b) => ({ ...b, [type]: true }));
    setNotifTest((t) => {
      const next = { ...t };
      delete next[type];
      return next;
    });
    try {
      // Tests the SAVED webhook for this channel — remind the user to save an edited URL first.
      const res = await api.testNotificationChannel(tenant, type);
      setNotifTest((t) => ({ ...t, [type]: res }));
    } catch {
      setNotifTest((t) => ({
        ...t,
        [type]: { ok: false, message: "Could not send the test." },
      }));
    } finally {
      setNotifTestBusy((b) => ({ ...b, [type]: false }));
    }
  }

  /** Set a variable's value in local edit state (no network) — the row's Save commits it. */
  function patchVarValue(key: string, value: string) {
    setVariables((prev) =>
      prev.map((v) => (v.key === key ? { ...v, value } : v)),
    );
  }

  /** Returns true when the save landed, so callers (addVariable) can clear the draft
   *  ONLY on success — a failed save (invalid key / 401) keeps the user's input. */
  async function saveVariable(key: string, value: string): Promise<boolean> {
    setVarBusy(true);
    setVarError(null);
    try {
      const saved = await api.setVariable(key, value);
      setVariables((prev) => {
        const others = prev.filter((v) => v.key !== saved.key);
        return [...others, saved].sort((a, b) => a.key.localeCompare(b.key));
      });
      return true;
    } catch (e) {
      setVarError(
        e instanceof UnauthorizedError
          ? "Sign in to edit variables."
          : "Could not save. Keys must be a valid identifier (letters, digits, underscore; not starting with a digit).",
      );
      return false;
    } finally {
      setVarBusy(false);
    }
  }

  async function addVariable() {
    const key = newVar.key.trim();
    if (!key) return;
    // Only clear the draft if the save actually landed — otherwise keep the input
    // so the user can fix an invalid key / retry after a network or auth error.
    if (await saveVariable(key, newVar.value))
      setNewVar({ key: "", value: "" });
  }

  async function removeVariable(key: string) {
    setVarBusy(true);
    setVarError(null);
    try {
      await api.deleteVariable(key);
      setVariables((prev) => prev.filter((v) => v.key !== key));
    } catch (e) {
      setVarError(
        e instanceof UnauthorizedError
          ? "Sign in to edit variables."
          : "Could not delete the variable.",
      );
    } finally {
      setVarBusy(false);
    }
  }

  /** Set/replace a secret's value. Returns success so callers only clear inputs on a real save. */
  async function saveSecret(name: string, value: string): Promise<boolean> {
    setSecretBusy(true);
    setSecretError(null);
    try {
      await api.setEnvSecret(name, value);
      setSecretNames((prev) =>
        prev.includes(name) ? prev : [...prev, name].sort(),
      );
      return true;
    } catch (e) {
      setSecretError(
        e instanceof UnauthorizedError
          ? "Sign in to edit secrets."
          : "Could not save. Name must be a valid identifier and the value non-empty.",
      );
      return false;
    } finally {
      setSecretBusy(false);
    }
  }

  async function addSecret() {
    const name = newSecret.name.trim();
    if (!name || !newSecret.value) return;
    if (await saveSecret(name, newSecret.value))
      setNewSecret({ name: "", value: "" });
  }

  async function replaceSecret(name: string) {
    const value = secretReplace[name] ?? "";
    if (!value) return;
    if (await saveSecret(name, value))
      setSecretReplace((prev) => ({ ...prev, [name]: "" }));
  }

  async function removeSecret(name: string) {
    setSecretBusy(true);
    setSecretError(null);
    try {
      await api.deleteEnvSecret(name);
      setSecretNames((prev) => prev.filter((n) => n !== name));
    } catch (e) {
      setSecretError(
        e instanceof UnauthorizedError
          ? "Sign in to edit secrets."
          : "Could not delete the secret.",
      );
    } finally {
      setSecretBusy(false);
    }
  }

  return (
    <div
      style={{
        padding: phone ? "22px 14px 40px" : "22px 28px 40px",
        maxWidth: 720,
      }}
    >
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
            loading={busy}
            disabled={!loaded}
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
        Variables
      </div>
      <div
        style={{
          fontSize: "var(--text-body)",
          lineHeight: "var(--leading-snug)",
          color: "var(--ink-2)",
          marginBottom: 12,
        }}
      >
        Reusable, non-secret values for this workspace + environment — reference
        them in any node's fields as <code>{"{{ $vars.KEY }}"}</code>. Scoped to
        the active environment, so the same key can hold a different value in
        sandbox vs prod. Not for secrets (API keys, tokens).
      </div>
      <Card style={{ padding: 18, marginBottom: 12 }}>
        {varError && (
          <div
            style={{
              marginBottom: 12,
              fontSize: "var(--text-sm)",
              color: "var(--state-error)",
            }}
          >
            {varError}
          </div>
        )}
        {variables.length === 0 && loaded && (
          <div
            style={{
              fontSize: "var(--text-sm)",
              color: "var(--ink-3)",
              marginBottom: 12,
            }}
          >
            No variables yet — add one below.
          </div>
        )}
        {variables.map((v) => (
          <div
            key={v.key}
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              marginBottom: 10,
            }}
          >
            <code
              style={{
                flex: "0 0 34%",
                fontSize: "var(--text-sm)",
                color: "var(--ink)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={v.key}
            >
              {v.key}
            </code>
            <input
              value={v.value}
              onChange={(e) => patchVarValue(v.key, e.target.value)}
              placeholder="value"
              style={{ ...inputStyle, flex: 1 }}
              disabled={!loaded || varBusy}
            />
            <Button
              variant="secondary"
              disabled={!loaded || varBusy}
              onClick={() => void saveVariable(v.key, v.value)}
            >
              Save
            </Button>
            <Button
              variant="ghost"
              icon="trash"
              disabled={!loaded || varBusy}
              title={`Delete ${v.key}`}
              onClick={() => void removeVariable(v.key)}
            >
              Delete
            </Button>
          </div>
        ))}
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            marginTop: variables.length ? 14 : 0,
            paddingTop: variables.length ? 14 : 0,
            borderTop: variables.length ? "1px solid var(--line)" : "none",
          }}
        >
          <input
            value={newVar.key}
            onChange={(e) => setNewVar((n) => ({ ...n, key: e.target.value }))}
            placeholder="KEY"
            style={{ ...inputStyle, flex: "0 0 34%" }}
            disabled={!loaded || varBusy}
          />
          <input
            value={newVar.value}
            onChange={(e) =>
              setNewVar((n) => ({ ...n, value: e.target.value }))
            }
            placeholder="value"
            style={{ ...inputStyle, flex: 1 }}
            disabled={!loaded || varBusy}
          />
          <Button
            variant="primary"
            loading={varBusy}
            disabled={!loaded || !newVar.key.trim()}
            onClick={() => void addVariable()}
          >
            Add
          </Button>
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
        Secrets
      </div>
      <div
        style={{
          fontSize: "var(--text-body)",
          lineHeight: "var(--leading-snug)",
          color: "var(--ink-2)",
          marginBottom: 12,
        }}
      >
        Encrypted, env-scoped secret values (API keys, tokens). Reference one as{" "}
        <code>{"{{ $secrets.NAME }}"}</code> in an{" "}
        <strong>HTTP Request node's headers or body</strong>, or in an{" "}
        <strong>MCP Tool node's arguments</strong>. Resolved only inside the
        activity that uses it, so a value never enters the flow, run data, or
        logs. Values are <strong>write-only</strong>: you can set or replace a
        secret, but its value is never shown again.
      </div>
      <Card style={{ padding: 18, marginBottom: 12 }}>
        {secretError && (
          <div
            style={{
              marginBottom: 12,
              fontSize: "var(--text-sm)",
              color: "var(--state-error)",
            }}
          >
            {secretError}
          </div>
        )}
        {secretNames.length === 0 && loaded && (
          <div
            style={{
              fontSize: "var(--text-sm)",
              color: "var(--ink-3)",
              marginBottom: 12,
            }}
          >
            No secrets yet — add one below.
          </div>
        )}
        {secretNames.map((name) => (
          <div
            key={name}
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              marginBottom: 10,
            }}
          >
            <code
              style={{
                flex: "0 0 34%",
                fontSize: "var(--text-sm)",
                color: "var(--ink)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={name}
            >
              {name}
            </code>
            <input
              type="password"
              value={secretReplace[name] ?? ""}
              onChange={(e) =>
                setSecretReplace((prev) => ({
                  ...prev,
                  [name]: e.target.value,
                }))
              }
              placeholder="Set new value"
              autoComplete="new-password"
              style={{ ...inputStyle, flex: 1 }}
              disabled={!loaded || secretBusy}
            />
            <Button
              variant="secondary"
              disabled={!loaded || secretBusy || !(secretReplace[name] ?? "")}
              onClick={() => void replaceSecret(name)}
            >
              Update
            </Button>
            <Button
              variant="ghost"
              icon="trash"
              disabled={!loaded || secretBusy}
              title={`Delete ${name}`}
              onClick={() => void removeSecret(name)}
            >
              Delete
            </Button>
          </div>
        ))}
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            marginTop: secretNames.length ? 14 : 0,
            paddingTop: secretNames.length ? 14 : 0,
            borderTop: secretNames.length ? "1px solid var(--line)" : "none",
          }}
        >
          <input
            value={newSecret.name}
            onChange={(e) =>
              setNewSecret((n) => ({ ...n, name: e.target.value }))
            }
            placeholder="NAME"
            style={{ ...inputStyle, flex: "0 0 34%" }}
            disabled={!loaded || secretBusy}
          />
          <input
            type="password"
            value={newSecret.value}
            onChange={(e) =>
              setNewSecret((n) => ({ ...n, value: e.target.value }))
            }
            placeholder="value"
            autoComplete="new-password"
            style={{ ...inputStyle, flex: 1 }}
            disabled={!loaded || secretBusy}
          />
          <Button
            variant="primary"
            loading={secretBusy}
            disabled={!loaded || !newSecret.name.trim() || !newSecret.value}
            onClick={() => void addSecret()}
          >
            Add
          </Button>
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
      <div
        style={{
          fontSize: "var(--text-body)",
          lineHeight: "var(--leading-snug)",
          color: "var(--ink-2)",
          marginBottom: 12,
        }}
      >
        Get pinged when a run needs a human — an approval can wait for days, so
        it shouldn't rely on someone watching the inbox. We POST a formatted
        message (with Approve / Reject / View-run buttons) on each event.
        Configure each channel independently — enable the ones you use; alerts
        go to every enabled channel.
      </div>
      {NOTIFICATION_CHANNELS.map((meta) => {
        const ch = channels[meta.type];
        const busy = !!notifBusy[meta.type];
        const testBusy = !!notifTestBusy[meta.type];
        const chStatus = notifStatus[meta.type];
        const chTest = notifTest[meta.type];
        return (
          <Card
            key={meta.type}
            style={{
              padding: 18,
              marginBottom: 12,
              opacity: ch.enabled ? 1 : 0.72,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 14,
              }}
            >
              <div
                style={{
                  fontSize: "var(--text-body)",
                  fontWeight: "var(--weight-semibold)",
                  color: "var(--ink)",
                }}
              >
                {meta.label}
              </div>
              <label
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  cursor: loaded ? "pointer" : "default",
                }}
                title={`Turn ${meta.label} notifications on or off`}
              >
                <input
                  type="checkbox"
                  checked={ch.enabled}
                  onChange={(e) =>
                    patchChannel(meta.type, { enabled: e.target.checked })
                  }
                  disabled={!loaded}
                />
                <span
                  style={{ fontSize: "var(--text-sm)", color: "var(--ink-2)" }}
                >
                  {ch.enabled ? "Enabled" : "Disabled"}
                </span>
              </label>
            </div>
            {meta.hint && (
              <div
                style={{
                  fontSize: "var(--text-sm)",
                  color: "var(--ink-3)",
                  margin: "0 0 12px",
                  lineHeight: "var(--leading-snug)",
                }}
              >
                {meta.hint}
              </div>
            )}
            <Field label="Webhook URL">
              <input
                value={ch.webhookUrl}
                onChange={(e) =>
                  patchChannel(meta.type, { webhookUrl: e.target.value })
                }
                placeholder={meta.placeholder}
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
                checked={ch.onApprovalPending}
                onChange={(e) =>
                  patchChannel(meta.type, {
                    onApprovalPending: e.target.checked,
                  })
                }
                disabled={!loaded}
              />
              <span
                style={{ fontSize: "var(--text-body)", color: "var(--ink)" }}
              >
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
                checked={ch.onRunFailed}
                onChange={(e) =>
                  patchChannel(meta.type, { onRunFailed: e.target.checked })
                }
                disabled={!loaded}
              />
              <span
                style={{ fontSize: "var(--text-body)", color: "var(--ink)" }}
              >
                When a run fails
              </span>
            </label>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <Button
                variant="primary"
                loading={busy}
                disabled={!loaded}
                onClick={() => void saveChannel(meta.type)}
              >
                {busy ? "Saving…" : "Save"}
              </Button>
              <Button
                variant="secondary"
                icon="bell"
                disabled={testBusy || !loaded || !ch.webhookUrl.trim()}
                onClick={() => void testChannel(meta.type)}
                title={
                  ch.webhookUrl.trim()
                    ? `POST a sample message to your ${meta.label} webhook`
                    : "Add a webhook URL first"
                }
              >
                {testBusy ? "Sending…" : "Send test"}
              </Button>
              {chStatus && (
                <span
                  style={{
                    fontSize: "var(--text-sm)",
                    color: "var(--state-done)",
                  }}
                >
                  {chStatus}
                </span>
              )}
              {chTest && (
                <span
                  style={{
                    fontSize: "var(--text-sm)",
                    color: chTest.ok
                      ? "var(--state-done)"
                      : "var(--state-error)",
                  }}
                >
                  {chTest.ok
                    ? "✓ Test sent — check your channel."
                    : chTest.message}
                </span>
              )}
            </div>
          </Card>
        );
      })}
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
