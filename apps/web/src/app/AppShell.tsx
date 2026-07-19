/**
 * App shell (redesign, "Naary Shell.dc.html") — the global chrome every /app screen
 * inherits: a persistent 52px context bar (workspace · environment · variant · live
 * approvals · theme · avatar) over a five-mode nav rail (Build / Operate / Observe /
 * Connect / Admin) and a breadcrumb'd content region with progress-bar + fade-in
 * navigation. Responsive: phone < 720 → slide-in drawer + hamburger; tablet 720–1080 →
 * auto icon-rail; desktop ≥ 1080 → full 236px rail with manual collapse.
 */
import { useEffect, useState } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import {
  BELOW_RAIL_QUERY,
  PHONE_QUERY,
  useMediaQuery,
} from "../lib/useMediaQuery";
import { useActiveEnvironment } from "../lib/useActiveEnvironment";
import { type Environment, api } from "../lib/api";
import { useMode } from "../mode";
import { useWorkspace } from "../workspace/WorkspaceProvider";
import {
  EnvironmentSwitcher,
  envAccent,
} from "../workspace/EnvironmentSwitcher";
import { BreadcrumbBar } from "./BreadcrumbBar";
import { ContextBar, VariantSwitcher } from "./ContextBar";
import { NavigationProgress } from "./NavigationProgress";
import { NavRail } from "./NavRail";
import { BUILDER_MODES, SIMPLE_ALLOWED, SIMPLE_MODES } from "./nav-model";
import { useApprovalsCount } from "./useApprovalsCount";

export function AppShell() {
  const phone = useMediaQuery(PHONE_QUERY);
  const belowRail = useMediaQuery(BELOW_RAIL_QUERY);
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Icon-only rail: on tablet automatically, or when the user collapses on desktop.
  // Never on phone — there the sidebar is a full-width drawer showing labels.
  const rail = !phone && (belowRail || collapsed);
  const { mode } = useMode();
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

  // Close the mobile drawer on any navigation (nav item, logo).
  useEffect(() => setDrawerOpen(false), [pathname]);
  // Also close it when leaving phone width, so a resize back to phone doesn't reopen a
  // drawer left "open" from before (drawerOpen is only consulted while phone is true).
  useEffect(() => {
    if (!phone) setDrawerOpen(false);
  }, [phone]);
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

  // Rail: a fixed slide-in drawer on phone, an in-flow column (icon rail or full) otherwise.
  const sideBase: React.CSSProperties = {
    background: "var(--panel)",
    borderRight: "1px solid var(--line)",
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    overflow: "hidden",
  };
  const sideStyle: React.CSSProperties = phone
    ? {
        ...sideBase,
        position: "fixed",
        top: 0,
        left: 0,
        bottom: 0,
        width: 262,
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
        phone={phone}
        drawerOpen={drawerOpen}
        onToggleDrawer={() => setDrawerOpen((o) => !o)}
      />

      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/* Backdrop behind the mobile drawer — tap to close. Phone + open only. */}
        {phone && drawerOpen && (
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
        {/* `inert` when the phone drawer is closed: it's only moved off-screen with transform,
            so without this its links/buttons stay keyboard-focusable + exposed to assistive tech. */}
        <aside style={sideStyle} inert={phone && !drawerOpen}>
          {/* Phone drawer: env + variant switchers live here (the context bar hides them). */}
          {phone && (
            <div
              style={{
                flex: "none",
                padding: "12px 12px 4px",
                display: "flex",
                flexDirection: "column",
                gap: 8,
                borderBottom: "1px solid var(--line)",
                paddingBottom: 12,
              }}
            >
              <EnvironmentSwitcher />
              <VariantSwitcher />
            </div>
          )}
          <NavRail
            modes={modes}
            approvalsCount={approvalsCount}
            rail={rail}
            collapsed={collapsed}
            showCollapseToggle={!phone && !belowRail}
            onCollapseToggle={() => setCollapsed((c) => !c)}
          />
        </aside>

        {/* ===== CONTENT ===== */}
        {/* `inert` while the phone drawer is open so the content behind it is out of the tab
            order + hidden from assistive tech — a modal drawer. The backdrop is a sibling
            (not inert), so it still closes on click; Escape closes it too (above). */}
        <div
          inert={phone && drawerOpen}
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
