/**
 * Step timeline for the redesigned Run Detail screen — one row per node in
 * execution order: glowing state dot · type icon tile · name · state bar
 * (green for done, ember for running, amber marching stripes for waiting, thin
 * dashed for pending/skipped) · duration + cost mono columns. Data honesty:
 * the platform records no per-node duration or cost, so those columns render
 * real values only where they exist (the waiting node's age) and "—" elsewhere;
 * done bars are uniform state bars, not fabricated proportions.
 */
import { Icon, type IconName } from "../../../components";
import { STEP_FG, type StepState } from "./run-view-model";

export interface TimelineStep {
  id: string;
  label: string;
  icon: IconName;
  accent: string;
  state: StepState;
  /** Real elapsed text (e.g. the waiting node's age); null → "—". */
  duration: string | null;
  /** Real per-step cost; null → "—" (the ledger records run totals only). */
  cost: string | null;
}

function barStyle(state: StepState): React.CSSProperties {
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
        width: "100%",
        borderRadius: 6,
        background:
          "linear-gradient(90deg, var(--state-done), color-mix(in srgb, var(--state-done) 55%, white))",
        opacity: 0.9,
      };
    case "error":
      return {
        height: 10,
        width: "100%",
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
    <div>
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
        {steps.map((p) => {
          const sel = p.id === selectedId;
          const dot = STEP_FG[p.state];
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
                <span style={barStyle(p.state)} />
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
        })}
      </div>
    </div>
  );
}
