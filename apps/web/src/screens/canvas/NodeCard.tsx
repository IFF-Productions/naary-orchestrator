/**
 * Presentational canvas node card (redesign: Canvas Authoring Loop). Pure — no
 * react-flow context — so NaaryNode (flow.tsx) can wrap it with Handles and the
 * Storybook stories can render it standalone.
 *
 * Card colour = run state · icon colour = node type (the design's legend):
 *  - 14px radius, type-accent icon tile, state-driven border/background
 *  - running = ember glow-pulse · waiting = amber pulse + ping ring · done = green
 *  - skipped = dashed + dimmed · stale / no-input = dashed banners
 *  - meta line (measured duration) + cost-cap chip only when REAL data exists
 */
import type { CSSProperties } from "react";
import type { NodeType } from "@naary/dsl";
import { Icon, type IconName } from "../../components/Icon";
import { ACCENT } from "../../lib/graph-model";

/** Display run-state of a node on the authoring canvas. The app drives the subset it
 *  can honestly know (idle/running/done/error/stale/no-input); the rest exist for
 *  run-view parity + stories. */
export type NodeRunState =
  | "idle"
  | "queued"
  | "running"
  | "waiting"
  | "done"
  | "error"
  | "skipped"
  | "stale"
  | "no-input";

/** kind → icon glyph (type identity; the design's icon-per-category). */
export function nodeIconFor(kind: NodeType): IconName {
  switch (kind) {
    case "start":
    case "webhookTrigger":
    case "scheduleTrigger":
    case "pollTrigger":
    case "errorTrigger":
    case "formTrigger":
    case "chatTrigger":
      return "bolt";
    case "agent":
    case "codeAgent":
    case "vectorUpsert":
    case "vectorQuery":
      return "agent";
    // Waveform glyph — the closest honest mark for synthesized audio.
    case "textToSpeech":
      return "activity";
    case "mcpTool":
    case "integration":
      return "mcp";
    case "if":
    case "switch":
    case "merge":
    case "splitOut":
    case "loopEnd":
    case "retry":
    case "retryEnd":
    case "forEach":
    case "executeSubWorkflow":
      return "router";
    case "humanApproval":
      return "approval";
    case "httpRequest":
    case "graphQL":
    case "rssRead":
      return "http";
    case "sqlQuery":
    case "sqlExec":
      return "chart";
    case "wait":
      return "clock";
    case "hmac":
    case "jwt":
    case "totp":
    case "hash":
    case "random":
      return "key";
    case "sendEmail":
    case "respondToWebhook":
      return "arrow-right";
    case "code":
      return "edit";
    case "stopAndError":
      return "alert";
    case "filter":
      return "filter";
    case "end":
      return "end";
    case "set":
    case "renameKeys":
    case "text":
    case "aggregate":
    case "listOps":
    case "compareDatasets":
    case "xml":
    case "htmlExtract":
    case "markdown":
    case "csv":
    case "json":
    case "number":
    case "encode":
    case "dateTime":
      return "refresh";
    default:
      return "workflow";
  }
}

/** State → border / background / state-word colour (all theme tokens, so dark + light
 *  both work). Mirrors the design's idle/q/run/wait/done/skip/stale/dis palette. */
const STATE_STYLE: Record<
  NodeRunState,
  { bd: string; bg: string; fg: string; dashed?: boolean; dim?: boolean }
> = {
  idle: {
    bd: "var(--line-2)",
    bg: "var(--card)",
    fg: "var(--ink-faint)",
  },
  queued: {
    bd: "color-mix(in srgb, var(--state-info) 55%, transparent)",
    bg: "color-mix(in srgb, var(--state-info) 7%, var(--card))",
    fg: "var(--state-info)",
  },
  running: {
    bd: "var(--brand)",
    bg: "color-mix(in srgb, var(--brand) 8%, var(--card))",
    fg: "var(--brand-2)",
  },
  waiting: {
    bd: "var(--state-paused)",
    bg: "color-mix(in srgb, var(--state-paused) 8%, var(--card))",
    fg: "var(--state-paused)",
  },
  done: {
    bd: "var(--state-done)",
    bg: "color-mix(in srgb, var(--state-done) 7%, var(--card))",
    fg: "var(--state-done)",
  },
  error: {
    bd: "var(--state-error)",
    bg: "color-mix(in srgb, var(--state-error) 8%, var(--card))",
    fg: "var(--state-error)",
  },
  skipped: {
    bd: "var(--line-2)",
    bg: "var(--card-2)",
    fg: "var(--ink-3)",
    dashed: true,
    dim: true,
  },
  stale: {
    bd: "color-mix(in srgb, var(--state-paused) 55%, transparent)",
    bg: "color-mix(in srgb, var(--state-paused) 6%, var(--card))",
    fg: "var(--state-paused)",
    dashed: true,
  },
  "no-input": {
    bd: "color-mix(in srgb, var(--state-error) 55%, transparent)",
    bg: "color-mix(in srgb, var(--state-error) 6%, var(--card))",
    fg: "var(--state-error)",
    dashed: true,
  },
};

