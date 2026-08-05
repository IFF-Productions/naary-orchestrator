/**
 * Persistent context bar (redesign shell, "Naary Shell.dc.html") — the 52px top bar every
 * screen inherits: brand · workspace · environment · Builder/Simple variant on the left;
 * live "N approvals waiting", primary CTA, theme toggle, notifications and the user avatar
 * on the right. Workspace / environment / variant are CONTEXT here — never nav screens.
 */
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { Button, Icon } from "../components";
import { clearToken } from "../lib/auth";
import { BELOW_DRAWER_QUERY, useMediaQuery } from "../lib/useMediaQuery";
import { useMode } from "../mode";
import { useTheme } from "../theme";
import { EnvironmentSwitcher } from "../workspace/EnvironmentSwitcher";
import {
  WorkspaceSwitcher,
  workspaceLabel,
} from "../workspace/WorkspaceSwitcher";
import { useWorkspace } from "../workspace/WorkspaceProvider";
import { NotificationsBell } from "./NotificationsBell";

function Divider() {
  return (
    <span
      aria-hidden
      style={{
        width: 1,
        height: 20,
        background: "var(--line-mid)",
        flex: "none",
      }}
    />
  );
}

/** Builder/Simple — two variants, one engine; a subset lens, not a separate app. */
export function VariantSwitcher() {
  const { mode, setMode } = useMode();
  // Below 1024 this control renders in ONE place: the drawer top (`AppShell`'s `.drawer-context`),
  // because the wrapped context bar drops it. So the query is a reliable "this is the touch
  // presentation" signal without threading a prop through both call sites.
  const touch = useMediaQuery(BELOW_DRAWER_QUERY);
  const variants = [
    ["builder", "Builder"],
    ["simple", "Simple"],
  ] as const;
  return (
    <div
      role="group"
      aria-label="Product variant"
      style={{
        display: "flex",
        gap: 3,
        background: "var(--bg)",
        border: "1px solid var(--line-2)",
        borderRadius: "var(--radius-md)",
        padding: 3,
      }}
    >
      {variants.map(([id, label]) => {
        const active = mode === id;
        return (
          <button
            key={id}
            type="button"
            aria-pressed={active}
            onClick={() => setMode(id)}
            style={{
              all: "unset",
              // Centres the label once the segment is taller than its text.
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 11.5,
              padding: "4px 11px",
              borderRadius: 6,
              cursor: "pointer",
              fontWeight: 600,
              color: active ? "var(--ink)" : "var(--ink-faint)",
              background: active ? "var(--card)" : "transparent",
              // >= 44px hit area in the drawer. Measured 60.8 x 25.8 at 390x844 before this:
              // `.drawer-context button { min-height: 44px }` could never apply, because the
              // `all: unset` above is an INLINE declaration that expands to `min-height: unset`.
              //
              // Height-only, and safe: the two segments are side by side (measured 3px apart
              // horizontally), so growing DOWN cannot reach either. The drawer top is a flex
              // COLUMN with `gap: 10`, so the group below simply moves down 18px.
              minHeight: touch ? 44 : undefined,
              boxSizing: "border-box",
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

/** Avatar → menu (signed-in context + sign out; sign-out left the old sidebar footer). */
function AvatarMenu({ compact }: { compact: boolean }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { logout } = useAuth();
  const { activeId, workspaces } = useWorkspace();
  const ref = useRef<HTMLDivElement>(null);

  const activeWs = workspaces.find((w) => w.tenantId === activeId);
  const wsLabel = activeId
    ? workspaceLabel(activeId, activeWs?.name)
    : undefined;
  const initials =
    (wsLabel ?? activeId ?? "?")
      .replace(/[^a-zA-Z0-9]/g, "")
      .slice(0, 2)
      .toUpperCase() || "?";

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Sign out of BOTH session kinds: Firebase (if signed in) and the pasted
  // `nry_` token, then return to the sign-in screen.
  function handleLogout(): void {
    logout();
    clearToken();
    navigate("/auth");
  }

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Account"
        aria-label="Account"
        style={{
          all: "unset",
          // ≥44px hit area on touch (compact) — a 30px dot at desktop.
          width: compact ? 44 : 30,
          height: compact ? 44 : 30,
          borderRadius: "50%",
          cursor: "pointer",
          background: "linear-gradient(140deg, #f2622e, #c8331f)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 11,
          fontWeight: 600,
          color: "#fff",
          flex: "none",
        }}
      >
        {initials}
      </button>
      {open && (
        <>
          <div
            onClick={() => setOpen(false)}
            style={{ position: "fixed", inset: 0, zIndex: 40 }}
          />
          <div
            role="menu"
            className="menu-pop"
            style={{
              position: "absolute",
              top: "calc(100% + 8px)",
              right: 0,
              minWidth: 190,
              zIndex: 41,
              background: "var(--panel)",
              border: "1px solid var(--line-mid)",
              borderRadius: 10,
              boxShadow: "var(--shadow-raised)",
              padding: 6,
            }}
          >
            <div style={{ padding: "6px 9px 8px" }}>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 500,
                  color: "var(--ink)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {wsLabel ?? "Signed in"}
              </div>
              <div style={{ fontSize: 10, color: "var(--ink-3)" }}>
                {wsLabel ? "Workspace" : "API token"}
              </div>
            </div>
            <div
              style={{
                height: 1,
                background: "var(--line)",
                margin: "0 3px 4px",
              }}
            />
            <button
              type="button"
              role="menuitem"
              onClick={handleLogout}
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
              <Icon name="logout" size={13} style={{ flex: "none" }} />
              Sign out
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function ContextBar({
  approvalsCount,
  compact,
  phone,
  drawerOpen,
  onToggleDrawer,
}: {
  approvalsCount: number;
  /** `<= 1024px`: hamburger + wrapped bar; workspace + variant move into the drawer. */
  compact: boolean;
  /** `<= 640px`: stay a SINGLE line — trim to essentials (no brand tile / builder CTA,
   *  count-only approvals) so the bar never wraps to two rows on a phone. */
  phone: boolean;
  drawerOpen: boolean;
  onToggleDrawer: () => void;
}) {
  const { theme, toggleTheme } = useTheme();
  const { mode } = useMode();
  const navigate = useNavigate();

  return (
    <header
      // `ctx-bar` bumps icon buttons to a 44px hit area at <= 1024 (see components.css).
      className={compact ? "ctx-bar" : undefined}
      style={{
        minHeight: 52,
        flex: "none",
        borderBottom: "1px solid var(--line)",
        background: "var(--panel)",
        display: "flex",
        alignItems: "center",
        // The bar is ALWAYS one line. Never wrap — the earlier `compact && !phone => wrap` split
        // put a phone into two rows whenever the layout viewport read > 640 (Safari page-zoom /
        // an un-narrow tablet). Instead the contents trim on `compact` and the env region shrinks,
        // so a single row holds down to the narrowest phone.
        flexWrap: "nowrap",
        gap: phone ? 8 : 12,
        padding: compact ? "6px 12px" : "0 16px",
        position: "relative",
        zIndex: 10,
      }}
    >
      {/* Hamburger — opens the nav drawer at <= 1024. */}
      {compact && (
        <button
          type="button"
          aria-label="Menu"
          title="Menu"
          aria-expanded={drawerOpen}
          onClick={onToggleDrawer}
          className="btn btn-secondary btn-icon"
        >
          <Icon name="menu" size={18} />
        </button>
      )}

      {/* Brand tile — ember flame on the identity gradient. Dropped whenever the hamburger shows
          (compact): it's redundant next to it, and its 28px + gap is the room the bar reclaims to
          stay one line across the whole small-screen range (incl. zoomed-out phones). */}
      {!compact && (
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: 8,
            flex: "none",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "var(--brand-radial)",
            boxShadow: "0 0 14px -2px rgba(242, 98, 46, 0.6)",
          }}
        >
          <Icon name="flame" size={16} style={{ color: "var(--brand-ink)" }} />
        </div>
      )}

      {/* Workspace + variant are CONTEXT that moves into the drawer top at <= 1024;
          the environment switcher stays inline at every size (it's the hero of the bar).
          On a phone it may shrink (min-width:0) so the row never overflows. */}
      {!compact && <WorkspaceSwitcher />}
      {!compact && <Divider />}
      <div style={{ minWidth: 0, display: "flex", flexShrink: 1 }}>
        <EnvironmentSwitcher />
      </div>
      {!compact && (
        <>
          <Divider />
          <VariantSwitcher />
        </>
      )}

      <div
        style={{
          marginLeft: "auto",
          display: "flex",
          alignItems: "center",
          gap: phone ? 4 : 10,
          flex: "none",
        }}
      >
        {/* Live human-in-the-loop signal — approvals are the hero, never buried. Stays
            visible at every size; the label just contracts to a count on the wrapped bar. */}
        {approvalsCount > 0 && (
          <button
            type="button"
            onClick={() => navigate("/app/approvals")}
            title={`${approvalsCount} approval${approvalsCount === 1 ? "" : "s"} waiting`}
            aria-label={`${approvalsCount} approval${approvalsCount === 1 ? "" : "s"} waiting`}
            style={{
              all: "unset",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 7,
              fontSize: 12,
              fontWeight: compact ? 600 : undefined,
              color: "var(--ink-2)",
              border: "1px solid var(--line-2)",
              borderRadius: "var(--radius-pill)",
              // ≥44px hit area on the wrapped (compact) bar.
              minHeight: compact ? 44 : undefined,
              // Phone: a tight count-only pill so the bar stays one line.
              padding: phone ? "0 10px" : compact ? "0 13px" : "5px 11px",
              boxSizing: "border-box",
              whiteSpace: "nowrap",
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: "var(--env-prod)",
                boxShadow: "0 0 8px var(--env-prod)",
                flex: "none",
              }}
            />
            {/* Phone: count only; tablet: "N approvals"; desktop: "N approvals waiting". */}
            {phone
              ? approvalsCount
              : compact
                ? `${approvalsCount} approval${approvalsCount === 1 ? "" : "s"}`
                : `${approvalsCount} approval${approvalsCount === 1 ? "" : "s"} waiting`}
          </button>
        )}

        {/* Primary CTA is dropped on a phone (it's reachable via the drawer → Canvas editor);
            keeping it would push the bar to a second row. */}
        {mode === "builder" && !phone && (
          <Button
            variant="primary"
            icon="plus"
            iconOnly={compact}
            title="New workflow"
            aria-label="New workflow"
            onClick={() => navigate("/app/canvas")}
          >
            {compact ? undefined : "New workflow"}
          </Button>
        )}
        <Button
          iconOnly
          icon={theme === "dark" ? "moon" : "sun"}
          onClick={toggleTheme}
          title="Toggle theme"
          aria-label="Toggle theme"
        />
        <NotificationsBell />
        <AvatarMenu compact={compact} />
      </div>
    </header>
  );
}
