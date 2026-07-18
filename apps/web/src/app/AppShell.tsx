import { useEffect, useState } from "react";
import {
  Navigate,
  NavLink,
  Outlet,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { Button, Icon, SearchInput } from "../components";
import type { IconName } from "../components";
import { clearToken } from "../lib/auth";
import {
  BELOW_RAIL_QUERY,
  DESKTOP_QUERY,
  PHONE_QUERY,
  useMediaQuery,
} from "../lib/useMediaQuery";
import { useActiveEnvironment } from "../lib/useActiveEnvironment";
import { type Environment, api } from "../lib/api";
import { PAGE_META } from "../lib/mock";
import { useMode } from "../mode";
import { useTheme } from "../theme";
import { useWorkspace } from "../workspace/WorkspaceProvider";
import { EnvironmentSwitcher } from "../workspace/EnvironmentSwitcher";
import { NotificationsBell } from "./NotificationsBell";
import {
  WorkspaceSwitcher,
  workspaceLabel,
} from "../workspace/WorkspaceSwitcher";

interface NavItemDef {
  to: string;
  label: string;
  icon: IconName;
  badge?: string;
  external?: boolean;
}

const GROUPS: { heading: string; items: NavItemDef[] }[] = [
  {
    heading: "Operate",
    items: [
      { to: "/app", label: "Overview", icon: "grid" },
      { to: "/app/workflows", label: "Workflows", icon: "workflow" },
      { to: "/app/runs", label: "Runs", icon: "activity" },
      { to: "/app/activity", label: "Activity", icon: "clock" },
      { to: "/app/approvals", label: "Approvals", icon: "approval" },
      { to: "/app/schedules", label: "Schedules", icon: "clock" },
      { to: "/app/templates", label: "Templates", icon: "template" },
    ],
  },
  {
    heading: "Build",
    items: [
      {
        to: "/app/canvas",
        label: "Canvas editor",
        icon: "edit",
        external: true,
      },
      { to: "/app/integrations", label: "Integrations", icon: "plug" },
    ],
  },
  {
    heading: "Insights",
    items: [
      { to: "/app/observability", label: "Observability", icon: "chart" },
      { to: "/app/billing", label: "Billing & usage", icon: "card" },
      { to: "/app/company", label: "Company", icon: "users" },
    ],
  },
];

const FOOTER_ITEMS: NavItemDef[] = [
  { to: "/app/team", label: "Team", icon: "users" },
  { to: "/app/groups", label: "Groups", icon: "key" },
  { to: "/app/settings", label: "Settings", icon: "settings" },
];

// Simple-mode nav (design PRODUCT-VARIANTS.md §6) — no canvas / integrations / observability.
const SIMPLE_GROUPS: { heading: string; items: NavItemDef[] }[] = [
  {
    heading: "Automate",
    items: [
      { to: "/app/automations", label: "Automations", icon: "workflow" },
      { to: "/app/runs", label: "Runs", icon: "activity" },
      { to: "/app/approvals", label: "Approvals", icon: "approval" },
    ],
  },
];
const SIMPLE_FOOTER: NavItemDef[] = [
  { to: "/app/connect-ai", label: "Connect AI", icon: "plug" },
  { to: "/app/settings", label: "Settings", icon: "settings" },
];

// Paths a Simple-mode user may reach; anything else under /app redirects to /app/automations.
const SIMPLE_ALLOWED = [
  "/app/automations",
  "/app/runs",
  "/app/approvals",
  "/app/settings",
  "/app/connect-ai",
];

export function AppShell() {
  // Responsive shell (mirrors the Naary design comp): phone < 720 → slide-in drawer +
  // hamburger; tablet 720–1080 → auto icon-rail; desktop ≥ 1080 → full sidebar + search.
  const phone = useMediaQuery(PHONE_QUERY);
  const belowRail = useMediaQuery(BELOW_RAIL_QUERY);
  const showSearch = useMediaQuery(DESKTOP_QUERY);
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Icon-only rail: on tablet automatically, or when the user collapses on desktop.
  // Never on phone — there the sidebar is a full-width drawer showing labels.
  const rail = !phone && (belowRail || collapsed);
  const { theme, toggleTheme } = useTheme();
  const { mode } = useMode();
  const { logout } = useAuth();
  const { activeId, workspaces } = useWorkspace();

  // Active environment for the app-bar pill. `activeEnv` (slug/id) updates live on switch via the
  // env store; the list resolves its display name. Per-workspace, so re-resolve when the workspace
  // changes. Falls back to the slug/id if the name hasn't resolved yet, and the pill hides when the
  // workspace has no environments.
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
  const activeEnvName =
    envs.find((e) => e.slug === activeEnv || e.id === activeEnv)?.name ??
    (activeEnv && envs.length === 0 ? activeEnv : undefined);
  const activeWs = workspaces.find((w) => w.tenantId === activeId);
  const wsLabel = activeId
    ? workspaceLabel(activeId, activeWs?.name)
    : undefined;
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [title, sub] = PAGE_META[pathname] ?? ["Naary", ""];

  // Close the mobile drawer on any navigation (nav item, search, "New workflow", logo).
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

  // Global search: jump to Workflows filtered by the query (Workflows reads ?q). In Simple mode
  // that route is hidden, so land on the automations list instead.
  const runSearch = (q: string) => {
    const query = q.trim();
    navigate(
      mode === "simple"
        ? "/app/automations"
        : query
          ? `/app/workflows?q=${encodeURIComponent(query)}`
          : "/app/workflows",
    );
    setSearch("");
  };
  const labelOp = rail ? 0 : 1;

  // Mode gating: Simple users get the friendly nav + are redirected away from Builder-only routes.
  const simple = mode === "simple";
  const groups = simple ? SIMPLE_GROUPS : GROUPS;
  const footerItems = simple ? SIMPLE_FOOTER : FOOTER_ITEMS;
  const simpleBlocked =
    simple &&
    !SIMPLE_ALLOWED.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  // Sign out of BOTH session kinds: Firebase (if signed in) and the pasted
  // `nry_` token, then return to the sign-in screen.
  function handleLogout(): void {
    logout();
    clearToken();
    navigate("/auth");
  }

  if (simpleBlocked) return <Navigate to="/app/automations" replace />;

  // Sidebar: a fixed slide-in drawer on phone, an in-flow column (rail or full) otherwise.
  const sideBase: React.CSSProperties = {
    background: "var(--bg-2)",
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
        width: rail ? 70 : 244,
        flex: "none",
        transition: "width .16s ease",
      };

  return (
    <div
      style={{
        display: "flex",
        height: "100vh",
        overflow: "hidden",
        background: "var(--bg)",
      }}
    >
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

      {/* ===== SIDEBAR ===== */}
      {/* `inert` when the phone drawer is closed: it's only moved off-screen with transform,
          so without this its links/buttons stay keyboard-focusable + exposed to assistive tech. */}
      <aside style={sideStyle} inert={phone && !drawerOpen}>
        {/* brand + workspace */}
        <div
          style={{
            height: 56,
            flex: "none",
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "0 14px",
            borderBottom: "1px solid var(--line)",
          }}
        >
          <BrandTile />
          <WorkspaceSwitcher labelOp={labelOp} />
        </div>

        {/* environment switcher (per-workspace sandbox/UAT/prod) — hidden when the rail collapses */}
        {!rail && (
          <div
            style={{
              flex: "none",
              padding: "8px 14px 0",
              display: "flex",
            }}
          >
            <EnvironmentSwitcher />
          </div>
        )}

        {/* nav */}
        <nav
          style={{
            flex: 1,
            overflowY: "auto",
            overflowX: "hidden",
            padding: "10px 10px 14px",
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          {groups.map((g) => (
            <div key={g.heading}>
              <GroupHeading op={labelOp}>{g.heading}</GroupHeading>
              {g.items.map((it) => (
                <NavRow
                  key={it.to}
                  item={it}
                  collapsed={rail}
                  labelOp={labelOp}
                />
              ))}
            </div>
          ))}
          <div style={{ flex: 1 }} />
          {footerItems.map((it) => (
            <NavRow key={it.to} item={it} collapsed={rail} labelOp={labelOp} />
          ))}
        </nav>

        {/* user */}
        <div
          style={{
            flex: "none",
            borderTop: "1px solid var(--line)",
            padding: 10,
            display: "flex",
            // Rail: stack avatar + toggle vertically and center them so the
            // toggle fits the 70px rail instead of overflowing the row.
            flexDirection: rail ? "column" : "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 9,
          }}
        >
          <span
            style={{
              width: 30,
              height: 30,
              borderRadius: "50%",
              flex: "none",
              background: "var(--avatar-bg)",
              border: "1px solid var(--line-2)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 11,
              fontWeight: 600,
              color: "var(--ink-2)",
            }}
          >
            {(wsLabel ?? activeId ?? "?")
              .replace(/[^a-zA-Z0-9]/g, "")
              .slice(0, 2)
              .toUpperCase() || "?"}
          </span>
          {/* Label takes no space when collapsed (display none, not just opacity)
              so it can't squeeze the buttons out of the rail. */}
          <div
            style={{
              flex: 1,
              minWidth: 0,
              opacity: labelOp,
              display: rail ? "none" : "block",
            }}
          >
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
          <button
            title="Sign out"
            aria-label="Sign out"
            onClick={handleLogout}
            className="btn btn-secondary btn-icon btn-sm"
          >
            <Icon name="logout" size={14} />
          </button>
          {/* Manual collapse — DESKTOP only. On tablet the rail is automatic (belowRail),
              so toggling `collapsed` there is a no-op; on phone it's a drawer. */}
          {!belowRail && (
            <button
              title={collapsed ? "Expand" : "Collapse"}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              onClick={() => setCollapsed((c) => !c)}
              className="btn btn-secondary btn-icon btn-sm"
            >
              <Icon
                name={collapsed ? "sidebar-expand" : "sidebar-collapse"}
                size={14}
              />
            </button>
          )}
        </div>
      </aside>

      {/* ===== MAIN ===== */}
      {/* `inert` while the phone drawer is open so the content behind it (topbar + main) is
          out of the tab order + hidden from assistive tech — a modal drawer. The backdrop is a
          sibling (not inert), so it still closes on click; Escape closes it too (below). */}
      <div
        inert={phone && drawerOpen}
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
          minHeight: 0,
        }}
      >
        {/* topbar */}
        <header
          style={{
            height: 56,
            flex: "none",
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "0 20px",
            background: "var(--bg-2)",
            borderBottom: "1px solid var(--line)",
            zIndex: 10,
          }}
        >
          {/* Hamburger — phone only; opens the sidebar drawer. */}
          {phone && (
            <button
              type="button"
              aria-label="Menu"
              title="Menu"
              aria-expanded={drawerOpen}
              onClick={() => setDrawerOpen((o) => !o)}
              className="btn btn-secondary btn-icon"
            >
              <Icon name="menu" size={18} />
            </button>
          )}
          <div
            style={{
              fontSize: "var(--text-lg)",
              fontWeight: "var(--weight-semibold)",
              color: "var(--ink)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {title}
          </div>
          {/* Env badge — reflects the active environment; hidden on phone (row space) and when the
              workspace has no environments. */}
          {!phone && activeEnvName && (
            <span
              className="mono"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: "var(--text-2xs)",
                fontWeight: "var(--weight-medium)",
                color: "var(--brand)",
                background: "var(--brand-soft)",
                border:
                  "1px solid color-mix(in srgb, var(--brand) 30%, transparent)",
                padding: "3px 9px",
                borderRadius: "var(--radius-sm)",
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: "var(--brand)",
                }}
              />
              {activeEnvName}
            </span>
          )}

          {/* Search — desktop (≥1080) only. */}
          {showSearch && (
            <div style={{ marginLeft: 18, width: 300 }}>
              <SearchInput
                placeholder="Search workflows…"
                value={search}
                onChange={setSearch}
                onSubmit={runSearch}
              />
            </div>
          )}

          <div
            style={{
              marginLeft: "auto",
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            <Button
              iconOnly
              icon={theme === "dark" ? "moon" : "sun"}
              onClick={toggleTheme}
              title="Toggle theme"
              aria-label="Toggle theme"
            />
            <NotificationsBell />
            {/* Icon-only on phone to keep the topbar to one row. aria-label keeps the icon-only
                variant named (title alone isn't a reliable accessible name). */}
            <Button
              variant="primary"
              icon="plus"
              iconOnly={phone}
              title="New workflow"
              aria-label="New workflow"
              onClick={() => navigate("/app/canvas")}
            >
              {phone ? undefined : "New workflow"}
            </Button>
          </div>
        </header>

        {/* content */}
        <main
          style={{
            flex: 1,
            overflowY: "auto",
            minHeight: 0,
            background: "var(--bg)",
          }}
        >
          {/* Key the routed screen by the active environment: switching envs remounts the current
              screen so it re-fetches under the new X-Environment-Id — a fast client-side remount
              instead of a full page reload. The shell (nav, providers) stays mounted. */}
          <Outlet key={activeEnv ?? "default"} />
        </main>
      </div>
    </div>
  );
}

function BrandTile() {
  return (
    <div
      style={{
        width: 30,
        height: 30,
        borderRadius: "var(--radius-sm)",
        flex: "none",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--brand-radial)",
        boxShadow: "var(--glow-brand)",
      }}
    >
      <Icon name="flame" size={17} style={{ color: "var(--brand-ink)" }} />
    </div>
  );
}

function GroupHeading({
  children,
  op,
}: {
  children: React.ReactNode;
  op: number;
}) {
  return (
    <div
      className="mono"
      style={{
        fontSize: "var(--text-2xs)",
        fontWeight: "var(--weight-semibold)",
        letterSpacing: "var(--tracking-label)",
        color: "var(--ink-3)",
        textTransform: "uppercase",
        padding: "12px 8px 6px",
        opacity: op,
      }}
    >
      {children}
    </div>
  );
}

function NavRow({
  item,
  collapsed,
  labelOp,
}: {
  item: NavItemDef;
  collapsed: boolean;
  labelOp: number;
}) {
  const base: React.CSSProperties = {
    width: "100%",
    display: "flex",
    alignItems: "center",
    // Center the icon in the collapsed rail; left-align icon+label when expanded.
    justifyContent: collapsed ? "center" : "flex-start",
    gap: collapsed ? 0 : 11,
    padding: "9px 9px",
    borderRadius: "var(--radius-md)",
    fontSize: "var(--text-body)",
    fontWeight: "var(--weight-medium)",
    textAlign: "left",
    cursor: "pointer",
    transition: "background .14s ease, color .14s ease",
  };
  const content = (_active: boolean) => (
    <>
      <Icon name={item.icon} size={17} />
      {/* Hidden (not just transparent) when collapsed so it doesn't offset the icon. */}
      {!collapsed && (
        <span style={{ opacity: labelOp, whiteSpace: "nowrap", flex: 1 }}>
          {item.label}
        </span>
      )}
      {item.badge && !collapsed && (
        <span
          className="mono"
          style={{
            fontSize: "var(--text-2xs)",
            fontWeight: "var(--weight-semibold)",
            color: "var(--brand)",
            background: "var(--brand-soft)",
            padding: "1px 7px",
            borderRadius: "var(--radius-pill)",
          }}
        >
          {item.badge}
        </span>
      )}
      {item.external && !collapsed && (
        <Icon name="external" size={12} style={{ opacity: labelOp }} />
      )}
    </>
  );

  return (
    <NavLink
      to={item.to}
      end={item.to === "/app"}
      title={collapsed ? item.label : undefined}
      style={({ isActive }) => ({
        ...base,
        background: isActive ? "var(--brand-soft)" : "transparent",
        color: isActive ? "var(--ink)" : "var(--ink-2)",
        boxShadow: isActive ? "inset 2px 0 0 var(--brand)" : undefined,
      })}
    >
      {({ isActive }) => content(isActive)}
    </NavLink>
  );
}
