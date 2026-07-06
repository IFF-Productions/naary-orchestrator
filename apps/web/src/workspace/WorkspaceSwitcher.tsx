/**
 * Workspace switcher for the app shell (design §8). Lists the caller's workspaces from the
 * context and switches the active one (which re-scopes every request via X-Workspace-Id),
 * plus a "New workspace" action. Sits in the sidebar brand block.
 */
import { useState } from "react";
import { Icon } from "../components";
import { useWorkspace } from "./WorkspaceProvider";

/** A readable label for a workspace: its display name if set, else a stub from the id
 *  (server ids are `ws-<uuid>`; legacy are `t-*`). */
export function workspaceLabel(id: string, name?: string): string {
  if (name?.trim()) return name.trim();
  if (id.startsWith("ws-")) return `Workspace ${id.slice(3, 9)}`;
  return id;
}

export function WorkspaceSwitcher({ labelOp = 1 }: { labelOp?: number }) {
  const { workspaces, activeId, setActive, create } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  async function onCreate(): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      await create();
      setOpen(false);
    } catch (e) {
      // Surface the failure in-place — e.g. an nry_ token user (403, no user identity) or a
      // transient server error — instead of an unhandled rejection with no feedback.
      setError(
        e instanceof Error ? e.message : "Could not create the workspace.",
      );
    } finally {
      setBusy(false);
    }
  }

  const active = workspaces.find((w) => w.tenantId === activeId);

  return (
    <div style={{ flex: 1, minWidth: 0, position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Switch workspace"
        style={{
          all: "unset",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          minWidth: 0,
          opacity: labelOp,
        }}
      >
        <span style={{ flex: 1, minWidth: 0 }}>
          <span
            style={{
              display: "block",
              fontSize: 14,
              fontWeight: 700,
              color: "var(--ink)",
              lineHeight: 1.1,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {active ? workspaceLabel(active.tenantId, active.name) : "Naary"}
          </span>
          <span
            style={{
              display: "block",
              fontSize: 10.5,
              color: "var(--ink-3)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {active ? active.role : "No workspace"}
          </span>
        </span>
        <Icon
          name="chevron-up-down"
          size={14}
          style={{ color: "var(--ink-3)", flex: "none" }}
        />
      </button>

      {open && (
        <>
          {/* click-away backdrop */}
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
            {workspaces.map((w) => {
              const isActive = w.tenantId === activeId;
              return (
                <button
                  key={w.tenantId}
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  onClick={() => {
                    setActive(w.tenantId);
                    setOpen(false);
                  }}
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
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {workspaceLabel(w.tenantId, w.name)}
                  </span>
                  <span style={{ fontSize: 10, color: "var(--ink-3)" }}>
                    {w.role}
                  </span>
                  {isActive && (
                    <Icon
                      name="check"
                      size={13}
                      style={{ color: "var(--accent, #6ea8fe)", flex: "none" }}
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
            <button
              type="button"
              disabled={busy}
              onClick={onCreate}
              style={{
                all: "unset",
                cursor: busy ? "default" : "pointer",
                display: "flex",
                alignItems: "center",
                gap: 8,
                width: "100%",
                boxSizing: "border-box",
                padding: "7px 9px",
                borderRadius: 7,
                color: "var(--ink-2)",
                fontSize: 12.5,
                opacity: busy ? 0.6 : 1,
              }}
            >
              <Icon name="plus" size={13} style={{ flex: "none" }} />
              {busy ? "Creating…" : "New workspace"}
            </button>
            {error && (
              <div
                style={{
                  padding: "4px 9px 2px",
                  fontSize: 11,
                  color: "var(--danger, #e5484d)",
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
