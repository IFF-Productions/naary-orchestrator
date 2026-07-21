/**
 * App shell (redesign, "Naary Shell.dc.html") — the global chrome every /app screen
 * inherits: a persistent 52px context bar (workspace · environment · variant · live
 * approvals · theme · avatar) over a five-mode nav rail (Build / Operate / Observe /
 * Connect / Admin) and a breadcrumb'd content region with progress-bar + fade-in
 * navigation. Responsive: <= 1024 → hamburger slide-out drawer (workspace + variant live
 * in the drawer top; the context bar wraps); desktop > 1024 → full 236px rail with manual
 * collapse to a 70px icon rail.
 */
import { useEffect, useState } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import {
  BELOW_DRAWER_QUERY,
  PHONE_QUERY,
  useMediaQuery,
} from "../lib/useMediaQuery";
import { useActiveEnvironment } from "../lib/useActiveEnvironment";
import { type Environment, api } from "../lib/api";
import { useMode } from "../mode";
import { useWorkspace } from "../workspace/WorkspaceProvider";
import { envAccent } from "../workspace/EnvironmentSwitcher";
import { WorkspaceSwitcher } from "../workspace/WorkspaceSwitcher";
import { Icon } from "../components";
import { BreadcrumbBar } from "./BreadcrumbBar";
import { ContextBar, VariantSwitcher } from "./ContextBar";
import { NavigationProgress } from "./NavigationProgress";
import { NavRail } from "./NavRail";
import { BUILDER_MODES, SIMPLE_ALLOWED, SIMPLE_MODES } from "./nav-model";
import { useApprovalsCount } from "./useApprovalsCount";

