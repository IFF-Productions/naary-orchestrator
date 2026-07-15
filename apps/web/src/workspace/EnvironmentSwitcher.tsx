/**
 * Environment switcher (design docs/design/ENVIRONMENTS.md) — picks the active per-workspace
 * environment (sandbox/UAT/prod), which the API client sends as `X-Environment-Id`. Self-contained
 * (no context yet): it resolves the workspace's environments, publishes the active one, and on
 * switch reloads so every screen re-fetches under the new env. Environments are per-workspace, so it
 * re-resolves whenever the active workspace changes (a persisted env not in the new workspace falls
 * back to that workspace's default). Sits next to the workspace switcher in the sidebar.
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

  // (Re)resolve environments whenever the active workspace changes.
  useEffect(() => {
    if (!tenantId) return;
    let cancelled = false;
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
        // Resolve failed — CLEAR the active env so we don't keep sending a stale X-Environment-Id
        // (which would wrongly scope requests once the backend enforces it). The server then falls
        // back to the workspace's default env.
        setActiveEnvironment(null);
        setActiveSlug(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  function switchTo(slug: string) {
    if (slug === activeSlug) {
      setOpen(false);
      return;
    }
    setActiveEnvironment(slug);
    // Reload so every screen re-fetches under the new environment header.
    window.location.reload();
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
      setActiveEnvironment(env.slug);
      window.location.reload();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not create environment.",
      );
    } finally {
      setBusy(false);
    }
  }

  // Nothing to show until the workspace's environments resolve.
  if (!tenantId || envs.length === 0) return null;
  const active = envs.find((e) => e.slug === activeSlug) ?? envs[0];

  return (
    <div style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Switch environment"
        style={{
          all: "unset",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 5,
          padding: "3px 8px",
          borderRadius: 6,
          border: "1px solid var(--line)",
          background: "var(--bg-2)",
        }}
      >
        <span
          style={{
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: 0.5,
            textTransform: "uppercase",
            color: "var(--ink-3)",
          }}
        >
          env
        </span>
        <span
          style={{
            fontSize: 11.5,
            fontWeight: 600,
            color: "var(--ink)",
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

      {open && (
        <>
          <div
            onClick={() => setOpen(false)}
            style={{ position: "fixed", inset: 0, zIndex: 40 }}
          />
          <div
            role="listbox"
            style={{
              position: "absolute",
              top: "calc(100% + 6px)",
              left: 0,
              minWidth: 200,
              zIndex: 41,
              background: "var(--bg-2)",
              border: "1px solid var(--line)",
              borderRadius: 10,
              boxShadow: "0 8px 28px rgba(0,0,0,.28)",
              padding: 6,
            }}
          >
            {envs.map((e) => {
              const isActive = e.slug === active.slug;
              return (
                <button
                  key={e.id}
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  onClick={() => switchTo(e.slug)}
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
                    background: isActive
                      ? "var(--bg-3, rgba(255,255,255,.05))"
                      : "transparent",
                  }}
                >
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontSize: 12.5,
                      color: "var(--ink)",
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
