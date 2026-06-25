import type { CSSProperties, ReactNode } from "react";
import { Icon, type IconName } from "./Icon";
import { Button } from "./forms";

/* ---------------- EmptyState ---------------- */
export function EmptyState({
  icon = "info",
  title,
  body,
  action,
}: {
  icon?: IconName;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="badge">
        <Icon name={icon} size={22} />
      </span>
      <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)" }}>
        {title}
      </div>
      {body && (
        <div style={{ fontSize: 12.5, marginTop: 6, maxWidth: 360 }}>
          {body}
        </div>
      )}
      {action && <div style={{ marginTop: 16 }}>{action}</div>}
    </div>
  );
}

/* ---------------- Skeleton ---------------- */
export function Skeleton({
  width = "100%",
  height = 14,
  radius,
  style,
}: {
  width?: number | string;
  height?: number | string;
  radius?: number;
  style?: CSSProperties;
}) {
  return (
    <div
      className="skeleton"
      style={{ width, height, borderRadius: radius, ...style }}
    />
  );
}

/* ---------------- Tooltip ---------------- */
export function Tooltip({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <span className="tooltip-wrap">
      {children}
      <span className="tooltip">{label}</span>
    </span>
  );
}

/* ---------------- Dialog ---------------- */
export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "16px 18px",
            borderBottom: "1px solid var(--line)",
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 600 }}>{title}</div>
          <button className="btn btn-ghost btn-icon btn-sm" onClick={onClose}>
            <Icon name="x" size={15} />
          </button>
        </div>
        <div style={{ padding: 18 }}>{children}</div>
        {footer && (
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: 9,
              padding: "14px 18px",
              borderTop: "1px solid var(--line)",
            }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------- Drawer ---------------- */
export function Drawer({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="overlay" onClick={onClose}>
      <div
        className="drawer"
        onClick={(e) => e.stopPropagation()}
        style={{ display: "flex", flexDirection: "column" }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "16px 18px",
            borderBottom: "1px solid var(--line)",
            flex: "none",
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 600 }}>{title}</div>
          <button className="btn btn-ghost btn-icon btn-sm" onClick={onClose}>
            <Icon name="x" size={15} />
          </button>
        </div>
        <div style={{ padding: 18, overflowY: "auto", flex: 1 }}>
          {children}
        </div>
        {footer && (
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: 9,
              padding: "14px 18px",
              borderTop: "1px solid var(--line)",
              flex: "none",
            }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------- Toast ---------------- */
export function Toast({
  kind = "info",
  children,
  onDismiss,
}: {
  kind?: "info" | "done" | "error";
  children: ReactNode;
  onDismiss?: () => void;
}) {
  const color =
    kind === "done"
      ? "var(--state-done)"
      : kind === "error"
        ? "var(--state-error)"
        : "var(--state-info)";
  return (
    <div className="toast">
      <Icon
        name={
          kind === "done" ? "check-circle" : kind === "error" ? "alert" : "info"
        }
        size={16}
        style={{ color }}
      />
      <span style={{ flex: 1 }}>{children}</span>
      {onDismiss && (
        <button className="btn btn-ghost btn-icon btn-sm" onClick={onDismiss}>
          <Icon name="x" size={14} />
        </button>
      )}
    </div>
  );
}

/* Re-export Button for convenience in feedback compositions. */
export { Button };
