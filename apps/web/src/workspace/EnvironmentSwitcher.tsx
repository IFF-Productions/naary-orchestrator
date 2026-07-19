/**
 * Environment switcher (design docs/design/ENVIRONMENTS.md + redesign shell) — picks the active
 * per-workspace environment (sandbox/UAT/prod), which the API client sends as `X-Environment-Id`.
 * Redesign: a color-coded segmented control in the context bar — the active segment carries the
 * env accent + a glowing dot (prod runs hot ember as a standing warning). Management (create /
 * rename / delete) lives behind the trailing "…" menu; workspaces with many envs collapse to a
 * compact trigger + the same menu. Self-contained: it resolves the workspace's environments,
 * publishes the active one, and re-resolves whenever the active workspace changes (a persisted
 * env not in the new workspace falls back to that workspace's default).
 */
import { useEffect, useState } from "react";
import { Icon } from "../components";
import {
  type Environment,
  api,
  getActiveEnvironment,
  setActiveEnvironment,
} from "../lib/api";
import { useWorkspace } from "./WorkspaceProvider";

/** Derive a valid slug from a display name (lowercase, spaces→hyphens, strip the rest, ≤32). */
function toSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

/** Env accent by slug/name convention: prod = ember, uat/staging/test = amber, rest = blue. */
export function envAccent(env: Pick<Environment, "slug" | "name">): string {
  const key = `${env.slug} ${env.name}`.toLowerCase();
  if (/prod/.test(key)) return "var(--env-prod)";
  if (/uat|stag|test|qa/.test(key)) return "var(--env-uat)";
  return "var(--env-sandbox)";
}

/** Above this many environments the segmented control would crowd the bar — collapse to a trigger. */
const MAX_SEGMENTS = 4;

