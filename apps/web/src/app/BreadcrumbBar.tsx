/**
 * Breadcrumb bar (redesign shell) — `Hub › Mode › Screen`, sticky at the top of the
 * content region, with the active environment echoed inline on the right so a prod
 * surface never reads like a sandbox test. Labels derive from the nav model.
 */
import { Link, useLocation } from "react-router-dom";
import { Icon } from "../components";
import type { NavMode } from "./nav-model";
import { findCrumb } from "./nav-model";

function Chevron() {
  return (
    <Icon
      name="chevron-right"
      size={12}
      style={{ color: "var(--ink-3)", flex: "none" }}
    />
  );
}

export function BreadcrumbBar({
  modes,
  envName,
  envAccent,
}: {
  modes: NavMode[];
  envName?: string;
  envAccent?: string;
}) {
  const { pathname } = useLocation();
  const crumb = findCrumb(pathname, modes);

  return (
    <nav
      aria-label="Breadcrumb"
      style={{
        height: 44,
        position: "sticky",
        top: 0,
        zIndex: 8,
        borderBottom: "1px solid var(--line)",
        background: "var(--panel)",
        display: "flex",
        alignItems: "center",
        gap: 9,
        padding: "0 16px",
      }}
    >
      <Link
        to="/app"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          fontSize: 12,
          color: "var(--ink-2)",
          textDecoration: "none",
          padding: "5px 9px",
          borderRadius: 7,
          transition: "background .12s, color .12s",
        }}
      >
        <Icon name="grid" size={13} style={{ flex: "none" }} />
        Hub
      </Link>
      {crumb && (
        <>
          <Chevron />
          <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
            {crumb.mode.label}
          </span>
          <Chevron />
          <span
            style={{
              fontSize: 12.5,
              fontWeight: "var(--weight-semibold)",
              color: "var(--ink)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {crumb.item.label}
          </span>
        </>
      )}

      {/* Inline env echo — every screen restates the scope it's showing. */}
      {envName && (
        <span
          className="mono"
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: "var(--text-2xs)",
            fontWeight: "var(--weight-semibold)",
            color: envAccent ?? "var(--brand)",
            border: `1px solid color-mix(in srgb, ${envAccent ?? "var(--brand)"} 35%, transparent)`,
            background: `color-mix(in srgb, ${envAccent ?? "var(--brand)"} 10%, transparent)`,
            padding: "3px 9px",
            borderRadius: "var(--radius-pill)",
            whiteSpace: "nowrap",
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: envAccent ?? "var(--brand)",
              boxShadow: `0 0 8px ${envAccent ?? "var(--brand)"}`,
              flex: "none",
            }}
          />
          {envName}
        </span>
      )}
    </nav>
  );
}
