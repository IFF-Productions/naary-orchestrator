import type { CSSProperties, ReactNode } from "react";
import { Icon } from "./Icon";

/* ---------------- StatusPill ---------------- */
export type RunState =
  | "idle"
  | "running"
  | "paused"
  | "done"
  | "error"
  | "info";

const PILL_LABEL: Record<RunState, string> = {
  idle: "Idle",
  running: "Running",
  paused: "Paused",
  done: "Done",
  error: "Failed",
  info: "Info",
};

export function StatusPill({
  state,
  label,
}: {
  state: RunState;
  label?: string;
}) {
  return (
    <span className={`pill pill-${state}`}>
      {state === "done" ? (
        <Icon name="check" size={10} strokeWidth={3} />
      ) : state === "error" ? (
        <Icon name="x" size={10} strokeWidth={2.6} />
      ) : (
        <span className={`pill-dot${state === "running" ? " live" : ""}`} />
      )}
      {label ?? PILL_LABEL[state]}
    </span>
  );
}

/* ---------------- Avatar ---------------- */
export function Avatar({
  initials,
  size = 30,
  src,
}: {
  initials?: string;
  size?: number;
  src?: string;
}) {
  return (
    <span
      className="avatar"
      style={{ width: size, height: size, fontSize: size * 0.37 }}
    >
      {src ? (
        <img src={src} alt="" style={{ width: "100%", height: "100%" }} />
      ) : (
        initials
      )}
    </span>
  );
}

/* ---------------- Tag ---------------- */
export function Tag({
  children,
  color,
  style,
}: {
  children: ReactNode;
  color?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      className="tag"
      style={
        color
          ? {
              color,
              borderColor: `color-mix(in srgb, ${color} 32%, transparent)`,
              background: `color-mix(in srgb, ${color} 10%, transparent)`,
              ...style,
            }
          : style
      }
    >
      {children}
    </span>
  );
}

/* ---------------- ProgressBar ---------------- */
export function ProgressBar({
  value,
  color = "var(--brand)",
}: {
  value: number;
  color?: string;
}) {
  return (
    <div className="progress">
      <div
        className="fill"
        style={{
          width: `${Math.max(0, Math.min(100, value))}%`,
          background: color,
        }}
      />
    </div>
  );
}

/* ---------------- StatCard ---------------- */
export function StatCard({
  label,
  value,
  delta,
  deltaDir,
}: {
  label: string;
  value: ReactNode;
  delta?: string;
  deltaDir?: "up" | "down";
}) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {delta && (
        <div
          className={`delta ${deltaDir === "down" ? "delta-down" : "delta-up"}`}
        >
          {deltaDir === "down" ? "▼" : "▲"} {delta}
        </div>
      )}
    </div>
  );
}

/* ---------------- CodeBlock ---------------- */
export function CodeBlock({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <pre className="code" style={style}>
      {children}
    </pre>
  );
}

/* ---------------- Table ---------------- */
export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  width?: string | number;
}

export function Table<T>({
  columns,
  rows,
  onRowClick,
  rowKey,
}: {
  columns: Column<T>[];
  rows: T[];
  onRowClick?: (row: T) => void;
  rowKey: (row: T) => string;
}) {
  return (
    <table className="tbl">
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c.key} style={{ width: c.width }}>
              {c.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr
            key={rowKey(row)}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
            style={{ cursor: onRowClick ? "pointer" : "default" }}
          >
            {columns.map((c) => (
              <td key={c.key}>{c.render(row)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
