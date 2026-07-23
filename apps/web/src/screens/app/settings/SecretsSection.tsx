// Secrets section (redesign) — env-scoped, envelope-encrypted, WRITE-ONLY values
// referenced as `{{ $secrets.NAME }}`. Shows every environment's secret names in one
// list (one row per name+env, with the env chip); values render as a masked
// placeholder because the server never returns them. Row kebab = update / delete.
import { useEffect, useState } from "react";
import { Button, TextInput } from "../../../components";
import {
  type Environment,
  HttpError,
  UnauthorizedError,
} from "../../../lib/api";
import { envScoped } from "./env-scoped";
import {
  EnvChip,
  ErrorLine,
  LockGlyph,
  panelStyle,
  RowMenu,
  SectionHeader,
  SectionIntro,
} from "./shared";

interface SecretRow {
  name: string;
  env: Environment;
}

function rowKey(r: SecretRow): string {
  return `${r.env.id}:${r.name}`;
}

function friendlyError(e: unknown, fallback: string): string {
  if (e instanceof UnauthorizedError) return "Sign in to edit secrets.";
  if (e instanceof HttpError && e.serverMessage) return e.serverMessage;
  return fallback;
}

export function SecretsSection({ envs }: { envs: Environment[] }) {
  const [rows, setRows] = useState<SecretRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Tenant-wide (global) secrets (#459) — apply to EVERY environment; an env-specific secret of the
  // same name overrides them. Names only (values write-only). Own load/error/edit state.
  const [globalNames, setGlobalNames] = useState<string[]>([]);
  const [globalLoaded, setGlobalLoaded] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [globalBusy, setGlobalBusy] = useState(false);
  const [addingGlobal, setAddingGlobal] = useState(false);
  const [globalDraft, setGlobalDraft] = useState<{
    name: string;
    value: string;
  }>({ name: "", value: "" });
  const [globalEditFor, setGlobalEditFor] = useState<string | null>(null);
  const [globalEditValue, setGlobalEditValue] = useState("");
  // Which row is in "update value" mode (the kebab menu owns its own open state).
  const [editFor, setEditFor] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  // "Add secret" draft — name + write-only value + target environment.
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<{
    name: string;
    value: string;
    envId: string;
  }>({ name: "", value: "", envId: "" });

  useEffect(() => {
    if (envs.length === 0) return;
    let live = true;
    (async () => {
      try {
        // One list call per environment (the endpoint is env-scoped); merged into
        // a single cross-env list so prod/sandbox variants sit side by side.
        const perEnv = await Promise.all(
          envs.map((env) => envScoped.listSecrets(env.id)),
        );
        if (!live) return;
        const merged = envs.flatMap((env, i) =>
          perEnv[i].map((s) => ({ name: s.name, env })),
        );
        merged.sort(
          (a, b) =>
            a.name.localeCompare(b.name) ||
            envs.findIndex((e) => e.id === a.env.id) -
              envs.findIndex((e) => e.id === b.env.id),
        );
        setRows(merged);
        setLoaded(true);
        setError(null);
      } catch (e) {
        if (live) setError(friendlyError(e, "Could not load secrets."));
      }
    })();
    return () => {
      live = false;
    };
  }, [envs]);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const names = await envScoped.listGlobalSecrets();
        if (!live) return;
        setGlobalNames(
          names.map((s) => s.name).sort((a, b) => a.localeCompare(b)),
        );
        setGlobalLoaded(true);
        setGlobalError(null);
      } catch (e) {
        if (live)
          setGlobalError(friendlyError(e, "Could not load global secrets."));
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  async function saveGlobalSecret(name: string, value: string) {
    setGlobalBusy(true);
    setGlobalError(null);
    try {
      await envScoped.setGlobalSecret(name, value);
      setGlobalNames((prev) =>
        prev.includes(name)
          ? prev
          : [...prev, name].sort((a, b) => a.localeCompare(b)),
      );
      return true;
    } catch (e) {
      setGlobalError(
        friendlyError(
          e,
          "Could not save. Name must be a valid identifier (letters, digits, underscore; not starting with a digit) and the value non-empty.",
        ),
      );
      return false;
    } finally {
      setGlobalBusy(false);
    }
  }

  async function removeGlobalSecret(name: string) {
    setGlobalBusy(true);
    setGlobalError(null);
    try {
      await envScoped.deleteGlobalSecret(name);
      setGlobalNames((prev) => prev.filter((n) => n !== name));
    } catch (e) {
      setGlobalError(friendlyError(e, "Could not delete the secret."));
    } finally {
      setGlobalBusy(false);
    }
  }

  async function submitGlobalDraft() {
    const name = globalDraft.name.trim();
    if (!name || !globalDraft.value) return;
    if (await saveGlobalSecret(name, globalDraft.value)) {
      setGlobalDraft({ name: "", value: "" });
      setAddingGlobal(false);
    }
  }

  async function submitGlobalEdit(name: string) {
    if (!globalEditValue) return;
    if (await saveGlobalSecret(name, globalEditValue)) {
      setGlobalEditFor(null);
      setGlobalEditValue("");
    }
  }

  async function saveSecret(env: Environment, name: string, value: string) {
    setBusy(true);
    setError(null);
    try {
      await envScoped.setSecret(env.id, name, value);
      setRows((prev) => {
        if (prev.some((r) => r.name === name && r.env.id === env.id))
          return prev;
        const next = [...prev, { name, env }];
        next.sort(
          (a, b) =>
            a.name.localeCompare(b.name) ||
            envs.findIndex((e) => e.id === a.env.id) -
              envs.findIndex((e) => e.id === b.env.id),
        );
        return next;
      });
      return true;
    } catch (e) {
      setError(
        friendlyError(
          e,
          "Could not save. Name must be a valid identifier (letters, digits, underscore; not starting with a digit) and the value non-empty.",
        ),
      );
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function removeSecret(row: SecretRow) {
    setBusy(true);
    setError(null);
    try {
      await envScoped.deleteSecret(row.env.id, row.name);
      setRows((prev) => prev.filter((r) => rowKey(r) !== rowKey(row)));
    } catch (e) {
      setError(friendlyError(e, "Could not delete the secret."));
    } finally {
      setBusy(false);
    }
  }

  async function submitDraft() {
    const name = draft.name.trim();
    const env = envs.find((e) => e.id === draft.envId) ?? envs[0];
    if (!name || !draft.value || !env) return;
    if (await saveSecret(env, name, draft.value)) {
      setDraft({ name: "", value: "", envId: env.id });
      setAdding(false);
    }
  }

  async function submitEdit(row: SecretRow) {
    if (!editValue) return;
    if (await saveSecret(row.env, row.name, editValue)) {
      setEditFor(null);
      setEditValue("");
    }
  }

  const defaultEnvId = envs.find((e) => e.isDefault)?.id ?? envs[0]?.id ?? "";

  return (
    <div>
      <SectionHeader
        title="Secrets"
        action={
          <Button
            variant="primary"
            icon="plus"
            disabled={!loaded || envs.length === 0}
            onClick={() => {
              setAdding((v) => !v);
              setDraft((d) => ({ ...d, envId: d.envId || defaultEnvId }));
            }}
          >
            Add secret
          </Button>
        }
      />
      <SectionIntro>
        Encrypted values referenced by name in nodes (e.g.{" "}
        <code className="mono" style={{ color: "var(--ink-soft)" }}>
          {"{{ $secrets.STRIPE_KEY }}"}
        </code>{" "}
        in an HTTP node's headers/body or an MCP tool's arguments). Resolved
        only inside the activity that uses them — never printed in logs, run
        data, or the graph. Scoped per environment, and{" "}
        <strong style={{ color: "var(--ink-soft)" }}>write-only</strong>: a
        value can be replaced but never read back. A{" "}
        <strong style={{ color: "var(--ink-soft)" }}>Global</strong> secret
        (below) applies to every environment; an env-specific secret of the same
        name overrides it.
      </SectionIntro>

      {error && <ErrorLine>{error}</ErrorLine>}

      {adding && (
        <div style={{ ...panelStyle, padding: "14px 18px", marginBottom: 12 }}>
          <div
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <TextInput
              className="mono"
              value={draft.name}
              onChange={(e) =>
                setDraft((d) => ({ ...d, name: e.target.value }))
              }
              placeholder="NAME"
              style={{ flex: "1 1 160px", maxWidth: 220 }}
              disabled={busy}
            />
            <TextInput
              type="password"
              value={draft.value}
              onChange={(e) =>
                setDraft((d) => ({ ...d, value: e.target.value }))
              }
              placeholder="value (write-only)"
              autoComplete="new-password"
              style={{ flex: "2 1 200px" }}
              disabled={busy}
            />
          </div>
          <div
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              marginTop: 12,
              flexWrap: "wrap",
            }}
          >
            <span style={{ fontSize: 11, color: "var(--ink-3)" }}>
              Environment
            </span>
            {envs.map((env) => (
              <EnvChip
                key={env.id}
                env={env}
                selected={draft.envId === env.id}
                onClick={() => setDraft((d) => ({ ...d, envId: env.id }))}
              />
            ))}
            <span style={{ flex: 1 }} />
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => setAdding(false)}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={busy}
              disabled={!draft.name.trim() || !draft.value}
              onClick={() => void submitDraft()}
            >
              Save secret
            </Button>
          </div>
        </div>
      )}

      <div style={panelStyle}>
        {!loaded && !error && (
          <div
            style={{
              padding: "13px 18px",
              fontSize: "var(--text-sm)",
              color: "var(--ink-3)",
            }}
          >
            Loading secrets…
          </div>
        )}
        {loaded && rows.length === 0 && (
          <div
            style={{
              padding: "16px 18px",
              fontSize: "var(--text-sm)",
              color: "var(--ink-3)",
            }}
          >
            No secrets yet — "Add secret" stores an encrypted, write-only value
            in the environment you pick.
          </div>
        )}
        {rows.map((row) => {
          const key = rowKey(row);
          const editing = editFor === key;
          return (
            <div key={key} style={{ borderBottom: "1px solid var(--line)" }}>
              <div
                className="naary-set-row"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  padding: "13px 18px",
                }}
              >
                <LockGlyph style={{ color: "var(--ink-faint)" }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    className="mono"
                    style={{
                      fontSize: 12.5,
                      fontWeight: "var(--weight-semibold)",
                      color: "var(--ink)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={row.name}
                  >
                    {row.name}
                  </div>
                </div>
                <EnvChip env={row.env} />
                <span
                  className="mono"
                  style={{ fontSize: 11.5, color: "var(--ink-faint)" }}
                  title="Write-only — the value is never shown again"
                >
                  ••••••••
                </span>
                <RowMenu
                  label={`Actions for ${row.name} (${row.env.name})`}
                  disabled={busy}
                  items={[
                    {
                      label: "Update value…",
                      onClick: () => {
                        setEditFor(key);
                        setEditValue("");
                      },
                    },
                    {
                      label: "Delete",
                      danger: true,
                      onClick: () => void removeSecret(row),
                    },
                  ]}
                />
              </div>
              {editing && (
                <div
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "center",
                    padding: "0 18px 13px 47px",
                    animation: "naaryFadeUp .2s ease",
                  }}
                >
                  <TextInput
                    type="password"
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    placeholder={`New value for ${row.name} (${row.env.name})`}
                    autoComplete="new-password"
                    style={{ flex: 1 }}
                    disabled={busy}
                    autoFocus
                  />
                  <Button
                    variant="primary"
                    size="sm"
                    loading={busy}
                    disabled={!editValue}
                    onClick={() => void submitEdit(row)}
                  >
                    Update
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setEditFor(null);
                      setEditValue("");
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Tenant-wide (global) secrets (#459) — apply across every environment. */}
      <div style={{ marginTop: 28 }}>
        <SectionHeader
          title="Global (all environments)"
          action={
            <Button
              variant="secondary"
              icon="plus"
              disabled={!globalLoaded}
              onClick={() => setAddingGlobal((v) => !v)}
            >
              Add global secret
            </Button>
          }
        />
        <SectionIntro>
          Applies to every environment. If an environment has a secret with the
          same name (above), that env-specific value{" "}
          <strong style={{ color: "var(--ink-soft)" }}>overrides</strong> the
          global one. Same write-only rule — a value can be replaced but never
          read back.
        </SectionIntro>

        {globalError && <ErrorLine>{globalError}</ErrorLine>}

        {addingGlobal && (
          <div
            style={{ ...panelStyle, padding: "14px 18px", marginBottom: 12 }}
          >
            <div
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <TextInput
                className="mono"
                value={globalDraft.name}
                onChange={(e) =>
                  setGlobalDraft((d) => ({ ...d, name: e.target.value }))
                }
                placeholder="NAME"
                style={{ flex: "1 1 160px", maxWidth: 220 }}
                disabled={globalBusy}
              />
              <TextInput
                type="password"
                value={globalDraft.value}
                onChange={(e) =>
                  setGlobalDraft((d) => ({ ...d, value: e.target.value }))
                }
                placeholder="value (write-only)"
                autoComplete="new-password"
                style={{ flex: "2 1 200px" }}
                disabled={globalBusy}
              />
              <span style={{ flex: 1 }} />
              <Button
                variant="ghost"
                size="sm"
                disabled={globalBusy}
                onClick={() => setAddingGlobal(false)}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                loading={globalBusy}
                disabled={!globalDraft.name.trim() || !globalDraft.value}
                onClick={() => void submitGlobalDraft()}
              >
                Save secret
              </Button>
            </div>
          </div>
        )}

        <div style={panelStyle}>
          {!globalLoaded && !globalError && (
            <div
              style={{
                padding: "13px 18px",
                fontSize: "var(--text-sm)",
                color: "var(--ink-3)",
              }}
            >
              Loading global secrets…
            </div>
          )}
          {globalLoaded && globalNames.length === 0 && (
            <div
              style={{
                padding: "16px 18px",
                fontSize: "var(--text-sm)",
                color: "var(--ink-3)",
              }}
            >
              No global secrets yet — "Add global secret" stores an encrypted,
              write-only value that applies to every environment.
            </div>
          )}
          {globalNames.map((name) => {
            const editing = globalEditFor === name;
            return (
              <div key={name} style={{ borderBottom: "1px solid var(--line)" }}>
                <div
                  className="naary-set-row"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 14,
                    padding: "13px 18px",
                  }}
                >
                  <LockGlyph style={{ color: "var(--ink-faint)" }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      className="mono"
                      style={{
                        fontSize: 12.5,
                        fontWeight: "var(--weight-semibold)",
                        color: "var(--ink)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={name}
                    >
                      {name}
                    </div>
                  </div>
                  <span
                    className="mono"
                    style={{ fontSize: 11.5, color: "var(--ink-faint)" }}
                    title="Write-only — the value is never shown again"
                  >
                    ••••••••
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={globalBusy}
                    onClick={() => {
                      setGlobalEditFor(editing ? null : name);
                      setGlobalEditValue("");
                    }}
                  >
                    Update value…
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    style={{ color: "var(--state-error)" }}
                    disabled={globalBusy}
                    aria-label={`Delete global secret ${name}`}
                    onClick={() => void removeGlobalSecret(name)}
                  >
                    Delete
                  </Button>
                </div>
                {editing && (
                  <div
                    style={{
                      display: "flex",
                      gap: 8,
                      alignItems: "center",
                      padding: "0 18px 13px 47px",
                      animation: "naaryFadeUp .2s ease",
                    }}
                  >
                    <TextInput
                      type="password"
                      value={globalEditValue}
                      onChange={(e) => setGlobalEditValue(e.target.value)}
                      placeholder={`New value for ${name} (all environments)`}
                      autoComplete="new-password"
                      style={{ flex: 1 }}
                      disabled={globalBusy}
                      autoFocus
                    />
                    <Button
                      variant="primary"
                      size="sm"
                      loading={globalBusy}
                      disabled={!globalEditValue}
                      onClick={() => void submitGlobalEdit(name)}
                    >
                      Update
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={globalBusy}
                      onClick={() => {
                        setGlobalEditFor(null);
                        setGlobalEditValue("");
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
