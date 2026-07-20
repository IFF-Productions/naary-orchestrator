/**
 * Canvas edge (redesign: Canvas Authoring Loop): a bezier anchored to the port
 * centers with a state-driven stroke —
 *  - active (upstream done → target running): ember dashed march (naaryDash)
 *  - done (both ends have test output): calm green
 *  - skipped/untaken branch: dimmed short dashes
 *  - idle: hairline
 * Branch edges (a condition) carry a small mono label chip at the midpoint.
 */
import {
  BaseEdge,
  EdgeLabelRenderer,
  type EdgeProps,
  getBezierPath,
} from "@xyflow/react";
import type { FlowEdge } from "./flow";

export type EdgeRunState = "idle" | "active" | "done" | "skipped";

const STROKE: Record<
  EdgeRunState,
  { color: string; dash?: string; anim?: boolean; dim?: boolean }
> = {
  idle: { color: "color-mix(in srgb, var(--ink-3) 55%, transparent)" },
  // Dash period sums to 10 so tokens.css's naaryDash (-20 offset) loops seamlessly.
  active: { color: "var(--brand)", dash: "6 4", anim: true },
  done: { color: "color-mix(in srgb, var(--state-done) 62%, transparent)" },
  skipped: {
    color: "color-mix(in srgb, var(--ink-3) 35%, transparent)",
    dash: "3 7",
    dim: true,
  },
};

export function NaaryEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
  label,
  data,
}: EdgeProps<FlowEdge>) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const state = (data?.runState as EdgeRunState | undefined) ?? "idle";
  const s = STROKE[state];
  const chipColor =
    state === "done"
      ? "var(--state-done)"
      : state === "active"
        ? "var(--brand-2)"
        : state === "skipped"
          ? "var(--ink-3)"
          : "var(--ink-faint)";
  const chipBorder =
    state === "done"
      ? "color-mix(in srgb, var(--state-done) 50%, transparent)"
      : state === "active"
        ? "color-mix(in srgb, var(--brand) 50%, transparent)"
        : "var(--line-2)";

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        // Wide invisible hit path (design: stroke-width 18, pointer-events: stroke)
        // so clicking a line reliably opens the Connection inspector.
        interactionWidth={18}
        style={{
          stroke: selected ? "var(--brand)" : s.color,
          strokeWidth: selected ? 2.6 : 2,
          strokeLinecap: "round",
          strokeDasharray: s.dash,
          animation: s.anim ? "naaryDash 1s linear infinite" : undefined,
          opacity: s.dim && !selected ? 0.8 : 1,
          transition: "stroke .25s ease",
        }}
      />
      {label != null && label !== "" && (
        <EdgeLabelRenderer>
          <div
            className="mono nodrag nopan"
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              fontSize: 10.5,
              fontFamily: "var(--font-mono)",
              color: chipColor,
              background: "var(--bg)",
              border: `1px solid ${selected ? "var(--brand)" : chipBorder}`,
              borderRadius: 6,
              padding: "2px 8px",
              pointerEvents: "none",
              opacity: state === "skipped" ? 0.65 : 1,
              whiteSpace: "nowrap",
              maxWidth: 190,
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const edgeTypes = { naary: NaaryEdge };
