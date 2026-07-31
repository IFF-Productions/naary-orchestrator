/**
 * Step timeline for the redesigned Run Detail screen — one row per node in
 * execution order: glowing state dot · type icon tile · name · state bar
 * (green for done, ember for running, amber marching stripes for waiting, thin
 * dashed for pending/skipped) · duration + cost mono columns. Data honesty:
 * duration/cost render REAL recorded values only — worker-stamped per-node times
 * (Slice 2) and the node output's own metered cost; runs that predate the
 * recording keep "—", and done bars are proportional ONLY when real durations
 * exist (uniform state bars otherwise, never fabricated proportions).
 */
import { Icon, type IconName } from "../../../components";
import { STEP_FG, type StepState } from "./run-view-model";

export interface TimelineStep {
  id: string;
  label: string;
  icon: IconName;
  accent: string;
  state: StepState;
  /** Real elapsed text (worker-stamped duration, or the waiting node's age); null → "—". */
  duration: string | null;
  /** Real recorded duration in ms (drives the proportional done bar); null → uniform bar. */
  durationMs?: number | null;
  /** Real per-step cost (the node output's metered costUsd); null → "—". */
  cost: string | null;
}

function barStyle(
  state: StepState,
  /** 0..1 share of the longest recorded step duration; null → uniform width. */
  share: number | null,
): React.CSSProperties {
  switch (state) {
    case "waiting":
      return {
        height: 12,
        width: "100%",
        borderRadius: 6,
        background:
          "repeating-linear-gradient(90deg, var(--state-paused) 0 10px, var(--paused-soft) 10px 20px)",
        backgroundSize: "34px 100%",
        animation: "rdStripe 1s linear infinite",
        opacity: 0.85,
      };
    case "running":
      return {
        height: 12,
        width: "60%",
        borderRadius: 6,
        background: "linear-gradient(90deg, var(--brand), var(--brand-2))",
      };
    case "done":
      return {
        height: 10,
        // Proportional to the real recorded duration when one exists (8% floor keeps
        // sub-ms pure steps visible); uniform when the run predates per-node timing.
        width: share === null ? "100%" : `${Math.max(8, share * 100)}%`,
        borderRadius: 6,
        background:
          "linear-gradient(90deg, var(--state-done), color-mix(in srgb, var(--state-done) 55%, white))",
        opacity: 0.9,
      };
    case "error":
      return {
        height: 10,
        width: share === null ? "100%" : `${Math.max(8, share * 100)}%`,
        borderRadius: 6,
        background: "var(--state-error)",
        opacity: 0.85,
      };
    case "pending":
      return {
        height: 2,
        width: "100%",
        borderRadius: 2,
        background:
          "repeating-linear-gradient(90deg, var(--line-2) 0 5px, transparent 5px 10px)",
        opacity: 0.6,
      };
    default: // skipped
      return {
        height: 2,
        width: "100%",
        borderRadius: 2,
        background:
          "repeating-linear-gradient(90deg, var(--ink-3) 0 5px, transparent 5px 10px)",
        opacity: 0.45,
      };
  }
}

export function StepTimeline({
  steps,
  selectedId,
  onSelect,
}: {
  steps: TimelineStep[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    // Named group: the Execution log below now also holds a button per step, so "Start …" appears
    // twice on this screen with different jobs. Which list you are in is the thing that tells them
    // apart, and without a name on each that distinction exists only visually.
    <div role="group" aria-label="Step timeline">
      <div
        className="mono"
        style={{
          fontSize: "var(--text-xs)",
          letterSpacing: ".1em",
          textTransform: "uppercase",
          color: "var(--ink-faint)",
          marginBottom: 12,
        }}
      >
        Step timeline
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        {(() => {
          // Longest REAL recorded duration → the proportional-bar denominator.
          // No recorded durations at all (pre-feature run) → null → uniform bars.
          const maxMs = steps.reduce(
            (m, s) =>
              typeof s.durationMs === "number" && s.durationMs > m
                ? s.durationMs
                : m,
            0,
          );
          return steps.map((p) => {
            const sel = p.id === selectedId;
            const dot = STEP_FG[p.state];
            const share =
              maxMs > 0 && typeof p.durationMs === "number"
                ? p.durationMs / maxMs
                : null;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => onSelect(p.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 11,
                  padding: "8px 11px",
                  borderRadius: "var(--radius-md)",
                  cursor: "pointer",
                  border: `1px solid ${sel ? "var(--brand)" : "transparent"}`,
                  background: sel ? "var(--brand-soft)" : "transparent",
                  transition: "background .15s, border-color .15s",
                  font: "inherit",
                  color: "inherit",
                  textAlign: "left",
                  width: "100%",
                }}
                onMouseEnter={(e) => {
                  if (!sel) e.currentTarget.style.background = "var(--hover)";
                }}
                onMouseLeave={(e) => {
                  if (!sel) e.currentTarget.style.background = "transparent";
                }}
              >
                <span
                  style={{
                    width: 9,
                    height: 9,
                    borderRadius: "50%",
                    flex: "none",
                    background: dot,
                    boxShadow:
                      p.state === "pending" || p.state === "skipped"
                        ? "none"
                        : `0 0 7px ${dot}`,
                    opacity:
                      p.state === "pending" || p.state === "skipped" ? 0.55 : 1,
                  }}
                />
                <span
                  style={{
                    width: 26,
                    height: 26,
                    flex: "none",
                    borderRadius: 7,
                    border: `1px solid ${p.accent}`,
                    color: p.accent,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    opacity: p.state === "skipped" ? 0.55 : 1,
                  }}
                >
                  <Icon name={p.icon} size={13} />
                </span>
                <span
                  style={{
                    fontSize: 12.5,
                    fontWeight: "var(--weight-medium)",
                    color: "var(--ink)",
                    width: 132,
                    flex: "none",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    opacity: p.state === "skipped" ? 0.6 : 1,
                  }}
                >
                  {p.label}
                </span>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    height: 16,
                    display: "flex",
                    alignItems: "center",
                  }}
                >
                  <span style={barStyle(p.state, share)} />
                </span>
                <span
                  className="mono"
                  style={{
                    fontSize: "var(--text-xs)",
                    color:
                      p.state === "waiting"
                        ? "var(--state-paused)"
                        : "var(--ink-3)",
                    width: 64,
                    textAlign: "right",
                    flex: "none",
                  }}
                >
                  {p.duration ?? (p.state === "running" ? "…" : "—")}
                </span>
                <span
                  className="mono"
                  style={{
                    fontSize: "var(--text-xs)",
                    color: "var(--ink-3)",
                    width: 66,
                    textAlign: "right",
                    flex: "none",
                  }}
                >
                  {p.cost ?? "—"}
                </span>
              </button>
            );
          });
        })()}
      </div>
    </div>
  );
}