/** The uppercase mono state word shown top-right of the card. */
const STATE_WORD: Record<NodeRunState, string> = {
  idle: "idle",
  queued: "queued",
  running: "run",
  waiting: "wait",
  done: "done",
  error: "failed",
  skipped: "skipped",
  stale: "stale",
  "no-input": "no input",
};

const monoLabel: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 9.5,
  fontWeight: "var(--weight-semibold)",
  letterSpacing: "0.06em",
  textTransform: "uppercase",
};

function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`;
}

export interface NodeCardProps {
  kind: NodeType;
  title: string;
  subtitle?: string;
  state?: NodeRunState;
  selected?: boolean;
  /** Node has a pinned authoring sample (badge). */
  pinned?: boolean;
  /** Lint issue text (amber badge + tooltip). */
  warning?: string;
  /** Measured wall-clock of the last single-node test run (real data only). */
  runMs?: number;
  /** Cost-cap / per-call cost chip text, from REAL node config (e.g. "cap $2"). */
  costChip?: string;
  /** Per-node ▶ test-run affordance; omit to hide (e.g. end node). */
  onRun?: () => void;
  /** ✕ delete micro-button (top-left, visible on hover/selection); omit to hide. */
  onDelete?: () => void;
}

export function NodeCard({
  kind,
  title,
  subtitle,
  state = "idle",
  selected,
  pinned,
  warning,
  runMs,
  costChip,
  onRun,
  onDelete,
}: NodeCardProps) {
  const accent = ACCENT[kind] ?? "var(--ink-faint)";
  const s = STATE_STYLE[state];
  const busy = state === "running" || state === "queued";
  const pulse =
    state === "running"
      ? "naary-card-pulse 1.4s ease-in-out infinite"
      : state === "waiting"
        ? "naary-card-pulse-amber 1.1s ease-in-out infinite"
        : undefined;
  let shadow = "var(--shadow-node)";
  if (state === "done")
    shadow =
      "0 6px 22px -16px color-mix(in srgb, var(--state-done) 60%, transparent)";
  if (selected && !pulse)
    shadow =
      "0 0 0 2px color-mix(in srgb, var(--brand) 55%, transparent), 0 12px 34px -16px color-mix(in srgb, var(--brand) 50%, transparent)";
  const hasMeta = runMs !== undefined || costChip || pinned;

  return (
    <div
      className="naary-node-card"
      style={{
        position: "relative",
        minWidth: 176,
        maxWidth: 244,
        borderRadius: 14,
        border: `1px ${s.dashed ? "dashed" : "solid"} ${selected ? "var(--brand)" : s.bd}`,
        background: s.bg,
        opacity: s.dim ? 0.55 : 1,
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 13px",
        cursor: "pointer",
        color: "var(--ink)",
        fontFamily: "var(--font-sans)",
        boxShadow: shadow,
        transition:
          "border-color .25s ease, box-shadow .25s ease, background .25s ease, opacity .25s ease",
        animation: pulse,
      }}
    >
      {/* amber ping ring behind the icon tile while waiting on a human */}
      {state === "waiting" && (
        <span
          aria-hidden
          style={{
            position: "absolute",
            left: 13,
            top: "50%",
            marginTop: -17,
            width: 34,
            height: 34,
            borderRadius: 9,
            background: "var(--state-paused)",
            animation: "naary-ping 1.4s ease-out infinite",
            pointerEvents: "none",
          }}
        />
      )}

      {/* type-accent icon tile */}
      <span
        style={{
          width: 34,
          height: 34,
          flex: "none",
          borderRadius: 9,
          border: `1px solid color-mix(in srgb, ${accent} 65%, transparent)`,
          background: `color-mix(in srgb, ${accent} 10%, transparent)`,
          color: accent,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          position: "relative",
        }}
      >
        <Icon name={nodeIconFor(kind)} size={16} />
      </span>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: "var(--text-body)",
            fontWeight: "var(--weight-semibold)",
            color: "var(--ink)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            display: "flex",
            alignItems: "center",
            gap: 5,
          }}
        >
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
            {title}
          </span>
          {warning && (
            <span
              title={warning}
              style={{
                color: "var(--state-paused)",
                display: "inline-flex",
                flex: "none",
              }}
            >
              <Icon name="alert" size={11} />
            </span>
          )}
        </div>
        {subtitle && (
          <div
            className="mono"
            style={{
              fontSize: "var(--text-2xs)",
              color: "var(--ink-3)",
              marginTop: 1,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {subtitle}
          </div>
        )}
        {/* meta line — only when there's REAL data (measured duration, config cap, pin) */}
        {hasMeta && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              marginTop: 3,
            }}
          >
            {runMs !== undefined && (
              <span
                className="mono"
                style={{ fontSize: 9.5, color: s.fg, letterSpacing: "0.03em" }}
              >
                {fmtMs(runMs)}
              </span>
            )}
            {costChip && (
              <span
                style={{
                  ...monoLabel,
                  fontSize: 9,
                  color: "var(--brand-2)",
                  background: "var(--brand-soft)",
                  border:
                    "1px solid color-mix(in srgb, var(--brand) 35%, transparent)",
                  borderRadius: 5,
                  padding: "1px 5px",
                  textTransform: "none",
                  letterSpacing: "0.02em",
                }}
              >
                {costChip}
              </span>
            )}
            {pinned && (
              <span
                title="Has a pinned sample output (authoring only)"
                style={{
                  ...monoLabel,
                  fontSize: 9,
                  color: "var(--state-paused)",
                  background: "var(--paused-soft)",
                  border:
                    "1px solid color-mix(in srgb, var(--state-paused) 35%, transparent)",
                  borderRadius: 5,
                  padding: "1px 5px",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 3,
                }}
              >
                <svg
                  width="8"
                  height="8"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  aria-hidden
                >
                  <path d="M14 2 9 7H5l3 3-5 9 9-5 3 3v-4l5-5z" />
                </svg>
                pinned
              </span>
            )}
          </div>
        )}
      </div>

      {/* uppercase mono state word */}
      <span style={{ ...monoLabel, color: s.fg, flex: "none" }}>
        {STATE_WORD[state]}
      </span>

      {/* ✕ delete micro-button (top-left; CSS shows it on hover, `is-visible` when selected) */}
      {onDelete && (
        <button
          type="button"
          className={`nodrag naary-node-del${selected ? " is-visible" : ""}`}
          title="Delete node"
          aria-label={`Delete ${title}`}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          style={{
            position: "absolute",
            top: -9,
            left: -9,
            width: 22,
            height: 22,
            borderRadius: "50%",
            border:
              "1px solid color-mix(in srgb, var(--state-error) 55%, transparent)",
            background: "var(--card)",
            color: "var(--state-error)",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            boxShadow: "0 3px 10px -3px rgba(0, 0, 0, 0.4)",
            padding: 0,
          }}
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden
          >
            <path
              d="M6 6l12 12M18 6L6 18"
              stroke="currentColor"
              strokeWidth="2.6"
              strokeLinecap="round"
            />
          </svg>
        </button>
      )}

      {/* bottom progress strip while the single-node test runs (indeterminate —
          we have no honest percentage; the sweep just signals live work) */}
      {busy && (
        <span
          aria-hidden
          style={{
            position: "absolute",
            left: 13,
            right: 13,
            bottom: 4,
            height: 3,
            borderRadius: 3,
            background: "var(--brand-soft)",
            overflow: "hidden",
            pointerEvents: "none",
          }}
        >
          <span
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              width: "40%",
              borderRadius: 3,
              background:
                "linear-gradient(90deg, var(--brand), var(--brand-2))",
              animation: "naaryIndeterminate 1.1s ease-in-out infinite",
            }}
          />
        </span>
      )}

      {/* floating per-node ▶ run affordance (single-node test) */}
      {onRun && (
        <button
          type="button"
          className="nodrag naary-node-run"
          title={busy ? "Running…" : "Test this step"}
          aria-label={`Test ${title}`}
          disabled={busy}
          onClick={(e) => {
            e.stopPropagation();
            onRun();
          }}
          style={{
            position: "absolute",
            top: -9,
            right: -9,
            width: 24,
            height: 24,
            borderRadius: "50%",
            border: `1px solid ${busy ? "var(--brand)" : "var(--line-2)"}`,
            background: busy
              ? "color-mix(in srgb, var(--brand) 12%, var(--card))"
              : "var(--card)",
            color: busy ? "var(--ink-3)" : "var(--brand-2)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: busy ? "default" : "pointer",
            boxShadow: "0 3px 10px -3px rgba(0, 0, 0, 0.4)",
            padding: 0,
          }}
        >
          {busy ? (
            <span
              aria-hidden
              style={{
                width: 10,
                height: 10,
                border: "2px solid var(--brand-soft)",
                borderTopColor: "var(--brand)",
                borderRadius: "50%",
                display: "inline-block",
                animation: "naarySpin .7s linear infinite",
              }}
            />
          ) : (
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden
            >
              <path d="M7 5v14l12-7z" />
            </svg>
          )}
        </button>
      )}
    </div>
  );
}
