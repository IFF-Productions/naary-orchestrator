import type { CSSProperties, ReactNode } from "react";
import { Icon } from "./Icon";

/* ---------------- StatusPill ---------------- */
export type RunState =
  "idle" | "running" | "paused" | "done" | "error" | "info";

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
  truncate,
}: {
  state: RunState;
  label?: string;
  /**
   * Let the label ellipsize instead of setting the pill's width (#997).
   *
   * A pill is `white-space: nowrap` by default and therefore CANNOT shrink, which is fine for the
   * fixed vocabulary above but not for a caller that puts an arbitrary message in `label` — the
   * canvas top bar renders the compiler's `graphError` here, and 31 characters of it pushed the
   * bar's primary CTA off a 1440px screen. Opt-in, because everywhere else the pill IS its label
   * and truncating it would lose the whole word ("Failed" -> "Fa…").
   *
   * Truncation is CSS-only: the full string stays in the DOM, so the accessibility tree is
   * unaffected and nothing needs an off-screen twin. The caller owns the width — this only makes
   * the pill capable of taking one (`min-width: 0`, so it can shrink inside a flex parent).
   */
  truncate?: boolean;
}) {
  const text = label ?? PILL_LABEL[state];
  return (
    <span
      className={`pill pill-${state}`}
      style={truncate ? { minWidth: 0 } : undefined}
    >
      {state === "done" ? (
        <Icon name="check" size={10} strokeWidth={3} />
      ) : state === "error" ? (
        <Icon name="x" size={10} strokeWidth={2.6} />
      ) : (
        <span className={`pill-dot${state === "running" ? " live" : ""}`} />
      )}
      {truncate ? (
        <span
          style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}
        >
          {text}
        </span>
      ) : (
        text
      )}
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
    // Scroll a wide table horizontally on narrow screens instead of overflowing the layout.
    <div style={{ overflowX: "auto", maxWidth: "100%" }}>
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
    </div>
  );
}
