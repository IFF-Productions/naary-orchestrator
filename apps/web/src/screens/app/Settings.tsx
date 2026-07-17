import { useEffect, useState } from "react";
import { Button, Card } from "../../components";
import {
  api,
  type NotificationChannelType,
  type TenantSettings,
  UnauthorizedError,
  type Variable,
} from "../../lib/api";
import { PHONE_QUERY, useMediaQuery } from "../../lib/useMediaQuery";
import { useWorkspace } from "../../workspace/WorkspaceProvider";
import { ExperienceCard } from "./settings/ExperienceCard";
import {
  draftChannel,
  type EditableChannel,
  NotificationsSection,
} from "./settings/NotificationsSection";
import { SecretsSection } from "./settings/SecretsSection";
import { Field, inputStyle } from "./settings/shared";
import { VariablesSection } from "./settings/VariablesSection";

const MODELS = ["", "claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"];

export function Settings() {
  const { refresh: refreshWorkspaces } = useWorkspace();
  const phone = useMediaQuery(PHONE_QUERY);
  const [tenant, setTenant] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Notifications — a LIST of channels (any number per type: several Slack/Teams webhooks),
  // each saved/tested/deleted on its own. `localKey` is the stable UI handle: the server id
  // for saved rows, a draft key for not-yet-created ones (it survives the first save).
  const [channels, setChannels] = useState<EditableChannel[]>([]);
  // Per-channel transient UI state (keyed by localKey).
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
        setChannels(
          list.map((c) => ({
            ...c,
            localKey: c.id,
            label: c.label ?? "",
            webhookUrl: c.webhookUrl ?? "",
          })),
        );
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

  /** Update one channel's edit state (by localKey) without touching the others. */
  function patchChannel(localKey: string, patch: Partial<EditableChannel>) {
    setChannels((prev) =>
      prev.map((c) => (c.localKey === localKey ? { ...c, ...patch } : c)),
    );
  }

  /** Append a new (unsaved) channel of the given type — created server-side on first Save. */
  function addChannel(type: NotificationChannelType) {
    setChannels((prev) => [...prev, draftChannel(type)]);
  }

  async function saveChannel(localKey: string) {
    if (!tenant) return;
    const ch = channels.find((c) => c.localKey === localKey);
    if (!ch) return;
    setNotifBusy((b) => ({ ...b, [localKey]: true }));
    setNotifStatus((s) => ({ ...s, [localKey]: "" }));
    setError(null);
    try {
      const patch = {
        label: ch.label.trim() || null,
        enabled: ch.enabled,
        webhookUrl: ch.webhookUrl.trim() || null,
        onApprovalPending: ch.onApprovalPending,
        onRunFailed: ch.onRunFailed,
      };
      // A draft has no server id yet → create; afterwards it patches in place. The
      // localKey stays put so transient UI state (busy/status) survives the first save.
      const saved = ch.id
        ? await api.saveNotificationChannel(tenant, ch.id, patch)
        : await api.createNotificationChannel(tenant, {
            type: ch.type,
            ...patch,
          });
      patchChannel(localKey, {
        ...saved,
        localKey,
        label: saved.label ?? "",
        webhookUrl: saved.webhookUrl ?? "",
      });
      setNotifStatus((s) => ({ ...s, [localKey]: "Saved." }));
    } catch (e) {
      setError(
        e instanceof UnauthorizedError
          ? "Sign in to save notifications."
          : "Could not save notifications.",
      );
    } finally {
      setNotifBusy((b) => ({ ...b, [localKey]: false }));
    }
  }

  async function deleteChannel(localKey: string) {
    if (!tenant) return;
    const ch = channels.find((c) => c.localKey === localKey);
    if (!ch) return;
    setNotifBusy((b) => ({ ...b, [localKey]: true }));
    setError(null);
    try {
      // A draft only exists locally — just drop it; a saved row is deleted server-side.
      if (ch.id) await api.deleteNotificationChannel(tenant, ch.id);
      setChannels((prev) => prev.filter((c) => c.localKey !== localKey));
    } catch (e) {
      setError(
        e instanceof UnauthorizedError
          ? "Sign in to edit notifications."
          : "Could not delete the channel.",
      );
    } finally {
      setNotifBusy((b) => ({ ...b, [localKey]: false }));
    }
  }

  async function testChannel(localKey: string) {
    if (!tenant) return;
    const ch = channels.find((c) => c.localKey === localKey);
    if (!ch?.id) return; // drafts have nothing saved to test
    setNotifTestBusy((b) => ({ ...b, [localKey]: true }));
    setNotifTest((t) => {
      const next = { ...t };
      delete next[localKey];
      return next;
    });
    try {
      // Tests the SAVED webhook for this channel — remind the user to save an edited URL first.
      const res = await api.testNotificationChannel(tenant, ch.id);
      setNotifTest((t) => ({ ...t, [localKey]: res }));
    } catch {
      setNotifTest((t) => ({
        ...t,
        [localKey]: { ok: false, message: "Could not send the test." },
      }));
    } finally {
      setNotifTestBusy((b) => ({ ...b, [localKey]: false }));
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

      <ExperienceCard />

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

      <VariablesSection
        variables={variables}
        loaded={loaded}
        varBusy={varBusy}
        varError={varError}
        newVar={newVar}
        setNewVar={setNewVar}
        patchVarValue={patchVarValue}
        saveVariable={saveVariable}
        addVariable={addVariable}
        removeVariable={removeVariable}
      />

      <SecretsSection
        secretNames={secretNames}
        loaded={loaded}
        secretBusy={secretBusy}
        secretError={secretError}
        secretReplace={secretReplace}
        setSecretReplace={setSecretReplace}
        newSecret={newSecret}
        setNewSecret={setNewSecret}
        replaceSecret={replaceSecret}
        removeSecret={removeSecret}
        addSecret={addSecret}
      />

      <NotificationsSection
        channels={channels}
        loaded={loaded}
        notifBusy={notifBusy}
        notifStatus={notifStatus}
        notifTestBusy={notifTestBusy}
        notifTest={notifTest}
        patchChannel={patchChannel}
        addChannel={addChannel}
        saveChannel={saveChannel}
        deleteChannel={deleteChannel}
        testChannel={testChannel}
      />
    </div>
  );
}
