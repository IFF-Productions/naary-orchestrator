import type { CSSProperties } from "react";

/**
 * A small indeterminate spinner (the `naarySpin` keyframe). Used inline for busy
 * buttons and section loaders. `color` is the moving arc; `track` the faint ring.
 * On a filled button pass a light color/track so it reads against the brand fill.
 */
export function Spinner({
  size = 16,
  color = "var(--brand)",
  track = "var(--line-2)",
  style,
}: {
  size?: number;
  color?: string;
  track?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      className="spinner"
      role="status"
      aria-label="Loading"
      style={{
        width: size,
        height: size,
        borderColor: track,
        borderTopColor: color,
        ...style,
      }}
    />
  );
}

/**
 * A centered spinner + optional label for a section that's still loading — the
 * standard replacement for bare "Loading…" text on a card/panel.
 */
export function LoadingBlock({
  label = "Loading…",
  style,
}: {
  label?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        padding: 24,
        color: "var(--ink-3)",
        fontSize: "var(--text-body)",
        ...style,
      }}
    >
      <Spinner size={16} />
      {label}
    </div>
  );
}