export function EnvironmentSwitcher() {
  const { activeId: tenantId } = useWorkspace();
  const [envs, setEnvs] = useState<Environment[]>([]);
  const [activeSlug, setActiveSlug] = useState<string | null>(
    getActiveEnvironment(),
  );
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  // Inline rename: the env id being edited + its draft name. Delete: the id being removed.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [rowBusy, setRowBusy] = useState<string | null>(null);

  // (Re)resolve environments whenever the active workspace changes.
  useEffect(() => {
    if (!tenantId) return;
    let cancelled = false;
    // Clear the previous workspace's list so the switcher doesn't render stale envs while the new
    // workspace's list resolves (or if it fails).
    setEnvs([]);
    (async () => {
      try {
        const list = await api.listEnvironments(tenantId);
        if (cancelled) return;
        setEnvs(list);
        // Keep the persisted env if it exists in THIS workspace, else its default.
        const persisted = getActiveEnvironment();
        const chosen =
          list.find((e) => e.slug === persisted || e.id === persisted) ??
          list.find((e) => e.isDefault) ??
          list[0];
        const slug = chosen?.slug ?? null;
        setActiveEnvironment(slug); // publish before the app's screens fetch
        setActiveSlug(slug);
      } catch {
        if (cancelled) return; // unmounted / workspace changed — don't setState after
        // Resolve failed — CLEAR the active env so we don't keep sending a stale X-Environment-Id
        // (which would wrongly scope requests once the backend enforces it). The server then falls
        // back to the workspace's default env. `envs` was already cleared at the effect's start.
        setActiveEnvironment(null);
        setActiveSlug(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  function switchTo(slug: string) {
    setOpen(false);
    if (slug === activeSlug) return;
    // Publish the new env — subscribers re-render and the routed screen remounts (AppShell keys the
    // Outlet by the active env), so every screen re-fetches under the new X-Environment-Id WITHOUT a
    // full page reload.
    setActiveEnvironment(slug);
    setActiveSlug(slug);
  }

  async function onCreate() {
    const name = newName.trim();
    const slug = toSlug(name);
    if (!tenantId) return;
    if (!name) {
      setError("Enter a name.");
      return;
    }
    if (!slug) {
      // e.g. "!!!" — nothing survives slugification.
      setError("Name must contain a letter or number.");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const env = await api.createEnvironment(tenantId, { name, slug });
      setNewName("");
      setCreating(false);
      setEnvs((prev) => [...prev, env]);
      setActiveEnvironment(env.slug); // switch to the new env live (no reload)
      setActiveSlug(env.slug);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not create environment.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function onRename(env: Environment) {
    const name = editName.trim();
    if (!tenantId) return;
    if (!name) {
      setError("Enter a name.");
      return;
    }
    if (name === env.name) {
      setEditingId(null);
      return;
    }
    setRowBusy(env.id);
    setError(undefined);
    try {
      const updated = await api.renameEnvironment(tenantId, env.id, name);
      // Rename is display-only (the slug/id are stable) — patch the list in place, no reload needed.
      setEnvs((prev) => prev.map((e) => (e.id === env.id ? updated : e)));
      setEditingId(null);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not rename environment.",
      );
    } finally {
      setRowBusy(null);
    }
  }

  async function onDelete(env: Environment) {
    if (!tenantId) return;
    if (
      !window.confirm(
        `Delete environment "${env.name}"? This can't be undone. It must have no workflows, credentials, connections, or triggers.`,
      )
    ) {
      return;
    }
    setRowBusy(env.id);
    setError(undefined);
    try {
      await api.deleteEnvironment(tenantId, env.id);
      // Functional update so a concurrent rename/create isn't clobbered by this render's stale list.
      setEnvs((prev) => prev.filter((e) => e.id !== env.id));
      if (env.slug === activeSlug) {
        // Deleted the active env → clear it (server falls back to the default). Re-resolve the
        // default from the remaining list and switch to it live (no reload).
        const fallback = envs.find((e) => e.isDefault && e.id !== env.id);
        setActiveEnvironment(fallback?.slug ?? null);
        setActiveSlug(fallback?.slug ?? null);
      }
    } catch (e) {
      // The server refuses to delete the default env or a non-empty one (409/400) — surface it.
      setError(
        e instanceof Error ? e.message : "Could not delete environment.",
      );
    } finally {
      setRowBusy(null);
    }
  }

  // Nothing to show until the workspace's environments resolve.
  if (!tenantId || envs.length === 0) return null;
  const active = envs.find((e) => e.slug === activeSlug) ?? envs[0];
  const segmented = envs.length <= MAX_SEGMENTS;

  return (
    <div
      style={{ position: "relative", display: "flex", alignItems: "center" }}
    >
      {segmented ? (
        <div
          role="group"
          aria-label="Environment"
          style={{
            display: "flex",
            gap: 3,
            background: "var(--bg)",
            border: "1px solid var(--line-2)",
            borderRadius: "var(--radius-md)",
            padding: 3,
          }}
        >
          {envs.map((e) => {
            const isActive = e.slug === active.slug;
            const accent = envAccent(e);
            return (
              <button
                key={e.id}
                type="button"
                aria-pressed={isActive}
                title={`Switch to ${e.name}`}
                onClick={() => switchTo(e.slug)}
                style={{
                  all: "unset",
                  display: "flex",
                  alignItems: "center",
                  fontSize: 11.5,
                  padding: "4px 11px",
                  borderRadius: 6,
                  cursor: "pointer",
                  fontWeight: 600,
                  whiteSpace: "nowrap",
                  color: isActive ? accent : "var(--ink-faint)",
                  background: isActive ? "var(--card)" : "transparent",
                }}
              >
                {isActive && (
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: accent,
                      boxShadow: `0 0 8px ${accent}`,
                      display: "inline-block",
                      marginRight: 5,
                      flex: "none",
                    }}
                  />
                )}
                {e.name}
              </button>
            );
          })}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={open}
          title="Switch environment"
          style={{
            all: "unset",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "5px 10px",
            borderRadius: "var(--radius-md)",
            border: "1px solid var(--line-2)",
            background: "var(--bg)",
            maxWidth: "100%",
            minWidth: 0,
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: envAccent(active),
              boxShadow: `0 0 8px ${envAccent(active)}`,
              flex: "none",
            }}
          />
          <span
            style={{
              fontSize: 11.5,
              fontWeight: 600,
              color: envAccent(active),
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {active.name}
          </span>
          <Icon
            name="chevron-up-down"
            size={12}
            style={{ color: "var(--ink-3)", flex: "none" }}
          />
        </button>
      )}

      {/* Manage (create / rename / delete / switch) — the segmented control handles fast
          switching, so this menu is the low-traffic management surface. */}
      {segmented && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={open}
          title="Manage environments"
          aria-label="Manage environments"
          style={{
            all: "unset",
            cursor: "pointer",
            padding: 4,
            marginLeft: 2,
            borderRadius: 6,
            color: "var(--ink-3)",
            display: "flex",
          }}
        >
          <Icon name="more" size={13} />
        </button>
      )}

      {open && (
        <>
          <div
            onClick={() => setOpen(false)}
            style={{ position: "fixed", inset: 0, zIndex: 40 }}
          />
          <div
            // A menu (not a listbox) because each row holds multiple controls (switch + rename +
            // delete); listbox options may not contain nested interactive elements.
            role="menu"
            className="menu-pop"
            style={{
              position: "absolute",
              top: "calc(100% + 6px)",
              left: 0,
              minWidth: 220,
              zIndex: 41,
              background: "var(--panel)",
              border: "1px solid var(--line-mid)",
              borderRadius: 10,
              boxShadow: "var(--shadow-raised)",
              padding: 6,
            }}
          >
            {envs.map((e) => {
              const isActive = e.slug === active.slug;
              // Inline-rename mode for this row: an editable name + save/cancel, no switching.
              if (editingId === e.id) {
                return (
                  <div key={e.id} style={{ padding: "4px 6px" }}>
                    <input
                      autoFocus
                      value={editName}
                      onChange={(ev) => setEditName(ev.target.value)}
                      onKeyDown={(ev) => {
                        if (ev.key === "Enter") void onRename(e);
                        if (ev.key === "Escape") {
                          setEditingId(null);
                          setError(undefined); // match the Cancel button
                        }
                      }}
                      placeholder="Environment name"
                      style={{
                        width: "100%",
                        boxSizing: "border-box",
                        padding: "6px 8px",
                        borderRadius: 6,
                        border: "1px solid var(--line-2)",
                        background: "var(--card)",
                        color: "var(--ink)",
                        fontSize: 12.5,
                      }}
                    />
                    <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                      <button
                        type="button"
                        disabled={rowBusy === e.id}
                        onClick={() => void onRename(e)}
                        style={{
                          all: "unset",
                          cursor: rowBusy === e.id ? "default" : "pointer",
                          padding: "5px 10px",
                          borderRadius: 6,
                          background: "var(--brand)",
                          color: "var(--brand-ink, #fff)",
                          fontSize: 12,
                          opacity: rowBusy === e.id ? 0.6 : 1,
                        }}
                      >
                        {rowBusy === e.id ? "Saving…" : "Save"}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingId(null);
                          setError(undefined);
                        }}
                        style={{
                          all: "unset",
                          cursor: "pointer",
                          padding: "5px 10px",
                          borderRadius: 6,
                          color: "var(--ink-2)",
                          fontSize: 12,
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                );
              }
              return (
                <div
                  key={e.id}
                  role="none"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                    width: "100%",
                    boxSizing: "border-box",
                    padding: "3px 5px 3px 9px",
                    borderRadius: 7,
                    background: isActive ? "var(--hover)" : "transparent",
                  }}
                >
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={isActive}
                    onClick={() => switchTo(e.slug)}
                    title={`Switch to ${e.name}`}
                    style={{
                      all: "unset",
                      cursor: "pointer",
                      flex: 1,
                      minWidth: 0,
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "4px 0",
                    }}
                  >
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        background: envAccent(e),
                        flex: "none",
                      }}
                    />
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        fontSize: 12.5,
                        color: "var(--ink)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {e.name}
                    </span>
                    {e.isDefault && (
                      <span style={{ fontSize: 10, color: "var(--ink-3)" }}>
                        default
                      </span>
                    )}
                    {isActive && (
                      <Icon
                        name="check"
                        size={13}
                        style={{ color: "var(--state-info)", flex: "none" }}
                      />
                    )}
                  </button>
                  {/* Rename any env (display name only). */}
                  <button
                    type="button"
                    role="menuitem"
                    title="Rename"
                    aria-label={`Rename ${e.name}`}
                    onClick={() => {
                      setEditingId(e.id);
                      setEditName(e.name);
                      setError(undefined);
                    }}
                    style={{
                      all: "unset",
                      cursor: "pointer",
                      padding: 4,
                      borderRadius: 5,
                      color: "var(--ink-3)",
                      flex: "none",
                    }}
                  >
                    <Icon name="edit" size={12} />
                  </button>
                  {/* Delete only NON-default envs (the server refuses the default + non-empty). */}
                  {!e.isDefault && (
                    <button
                      type="button"
                      role="menuitem"
                      title="Delete"
                      aria-label={`Delete ${e.name}`}
                      disabled={rowBusy === e.id}
                      onClick={() => void onDelete(e)}
                      style={{
                        all: "unset",
                        cursor: rowBusy === e.id ? "default" : "pointer",
                        padding: 4,
                        borderRadius: 5,
                        color: "var(--ink-3)",
                        flex: "none",
                        opacity: rowBusy === e.id ? 0.5 : 1,
                      }}
                    >
                      <Icon name="trash" size={12} />
                    </button>
                  )}
                </div>
              );
            })}
            <div
              style={{
                height: 1,
                background: "var(--line)",
                margin: "6px 3px",
              }}
            />
            {creating ? (
              <div style={{ padding: "4px 6px" }}>
                <input
                  autoFocus
                  value={newName}
                  onChange={(ev) => setNewName(ev.target.value)}
                  onKeyDown={(ev) => ev.key === "Enter" && void onCreate()}
                  placeholder="Environment name"
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    padding: "6px 8px",
                    borderRadius: 6,
                    border: "1px solid var(--line-2)",
                    background: "var(--card)",
                    color: "var(--ink)",
                    fontSize: 12.5,
                  }}
                />
                {newName.trim() && (
                  <div
                    style={{
                      fontSize: 10.5,
                      color: "var(--ink-3)",
                      margin: "4px 2px 0",
                    }}
                  >
                    slug: {toSlug(newName) || "—"}
                  </div>
                )}
                <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void onCreate()}
                    style={{
                      all: "unset",
                      cursor: busy ? "default" : "pointer",
                      padding: "5px 10px",
                      borderRadius: 6,
                      background: "var(--brand)",
                      color: "var(--brand-ink, #fff)",
                      fontSize: 12,
                      opacity: busy ? 0.6 : 1,
                    }}
                  >
                    {busy ? "Creating…" : "Create"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setCreating(false);
                      setNewName("");
                      setError(undefined);
                    }}
                    style={{
                      all: "unset",
                      cursor: "pointer",
                      padding: "5px 10px",
                      borderRadius: 6,
                      color: "var(--ink-2)",
                      fontSize: 12,
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                role="menuitem"
                onClick={() => setCreating(true)}
                style={{
                  all: "unset",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "7px 9px",
                  borderRadius: 7,
                  color: "var(--ink-2)",
                  fontSize: 12.5,
                }}
              >
                <Icon name="plus" size={13} style={{ flex: "none" }} />
                New environment
              </button>
            )}
            {error && (
              <div
                style={{
                  padding: "4px 9px 2px",
                  fontSize: 11,
                  color: "var(--state-error)",
                }}
              >
                {error}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