export function AppShell() {
  // <= 1024: the nav rail becomes a hamburger slide-out drawer and the context bar wraps.
  const smallShell = useMediaQuery(BELOW_DRAWER_QUERY);
  const phone = useMediaQuery(PHONE_QUERY);
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Dismissible "Builder is best on a larger screen" hint — per session (AppShell never
  // unmounts across in-app navigation, so this state survives route changes).
  const [builderHintDismissed, setBuilderHintDismissed] = useState(false);
  // Icon-only rail: only on desktop, only when the user manually collapses. Below the drawer
  // threshold the sidebar is a full-width drawer showing labels instead.
  const rail = !smallShell && collapsed;
  const { mode, setMode } = useMode();
  const { activeId } = useWorkspace();
  const approvalsCount = useApprovalsCount();

  // Active environment for the breadcrumb's inline env echo. `activeEnv` (slug/id) updates
  // live on switch via the env store; the list resolves its display name + accent. Falls back
  // to the slug/id if the name hasn't resolved yet; hides when the workspace has no envs.
  const activeEnv = useActiveEnvironment();
  const [envs, setEnvs] = useState<Environment[]>([]);
  useEffect(() => {
    if (!activeId) return;
    let live = true;
    api
      .listEnvironments(activeId)
      .then((list) => live && setEnvs(list))
      .catch(() => live && setEnvs([]));
    return () => {
      live = false;
    };
  }, [activeId]);
  const activeEnvObj = envs.find(
    (e) => e.slug === activeEnv || e.id === activeEnv,
  );
  const activeEnvName =
    activeEnvObj?.name ??
    (activeEnv && envs.length === 0 ? activeEnv : undefined);

  const { pathname } = useLocation();

  // Close the drawer on any navigation (nav item, Hub/logo).
  useEffect(() => setDrawerOpen(false), [pathname]);
  // Also close it when growing past the drawer threshold, so a resize back down doesn't reopen
  // a drawer left "open" from before (drawerOpen is only consulted while smallShell is true).
  useEffect(() => {
    if (!smallShell) setDrawerOpen(false);
  }, [smallShell]);
  // Escape closes the drawer (the hamburger is inert with the background while it's open, so
  // the keyboard dismiss path is Escape + the backdrop click).
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  // Mode gating: Simple users get the subset nav + are redirected away from Builder-only routes.
  const simple = mode === "simple";
  const modes = simple ? SIMPLE_MODES : BUILDER_MODES;
  const simpleBlocked =
    simple &&
    !SIMPLE_ALLOWED.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  if (simpleBlocked) return <Navigate to="/app/automations" replace />;

  // Rail: a fixed slide-out drawer at <= 1024, an in-flow column (icon rail or full) otherwise.
  const sideBase: React.CSSProperties = {
    background: "var(--panel)",
    borderRight: "1px solid var(--line)",
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    overflow: "hidden",
  };
  const sideStyle: React.CSSProperties = smallShell
    ? {
        ...sideBase,
        position: "fixed",
        top: 0,
        left: 0,
        bottom: 0,
        width: 284,
        maxWidth: "88vw",
        zIndex: 60,
        transform: `translateX(${drawerOpen ? "0" : "-115%"})`,
        transition: "transform .22s ease",
        boxShadow: drawerOpen ? "0 24px 70px -12px rgba(0,0,0,.75)" : "none",
      }
    : {
        ...sideBase,
        width: rail ? 70 : 236,
        flex: "none",
        transition: "width .16s ease",
      };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        overflow: "hidden",
        background: "var(--bg)",
      }}
    >
      {/* ===== PERSISTENT CONTEXT BAR ===== */}
      <ContextBar
        approvalsCount={approvalsCount}
        compact={smallShell}
        phone={phone}
        drawerOpen={drawerOpen}
        onToggleDrawer={() => setDrawerOpen((o) => !o)}
      />

      {/* Builder-on-small hint — Builder is dense; nudge to Simple on the small shell. */}
      {mode === "builder" && smallShell && !builderHintDismissed && (
        <div
          role="status"
          style={{
            flex: "none",
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "9px 14px",
            fontSize: 12.5,
            color: "var(--ink-2)",
            background: "var(--brand-soft)",
            borderBottom: "1px solid var(--line)",
          }}
        >
          <Icon
            name="info"
            size={14}
            style={{ color: "var(--brand)", flex: "none" }}
          />
          <span style={{ flex: 1, minWidth: 0 }}>
            Builder is best on a larger screen —{" "}
            <button
              type="button"
              onClick={() => setMode("simple")}
              style={{
                all: "unset",
                cursor: "pointer",
                color: "var(--brand)",
                fontWeight: 600,
                textDecoration: "underline",
              }}
            >
              switch to Simple
            </button>
          </span>
          <button
            type="button"
            aria-label="Dismiss"
            title="Dismiss"
            onClick={() => setBuilderHintDismissed(true)}
            className="btn btn-ghost btn-icon btn-sm"
            style={{ flex: "none" }}
          >
            <Icon name="x" size={14} />
          </button>
        </div>
      )}

      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/* Backdrop behind the drawer — tap to close. Only while the drawer (<= 1024) is open. */}
        {smallShell && drawerOpen && (
          <div
            onClick={() => setDrawerOpen(false)}
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(4,6,10,.55)",
              zIndex: 55,
            }}
          />
        )}

        {/* ===== FIVE-MODE NAV RAIL ===== */}
        {/* `inert` when the drawer (<= 1024) is closed: it's only moved off-screen with transform,
            so without this its links/buttons stay keyboard-focusable + exposed to assistive tech. */}
        <aside style={sideStyle} inert={smallShell && !drawerOpen}>
          {/* Drawer top (<= 1024): workspace + variant live here — the wrapped context bar
              moves them out (it keeps the environment switcher inline instead). */}
          {smallShell && (
            <div
              // `drawer-context` gives the relocated segmented switchers a >= 44px hit area.
              className="drawer-context"
              style={{
                flex: "none",
                padding: "14px 14px 12px",
                display: "flex",
                flexDirection: "column",
                gap: 10,
                borderBottom: "1px solid var(--line)",
              }}
            >
              <WorkspaceSwitcher />
              <VariantSwitcher />
            </div>
          )}
          <NavRail
            modes={modes}
            approvalsCount={approvalsCount}
            rail={rail}
            touch={smallShell}
            collapsed={collapsed}
            showCollapseToggle={!smallShell}
            onCollapseToggle={() => setCollapsed((c) => !c)}
          />
        </aside>

        {/* ===== CONTENT ===== */}
        {/* `inert` while the drawer (<= 1024) is open so the content behind it is out of the tab
            order + hidden from assistive tech — a modal drawer. The backdrop is a sibling
            (not inert), so it still closes on click; Escape closes it too (above). */}
        <div
          inert={smallShell && drawerOpen}
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            position: "relative",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <NavigationProgress />
          <main
            style={{
              flex: 1,
              overflowY: "auto",
              minHeight: 0,
              background:
                "radial-gradient(120% 70% at 85% -5%, var(--grad-a), var(--bg) 55%)",
            }}
          >
            <BreadcrumbBar
              modes={modes}
              envName={activeEnvName}
              envAccent={
                activeEnvObj
                  ? envAccent(activeEnvObj)
                  : activeEnvName
                    ? envAccent({ slug: activeEnvName, name: activeEnvName })
                    : undefined
              }
            />
            {/* Key the routed screen by path + environment: navigation fades the new screen
                in (in-place swap), and an env switch remounts the current screen so it
                re-fetches under the new X-Environment-Id — no full page reload. */}
            <div
              key={`${pathname}|${activeEnv ?? "default"}`}
              style={{ animation: "naaryFadeUp .28s ease both" }}
            >
              <Outlet />
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
