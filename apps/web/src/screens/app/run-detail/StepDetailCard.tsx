/**
 * Selected-step detail card for the redesigned Run Detail screen: icon header
 * with the step's state badge, a DURATION / COST / TOKENS / REGION stat strip
 * (real values only — the platform records none of these per node today, so
 * they render "—" except the waiting step's real age), the step's real output
 * (from the run ctx), and the run's execution-log panel in the design's mono
 * log style.
 */
import type { RunEvent } from "../../../lib/api";
import { Icon, type IconName } from "../../../components";
import { NodeOutputBody } from "./NodeOutputBody";
import { LogPanel } from "./RunLog";
import { STEP_FG, STEP_WORD, type StepState } from "./run-view-model";

function MonoLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="mono"
      style={{
        fontSize: "var(--text-2xs)",
        letterSpacing: ".1em",
        textTransform: "uppercase",
        color: "var(--ink-faint)",
        marginBottom: 9,
      }}
    >
      {children}
    </div>
  );
}

export interface StepDetail {
  id: string;
  label: string;
  /** Mono type line, e.g. "agent · claude-sonnet-5" or the node type. */
  typeLine: string;
  icon: IconName;
  accent: string;
  state: StepState;
  /** Real elapsed for this step (the waiting step's age) or null → "—". */
  duration: string | null;
  /** The step's output from the run ctx (undefined = none yet). */
  output: unknown;
  /** True when `output` is the run's trigger payload (the entry node). */
  isTriggerInput: boolean;
}

export function StepDetailCard({
  step,
  events,
}: {
  step: StepDetail;
  events: RunEvent[] | null;
}) {
  const stats: { label: string; value: string; color?: string }[] = [
    {
      label: "DURATION",
      value: step.duration ?? "—",
      color: step.state === "waiting" ? "var(--state-paused)" : undefined,
    },
    { label: "COST", value: "—" },
    { label: "TOKENS", value: "—" },
    { label: "REGION", value: "—" },
  ];

  return (
    <div
      style={{
        border: "1px solid var(--line-mid)",
        background: "var(--panel)",
        borderRadius: 14,
        overflow: "hidden",
        animation: "naaryFadeUp .2s ease",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "15px 18px",
          borderBottom: "1px solid var(--line)",
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <span
          style={{
            width: 36,
            height: 36,
            flex: "none",
            borderRadius: 9,
            border: `1px solid ${step.accent}`,
            color: step.accent,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name={step.icon} size={17} />
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span
            style={{
              display: "block",
              fontSize: "var(--text-md)",
              fontWeight: "var(--weight-bold)",
              color: "var(--ink)",
            }}
          >
            {step.label}
          </span>
          <span
            className="mono"
            style={{
              display: "block",
              fontSize: "var(--text-xs)",
              color: "var(--ink-faint)",
              marginTop: 1,
            }}
          >
            {step.typeLine}
          </span>
        </span>
        <span
          className="mono"
          style={{
            fontSize: "var(--text-2xs)",
            fontWeight: "var(--weight-bold)",
            letterSpacing: ".05em",
            textTransform: "uppercase",
            color: STEP_FG[step.state],
            border: `1px solid color-mix(in srgb, ${STEP_FG[step.state]} 55%, transparent)`,
            background: `color-mix(in srgb, ${STEP_FG[step.state]} 12%, transparent)`,
            borderRadius: "var(--radius-pill)",
            padding: "3px 10px",
            flex: "none",
          }}
        >
          {STEP_WORD[step.state]}
        </span>
      </div>

      {/* Stat strip */}
      <div
        style={{
          display: "flex",
          borderBottom: "1px solid var(--line)",
        }}
      >
        {stats.map((s, i) => (
          <div
            key={s.label}
            style={{
              flex: 1,
              padding: "13px 18px",
              borderRight:
                i < stats.length - 1 ? "1px solid var(--line)" : "none",
              minWidth: 0,
            }}
          >
            <div
              className="mono"
              style={{
                fontSize: "var(--text-2xs)",
                color: "var(--ink-3)",
                letterSpacing: ".03em",
              }}
            >
              {s.label}
            </div>
            <div
              style={{
                fontSize: "var(--text-md)",
                fontWeight: "var(--weight-semibold)",
                color: s.color ?? "var(--ink-soft)",
                marginTop: 3,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {s.value}
            </div>
          </div>
        ))}
      </div>

      {/* Step output — the real per-node result from the run ctx. */}
      <div
        style={{ padding: "14px 18px", borderBottom: "1px solid var(--line)" }}
      >
        <MonoLabel>
          {step.isTriggerInput ? "Trigger input" : "Output"}
        </MonoLabel>
        {step.output === undefined ? (
          <div style={{ fontSize: "var(--text-sm)", color: "var(--ink-3)" }}>
            {step.state === "skipped"
              ? "This step did not run — its branch was not taken."
              : step.state === "pending"
                ? "No output yet — this step hasn't run."
                : step.state === "waiting"
                  ? "No output yet — the run resumes here once a decision arrives."
                  : "No output was recorded for this step."}
          </div>
        ) : (
          <NodeOutputBody output={step.output} />
        )}
      </div>

      {/* Run log — the curated Temporal history (the durable record). */}
      <div style={{ padding: "14px 18px" }}>
        <MonoLabel>Logs</MonoLabel>
        <LogPanel events={events} />
        <div
          className="mono"
          style={{
            marginTop: 8,
            fontSize: "var(--text-2xs)",
            color: "var(--ink-3)",
          }}
        >
          full run history · durable · state checkpointed · resumable for 30d
        </div>
      </div>
    </div>
  );
}
