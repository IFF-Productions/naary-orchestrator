/**
 * Five-mode nav rail (redesign shell, "Naary Shell.dc.html") — Build / Operate / Observe /
 * Connect / Admin, each mode color-coded with an uppercase mono header. 236px expanded;
 * icon-only 70px rail on manual desktop collapse; full-width labels inside the slide-out
 * drawer (<= 1024). Items carry live badges (approvals waiting) and a chevron.
 */
import { NavLink } from "react-router-dom";
import { Icon } from "../components";
import type { NavItem, NavMode } from "./nav-model";

function Badge({ value, color }: { value: number; color: string }) {
  return (
    <span
      className="mono"
      style={{
        fontSize: "var(--text-2xs)",
        fontWeight: "var(--weight-bold)",
        color,
        background: "var(--card-2)",
        borderRadius: "var(--radius-pill)",
        padding: "1px 7px",
        flex: "none",
      }}
    >
      {value > 99 ? "99+" : value}
    </span>
  );
}

function NavRow({
  item,
  mode,
  rail,
  touch,
  approvalsCount,
}: {
  item: NavItem;
  mode: NavMode;
  rail: boolean;
  /** Drawer/touch presentation — rows get a >= 44px hit height. */
  touch: boolean;
  approvalsCount: number;
}) {
  const badge =
    item.badgeKey === "approvals" && approvalsCount > 0 ? approvalsCount : null;
  return (
    <NavLink
      to={item.to}
      end={item.to === "/app"}
      title={rail ? item.label : undefined}
      style={({ isActive }) => ({
        display: "flex",
        alignItems: "center",
        justifyContent: rail ? "center" : "flex-start",
        gap: rail ? 0 : 8,
        minHeight: touch ? 44 : undefined,
        padding: rail ? "9px 0" : touch ? "10px 11px" : "8px 9px",
        borderRadius: "var(--radius-md)",
        fontSize: 12.5,
        marginBottom: 1,
        cursor: "pointer",
        color: isActive ? "var(--ink)" : "var(--ink-2)",
        background: isActive ? "var(--hover)" : "transparent",
        fontWeight: isActive
          ? "var(--weight-semibold)"
          : "var(--weight-regular)",
        transition: "background .12s, color .12s",
      })}
    >
      <Icon name={item.icon} size={15} style={{ flex: "none" }} />
      {!rail && (
        <>
          <span
            style={{
              flex: 1,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {item.label}
          </span>
          {badge !== null && <Badge value={badge} color={mode.color} />}
          {item.external ? (
            <Icon
              name="external"
              size={12}
              style={{ color: "var(--ink-3)", flex: "none", opacity: 0.7 }}
            />
          ) : (
            <Icon
              name="chevron-right"
              size={12}
              style={{ color: "var(--ink-3)", flex: "none", opacity: 0.7 }}
            />
          )}
        </>
      )}
    </NavLink>
  );
}

export function NavRail({
  modes,
  approvalsCount,
  rail,
  touch = false,
  onCollapseToggle,
  collapsed,
  showCollapseToggle,
}: {
  modes: NavMode[];
  approvalsCount: number;
  /** Icon-only presentation (desktop manual collapse). */
  rail: boolean;
  /** Drawer/touch presentation (<= 1024) — rows get a >= 44px hit height. */
  touch?: boolean;
  collapsed: boolean;
  showCollapseToggle: boolean;
  onCollapseToggle: () => void;
}) {
  return (
    <nav
      aria-label="Primary"
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: "auto",
        overflowX: "hidden",
        padding: rail ? "14px 8px" : "14px 12px",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {modes.map((m) => (
        <div key={m.id} style={{ marginBottom: 14 }}>
          {/* Mode header: colored glyph + uppercase mono label. Rail: centered glyph only. */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: rail ? "center" : "flex-start",
              gap: 9,
              padding: rail ? "4px 0 8px" : "4px 8px 8px",
            }}
            title={rail ? m.label : undefined}
          >
            <span
              style={{
                width: 20,
                height: 20,
                flex: "none",
                borderRadius: 6,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: m.color,
              }}
            >
              <Icon name={m.icon} size={15} />
            </span>
            {!rail && (
              <span
                className="mono"
                style={{
                  fontSize: 10.5,
                  letterSpacing: "var(--tracking-label)",
                  textTransform: "uppercase",
                  color: "var(--ink-faint)",
                  fontWeight: "var(--weight-semibold)",
                }}
              >
                {m.label}
              </span>
            )}
          </div>
          {m.items.map((it) => (
            <NavRow
              key={it.to}
              item={it}
              mode={m}
              rail={rail}
              touch={touch}
              approvalsCount={approvalsCount}
            />
          ))}
        </div>
      ))}

      <div style={{ flex: 1 }} />
      {/* Manual collapse — DESKTOP only (tablet's rail is automatic; phone uses a drawer). */}
      {showCollapseToggle && (
        <div
          style={{
            display: "flex",
            justifyContent: rail ? "center" : "flex-end",
            paddingTop: 8,
          }}
        >
          <button
            title={collapsed ? "Expand" : "Collapse"}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={onCollapseToggle}
            className="btn btn-secondary btn-icon btn-sm"
          >
            <Icon
              name={collapsed ? "sidebar-expand" : "sidebar-collapse"}
              size={14}
            />
          </button>
        </div>
      )}
    </nav>
  );
}
