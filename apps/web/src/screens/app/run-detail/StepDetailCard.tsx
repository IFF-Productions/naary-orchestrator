/**
 * Selected-step detail card for the redesigned Run Detail screen: icon header
 * with the step's state badge, a DURATION / COST / TOKENS / REGION stat strip
 * (real values only — worker-stamped per-node duration, the node output's own
 * metered cost/tokens (Slice 2); anything unrecorded — pre-feature runs, REGION —
 * renders "—"), and the step's own result — its output from the run ctx, or, for the
 * node the run FAILED on, that node's error (#525). The full durable run log is a
 * SEPARATE run-level panel (RunDetail's "Execution log"), not repeated per step.
 */
import { Icon, type IconName } from "../../../components";
import { NodeOutputBody } from "./NodeOutputBody";
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
  /** Real elapsed for this step (worker-stamped, or the waiting step's age); null → "—". */
  duration: string | null;
  /** Real metered cost of this step (from its output's costUsd); null → "—". */
  cost?: string | null;
  /** Real token count of this step (from its output's totalTokens); null → "—". */
  tokens?: string | null;
  /** The step's output from the run ctx (undefined = none yet). */
  output: unknown;
  /** True when `output` is the run's trigger payload (the entry node). */
  isTriggerInput: boolean;
  /** The failure message when the run died on THIS node (#525); null otherwise. */
  error?: string | null;
}

/** `runId` is optional so a caller without one (stories/fixtures) still renders; it's only used
 *  to build the authenticated audio URL for a textToSpeech step (#689). */
export function StepDetailCard({
  step,
  runId,
}: {
  step: StepDetail;
  runId?: string;
}) {
  const stats: { label: string; value: string; color?: string }[] = [
    {
      label: "DURATION",
      value: step.duration ?? "—",
      color: step.state === "waiting" ? "var(--state-paused)" : undefined,
    },
    { label: "COST", value: step.cost ?? "—" },
    { label: "TOKENS", value: step.tokens ?? "—" },
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

      {/* Error — shown FIRST for the node the run failed on (#525): the failure happened
          here, so this is the step's own error, not a generic run message. */}
      {step.state === "error" && step.error && (
        <div
          style={{
            padding: "14px 18px",
            borderBottom: "1px solid var(--line)",
          }}
        >
          <MonoLabel>Error</MonoLabel>
          <div
            className="mono"
            style={{
              fontSize: "var(--text-sm)",
              color: "var(--state-error)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              lineHeight: 1.5,
            }}
          >
            {step.error}
          </div>
        </div>
      )}

      {/* Step output — the real per-node result from the run ctx. */}
      <div style={{ padding: "14px 18px" }}>
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
                  : step.state === "error"
                    ? "This step failed before producing an output — see the error above and the run's Execution log."
                    : "No output was recorded for this step."}
          </div>
        ) : (
          <NodeOutputBody
            output={step.output}
            runId={runId}
            // The trigger-input pseudo-step's id isn't a graph node, so don't claim it is one.
            nodeId={step.isTriggerInput ? undefined : step.id}
          />
        )}
      </div>
    </div>
  );
}
