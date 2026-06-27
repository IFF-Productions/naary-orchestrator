import { useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { Button, Icon, SearchInput } from "../components";
import type { IconName } from "../components";
import { PAGE_META } from "../lib/mock";
import { useTheme } from "../theme";

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
      { to: "/app/runs", label: "Runs", icon: "activity", badge: "7" },
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
    ],
  },
];

const FOOTER_ITEMS: NavItemDef[] = [
  { to: "/app/team", label: "Team", icon: "users" },
  { to: "/app/settings", label: "Settings", icon: "settings" },
];

export function AppShell() {
  const [collapsed, setCollapsed] = useState(false);
  const { theme, toggleTheme } = useTheme();
  const { pathname } = useLocation();
  const [title, sub] = PAGE_META[pathname] ?? ["Naary", ""];
  const labelOp = collapsed ? 0 : 1;

  return (
    <div
      style={{
        display: "flex",
        height: "100vh",
        overflow: "hidden",
        background: "var(--bg)",
      }}
    >
      {/* ===== SIDEBAR ===== */}
      <aside
        style={{
          width: collapsed ? 70 : 244,
          flex: "none",
          background: "var(--bg-2)",
          borderRight: "1px solid var(--line)",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          transition: "width .16s ease",
          overflow: "hidden",
        }}
      >
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
          <div
            style={{
              flex: 1,
              minWidth: 0,
              opacity: labelOp,
              transition: "opacity .12s",
            }}
          >
            <div
              style={{
                fontSize: 14,
                fontWeight: 700,
                color: "var(--ink)",
                lineHeight: 1.1,
              }}
            >
              Naary
            </div>
            <div style={{ fontSize: 10.5, color: "var(--ink-3)" }}>
              Northwind workspace
            </div>
          </div>
          <Icon
            name="chevron-up-down"
            size={14}
            style={{ color: "var(--ink-3)", opacity: labelOp }}
          />
        </div>

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
          {GROUPS.map((g) => (
            <div key={g.heading}>
              <GroupHeading op={labelOp}>{g.heading}</GroupHeading>
              {g.items.map((it) => (
                <NavRow
                  key={it.to}
                  item={it}
                  collapsed={collapsed}
                  labelOp={labelOp}
                />
              ))}
            </div>
          ))}
          <div style={{ flex: 1 }} />
          {FOOTER_ITEMS.map((it) => (
            <NavRow
              key={it.to}
              item={it}
              collapsed={collapsed}
              labelOp={labelOp}
            />
          ))}
        </nav>

        {/* user */}
        <div
          style={{
            flex: "none",
            borderTop: "1px solid var(--line)",
            padding: 10,
            display: "flex",
            // Collapsed: stack avatar + toggle vertically and center them so the
            // toggle fits the 70px rail instead of overflowing the row.
            flexDirection: collapsed ? "column" : "row",
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
              background: "linear-gradient(140deg,#3a4252,#252b36)",
              border: "1px solid var(--line-2)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 11,
              fontWeight: 600,
              color: "var(--ink-2)",
            }}
          >
            MA
          </span>
          {/* Label takes no space when collapsed (display none, not just opacity)
              so it can't squeeze the toggle out of the rail. */}
          <div
            style={{
              flex: 1,
              minWidth: 0,
              opacity: labelOp,
              display: collapsed ? "none" : "block",
            }}
          >
            <div
              style={{
                fontSize: 12,
                fontWeight: 500,
                color: "var(--ink)",
                whiteSpace: "nowrap",
              }}
            >
              M. Alvarez
            </div>
            <div style={{ fontSize: 10, color: "var(--ink-3)" }}>Owner</div>
          </div>
          <button
            title={collapsed ? "Expand" : "Collapse"}
            onClick={() => setCollapsed((c) => !c)}
            className="btn btn-secondary btn-icon btn-sm"
          >
            <Icon
              name={collapsed ? "sidebar-expand" : "sidebar-collapse"}
              size={14}
            />
          </button>
        </div>
      </aside>

      {/* ===== MAIN ===== */}
      <div
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
          <div style={{ fontSize: 16, fontWeight: 600, color: "var(--ink)" }}>
            {title}
          </div>
          <span
            className="mono"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 10.5,
              fontWeight: 500,
              color: "var(--brand)",
              background: "var(--brand-soft)",
              border:
                "1px solid color-mix(in srgb, var(--brand) 30%, transparent)",
              padding: "3px 9px",
              borderRadius: 6,
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
            Production
          </span>

          <div style={{ marginLeft: 18, width: 300 }}>
            <SearchInput placeholder="Search workflows, runs…" />
          </div>

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
            />
            <button
              className="btn btn-secondary btn-icon"
              style={{ position: "relative" }}
            >
              <Icon name="bell" size={16} />
              <span
                style={{
                  position: "absolute",
                  top: 6,
                  right: 7,
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: "var(--brand)",
                  border: "1.5px solid var(--bg-2)",
                }}
              />
            </button>
            <Button variant="primary" icon="plus">
              New workflow
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
          <Outlet />
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
        borderRadius: 8,
        flex: "none",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--brand-radial)",
        boxShadow: "0 0 16px -2px rgba(242,98,46,.6)",
      }}
    >
      <Icon name="flame" size={17} style={{ color: "#fff3ec" }} />
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
        fontSize: 9.5,
        fontWeight: 600,
        letterSpacing: "0.13em",
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
    gap: 11,
    padding: "9px 9px",
    borderRadius: 9,
    fontSize: 13,
    fontWeight: 500,
    textAlign: "left",
    cursor: "pointer",
  };
  const content = (active: boolean) => (
    <>
      <Icon name={item.icon} size={17} />
      <span style={{ opacity: labelOp, whiteSpace: "nowrap", flex: 1 }}>
        {item.label}
      </span>
      {item.badge && !collapsed && (
        <span
          className="mono"
          style={{
            fontSize: 10,
            fontWeight: 600,
            color: "var(--brand)",
            background: "var(--brand-soft)",
            padding: "1px 7px",
            borderRadius: 20,
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
