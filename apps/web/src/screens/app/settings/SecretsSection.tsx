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
  // Which row's kebab menu is open / which row is in "update value" mode.
  const [menuFor, setMenuFor] = useState<string | null>(null);
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
        value can be replaced but never read back.
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
                <div style={{ position: "relative", flex: "none" }}>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon="more"
                    iconOnly
                    aria-label={`Actions for ${row.name} (${row.env.name})`}
                    disabled={busy}
                    onClick={() => setMenuFor((m) => (m === key ? null : key))}
                  />
                  {menuFor === key && (
                    <>
                      <div
                        style={{ position: "fixed", inset: 0, zIndex: 30 }}
                        onClick={() => setMenuFor(null)}
                      />
                      <div
                        className="menu-pop"
                        style={{
                          position: "absolute",
                          right: 0,
                          top: 32,
                          zIndex: 31,
                          minWidth: 150,
                          background: "var(--card)",
                          border: "1px solid var(--line-2)",
                          borderRadius: "var(--radius-md)",
                          boxShadow: "var(--shadow-card)",
                          padding: 4,
                        }}
                      >
                        <button
                          type="button"
                          className="naary-set-menu-item"
                          onClick={() => {
                            setMenuFor(null);
                            setEditFor(key);
                            setEditValue("");
                          }}
                        >
                          Update value…
                        </button>
                        <button
                          type="button"
                          className="naary-set-menu-item"
                          style={{ color: "var(--state-error)" }}
                          onClick={() => {
                            setMenuFor(null);
                            void removeSecret(row);
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    </>
                  )}
                </div>
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
    </div>
  );
}
