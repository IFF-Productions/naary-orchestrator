/**
 * Inspector dock (redesign: Canvas Authoring Loop) — the persistent 492px right
 * column of the canvas editor. For the selected node it shows:
 *   sticky header (type-accent icon tile · name · mono type/id · state pill ·
 *   trash) + action row (Test step / Pin) + honest banners (no-input / stale /
 *   lint issues) + a running card while a test executes; then sections:
 *   ROUTING RULES (switch/if — derived from the real config + edges),
 *   INPUT DATA (draggable rows from upstream test outputs + pins),
 *   PARAMETERS (the existing ConfigPanel — expression fields are drop targets),
 *   OUTPUT / LOGS tabs (the node's real last test result only — no fabricated
 *   log lines). Nothing selected → a calm hint. A selected edge overlays the
 *   dock with the Connection inspector (EdgeInspector, passed as `overlay`).
 */
import { type ReactNode, useEffect, useState } from "react";
import type { NodeType } from "@naary/dsl";
import { Icon } from "../../components";
import { ACCENT } from "../../lib/graph-model";
import { DockOutputTabs } from "./DockOutputTabs";
import { nodeIconFor, type NodeRunState } from "./NodeCard";
import { FieldRow } from "./output-fields";

/** One INPUT DATA row (already flattened by the canvas). */
export interface DockInputRow {
  key: string;
  /** The `{{ node.path }}` token inserted on drop. */
  token: string;
  path: string;
  preview: string;
  /** Source tag: the upstream node's name, or "pinned". */
  tag: string;
}

/** One routing-rule read-view row (switch/if). */
export interface DockRoutingRow {
  n: number;
  cond: string;
  /** Display label of the node this rule routes to (when an edge exists). */
  target?: string;
  /** Real test-run verdict, when the node's output states which rule matched. */
  badge?: "matched" | "skipped";
}

/** Client-side record of the selected node's last single-node test. */
export interface DockRun {
  status: "running" | "done" | "error";
  output?: unknown;
  message?: string;
  ms?: number;
  stale?: boolean;
  startedAt?: number;
}

const MONO_LABEL: React.CSSProperties = {
  fontSize: "var(--text-2xs)",
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  color: "var(--ink-faint)",
  fontFamily: "var(--font-mono)",
  fontWeight: "var(--weight-semibold)",
};

/** State pill palette (mirrors the node card's state colours). */
const PILL: Record<NodeRunState, { fg: string; bd: string; word: string }> = {
  idle: { fg: "var(--ink-faint)", bd: "var(--line-2)", word: "idle" },
  queued: { fg: "var(--state-info)", bd: "var(--state-info)", word: "queued" },
  running: { fg: "var(--brand-2)", bd: "var(--brand)", word: "running" },
  waiting: {
    fg: "var(--state-paused)",
    bd: "var(--state-paused)",
    word: "waiting",
  },
  done: { fg: "var(--state-done)", bd: "var(--state-done)", word: "done" },
  error: { fg: "var(--state-error)", bd: "var(--state-error)", word: "failed" },
  skipped: { fg: "var(--ink-3)", bd: "var(--line-2)", word: "skipped" },
  stale: {
    fg: "var(--state-paused)",
    bd: "var(--state-paused)",
    word: "stale",
  },
  "no-input": {
    fg: "var(--state-error)",
    bd: "var(--state-error)",
    word: "no input",
  },
};

/** Live elapsed readout while a test runs (client-measured — real time only). */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 90);
    return () => clearInterval(id);
  }, []);
  return <>{((now - since) / 1000).toFixed(2)}s</>;
}

export function InspectorDock({
  nodeId,
  kind,
  title,
  state = "idle",
  run,
  isPinned,
  pinnedOutput,
  canPin,
  warnings,
  routing,
  routingTitle,
  routingNote,
  inputRows,
  parameters,
  onTest,
  onPin,
  onUnpin,
  onDelete,
  overlay,
  floating,
  onClose,
}: {
  /** Selected node (all absent → empty state). */
  nodeId?: string;
  kind?: NodeType;
  title?: string;
  state?: NodeRunState;
  run?: DockRun;
  isPinned?: boolean;
  pinnedOutput?: unknown;
  canPin?: boolean;
  /** Lint issue lines for this node (real linter output). */
  warnings?: string[];
  routing?: DockRoutingRow[];
  /** Section heading — honest per node type (switch is first-match-wins; if fires every matching edge). */
  routingTitle?: string;
  routingNote?: string;
  inputRows?: DockInputRow[];
  /** The existing ConfigPanel, already wired by the canvas. */
  parameters?: ReactNode;
  onTest?: () => void;
  onPin?: () => void;
  onUnpin?: () => void;
  onDelete?: () => void;
  /** Edge (Connection) inspector — overlays everything when present. */
  overlay?: ReactNode;
  /** Overlay mode on narrow viewports/phone: absolute over the canvas + close btn. */
  floating?: boolean;
  onClose?: () => void;
}) {
  const hasNode = Boolean(nodeId && kind);
  const accent = kind
    ? (ACCENT[kind] ?? "var(--ink-faint)")
    : "var(--ink-faint)";
  const pill = PILL[state];
  const running = run?.status === "running";
  const freshOutput = run?.status === "done" && run.output !== undefined;

  return (
    <aside
      aria-label="Inspector"
      className="naary-dock"
      style={{
        width: floating ? "min(492px, 100vw)" : 492,
        flex: "none",
        borderLeft: "1px solid var(--line)",
        background: "var(--panel)",
        overflowY: "auto",
        position: floating ? "absolute" : "relative",
        ...(floating ? { top: 0, right: 0, bottom: 0, zIndex: 40 } : {}),
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      {/* edge (Connection) inspector overlays the whole dock */}
      {overlay}

      {!hasNode ? (
        /* empty state — nothing selected */
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
            padding: "40px 32px",
            textAlign: "center",
          }}
        >
          <span
            style={{
              width: 42,
              height: 42,
              borderRadius: 11,
              border: "1px dashed var(--line-2)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--ink-3)",
            }}
          >
            <Icon name="workflow" size={19} />
          </span>
          <div style={{ fontSize: "var(--text-sm)", color: "var(--ink-2)" }}>
            Select a node to configure it
          </div>
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-faint)",
              lineHeight: 1.6,
              maxWidth: 300,
            }}
          >
            Test a step with ▷, then drag its output fields into the next node's
            parameters. Click a connection line to edit its branch condition.
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0 }}>
          {/* sticky header */}
          <div
            style={{
              position: "sticky",
              top: 0,
              zIndex: 2,
              background: "var(--panel)",
              borderBottom: "1px solid var(--line)",
              padding: "16px 20px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
              <span
                style={{
                  width: 34,
                  height: 34,
                  flex: "none",
                  borderRadius: 9,
                  border: `1px solid ${accent}`,
                  color: accent,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {kind && <Icon name={nodeIconFor(kind)} size={16} />}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 14.5,
                    fontWeight: "var(--weight-bold)",
                    color: "var(--ink)",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {title}
                </div>
                <div
                  className="mono"
                  style={{
                    fontSize: "var(--text-2xs)",
                    color: "var(--ink-faint)",
                    marginTop: 1,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {kind} · {nodeId}
                </div>
              </div>
              <span
                className="mono"
                style={{
                  fontSize: 10,
                  fontWeight: "var(--weight-semibold)",
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  color: pill.fg,
                  border: `1px solid color-mix(in srgb, ${pill.bd} 55%, transparent)`,
                  background: `color-mix(in srgb, ${pill.bd} 8%, transparent)`,
                  borderRadius: 20,
                  padding: "3px 10px",
                  flex: "none",
                }}
              >
                {pill.word}
              </span>
              {onDelete && (
                <button
                  type="button"
                  aria-label="Delete node"
                  title="Delete node"
                  onClick={onDelete}
                  style={{
                    width: 32,
                    height: 32,
                    flex: "none",
                    borderRadius: 8,
                    border: "1px solid var(--line-2)",
                    background: "var(--card)",
                    color: "var(--state-error)",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Icon name="trash" size={15} />
                </button>
              )}
              {floating && onClose && (
                <button
                  type="button"
                  aria-label="Close inspector"
                  onClick={onClose}
                  style={{
                    width: 32,
                    height: 32,
                    flex: "none",
                    borderRadius: 8,
                    border: "1px solid var(--line-2)",
                    background: "var(--card)",
                    color: "var(--ink-2)",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Icon name="x" size={14} />
                </button>
              )}
            </div>

            {/* action row: Test step + Pin */}
            {onTest && (
              <div
                style={{
                  marginTop: 14,
                  display: "flex",
                  gap: 9,
                  alignItems: "center",
                }}
              >
                <button
                  type="button"
                  onClick={onTest}
                  disabled={running}
                  style={{
                    flex: 1,
                    height: 38,
                    borderRadius: 9,
                    border: freshOutput
                      ? "1px solid var(--line-2)"
                      : "1px solid color-mix(in srgb, var(--brand) 45%, transparent)",
                    background: running
                      ? "var(--card)"
                      : freshOutput
                        ? "var(--card)"
                        : "linear-gradient(180deg, var(--brand-2), var(--brand))",
                    color: running
                      ? "var(--ink-3)"
                      : freshOutput
                        ? "var(--brand-2)"
                        : "var(--brand-ink, #fff3ec)",
                    fontSize: "var(--text-sm)",
                    fontWeight: "var(--weight-bold)",
                    cursor: running ? "default" : "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 7,
                  }}
                >
                  {running ? (
                    <>
                      <span
                        aria-hidden
                        style={{
                          width: 13,
                          height: 13,
                          border: "2px solid var(--brand-soft)",
                          borderTopColor: "var(--brand)",
                          borderRadius: "50%",
                          display: "inline-block",
                          animation: "naarySpin .7s linear infinite",
                        }}
                      />
                      Running…
                    </>
                  ) : freshOutput ? (
                    <>↻ Re-run step</>
                  ) : (
                    <>
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="currentColor"
                        aria-hidden
                      >
                        <path d="M7 5v14l12-7z" />
                      </svg>
                      Test step
                    </>
                  )}
                </button>
                <button
                  type="button"
                  title={
                    !canPin
                      ? "Save the workflow first to pin a sample output"
                      : isPinned
                        ? "Unpin this node's sample data"
                        : freshOutput
                          ? "Pin the current output as sample data"
                          : "Run Test step first — pinning stores its output"
                  }
                  disabled={!canPin || (!isPinned && !freshOutput)}
                  onClick={() => {
                    if (isPinned) onUnpin?.();
                    else onPin?.();
                  }}
                  style={{
                    height: 38,
                    padding: "0 13px",
                    borderRadius: 9,
                    border: `1px solid ${
                      isPinned
                        ? "color-mix(in srgb, var(--state-paused) 45%, transparent)"
                        : "var(--line-2)"
                    }`,
                    background: isPinned ? "var(--paused-soft)" : "var(--card)",
                    color: isPinned ? "var(--state-paused)" : "var(--ink-2)",
                    fontSize: "var(--text-xs)",
                    fontWeight: "var(--weight-semibold)",
                    cursor:
                      !canPin || (!isPinned && !freshOutput)
                        ? "default"
                        : "pointer",
                    opacity: !canPin || (!isPinned && !freshOutput) ? 0.55 : 1,
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    aria-hidden
                  >
                    <path d="M14 2 9 7H5l3 3-5 9 9-5 3 3v-4l5-5z" />
                  </svg>
                  {isPinned ? "Pinned" : "Pin"}
                </button>
              </div>
            )}

            {/* honest warning banners */}
            {(state === "no-input" || state === "stale") && (
              <div
                style={{
                  marginTop: 12,
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: "var(--text-xs)",
                  lineHeight: 1.4,
                  borderRadius: 10,
                  padding: "10px 12px",
                  border: `1px solid ${
                    state === "no-input"
                      ? "color-mix(in srgb, var(--state-error) 45%, transparent)"
                      : "color-mix(in srgb, var(--state-paused) 45%, transparent)"
                  }`,
                  background:
                    state === "no-input"
                      ? "color-mix(in srgb, var(--state-error) 7%, var(--card))"
                      : "var(--paused-soft)",
                  color:
                    state === "no-input"
                      ? "var(--state-error)"
                      : "var(--state-paused)",
                }}
              >
                <Icon name="alert" size={14} style={{ flex: "none" }} />
                <span>
                  {state === "no-input"
                    ? "No input connected — link an edge into this node before it can run."
                    : "Inputs changed upstream — re-run this step to refresh its output."}
                </span>
              </div>
            )}
            {warnings && warnings.length > 0 && (
              <div
                style={{
                  marginTop: 12,
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 8,
                  fontSize: "var(--text-xs)",
                  lineHeight: 1.4,
                  borderRadius: 10,
                  padding: "10px 12px",
                  border:
                    "1px solid color-mix(in srgb, var(--state-paused) 45%, transparent)",
                  background: "var(--paused-soft)",
                  color: "var(--state-paused)",
                }}
              >
                <Icon
                  name="alert"
                  size={14}
                  style={{ flex: "none", marginTop: 1 }}
                />
                <span style={{ whiteSpace: "pre-line" }}>
                  {warnings.join("\n")}
                </span>
              </div>
            )}

            {/* running card — spinner + live elapsed + indeterminate sheen bar */}
            {running && (
              <div
                style={{
                  marginTop: 14,
                  border: "1px solid var(--brand)",
                  background:
                    "color-mix(in srgb, var(--brand) 7%, var(--card))",
                  borderRadius: 11,
                  padding: "13px 14px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 9,
                    marginBottom: 9,
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      width: 14,
                      height: 14,
                      border: "2px solid var(--brand-soft)",
                      borderTopColor: "var(--brand)",
                      borderRadius: "50%",
                      display: "inline-block",
                      animation: "naarySpin .7s linear infinite",
                      flex: "none",
                    }}
                  />
                  <span
                    style={{
                      fontSize: "var(--text-sm)",
                      color: "var(--brand-2)",
                      fontWeight: "var(--weight-semibold)",
                    }}
                  >
                    Running step
                  </span>
                  {run?.startedAt && (
                    <span
                      className="mono"
                      style={{
                        marginLeft: "auto",
                        fontSize: "var(--text-xs)",
                        color: "var(--ink-soft)",
                      }}
                    >
                      <Elapsed since={run.startedAt} />
                    </span>
                  )}
                </div>
                <div
                  style={{
                    height: 8,
                    borderRadius: 5,
                    background: "var(--brand-soft)",
                    overflow: "hidden",
                    position: "relative",
                  }}
                >
                  <div
                    style={{
                      position: "absolute",
                      top: 0,
                      bottom: 0,
                      width: "40%",
                      background:
                        "linear-gradient(90deg, var(--brand), var(--brand-2))",
                      borderRadius: 5,
                      animation: "naaryIndeterminate 1.1s ease-in-out infinite",
                    }}
                  />
                </div>
              </div>
            )}
          </div>

          {/* ROUTING RULES (switch/if) */}
          {routing && routing.length > 0 && (
            <div style={{ padding: "16px 20px 6px" }}>
              <div style={{ ...MONO_LABEL, marginBottom: 10 }}>
                {routingTitle ?? "Routing rules · first match wins"}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {routing.map((r) => {
                  const matched = r.badge === "matched";
                  const skipped = r.badge === "skipped";
                  return (
                    <div
                      key={r.n}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 9,
                        border: `1px solid ${
                          matched
                            ? "color-mix(in srgb, var(--state-done) 55%, transparent)"
                            : "var(--line-mid)"
                        }`,
                        background: matched
                          ? "color-mix(in srgb, var(--state-done) 7%, var(--card))"
                          : "var(--card)",
                        borderRadius: 9,
                        padding: "10px 12px",
                        opacity: skipped ? 0.6 : 1,
                      }}
                    >
                      <span
                        className="mono"
                        style={{
                          fontSize: 10,
                          fontWeight: "var(--weight-bold)",
                          color: "var(--ink-3)",
                          flex: "none",
                        }}
                      >
                        {r.n}
                      </span>
                      <span
                        className="mono"
                        style={{
                          fontSize: "var(--text-sm)",
                          color: "var(--ink-soft)",
                          flex: 1,
                          minWidth: 0,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {r.cond}
                      </span>
                      {r.target && (
                        <span
                          style={{
                            fontSize: "var(--text-xs)",
                            color: "var(--ink-faint)",
                            flex: "none",
                            maxWidth: 130,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          → {r.target}
                        </span>
                      )}
                      {r.badge && (
                        <span
                          style={{
                            fontSize: 9.5,
                            fontWeight: "var(--weight-bold)",
                            letterSpacing: "0.05em",
                            color: matched
                              ? "var(--state-done)"
                              : "var(--ink-3)",
                            background: matched
                              ? "color-mix(in srgb, var(--state-done) 10%, transparent)"
                              : "var(--card-2)",
                            border: `1px solid ${
                              matched
                                ? "color-mix(in srgb, var(--state-done) 55%, transparent)"
                                : "var(--line-2)"
                            }`,
                            borderRadius: 20,
                            padding: "2px 8px",
                            flex: "none",
                          }}
                        >
                          {r.badge.toUpperCase()}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
              {routingNote && (
                <div
                  style={{
                    marginTop: 11,
                    fontSize: "var(--text-xs)",
                    color: "var(--ink-faint)",
                    lineHeight: 1.5,
                  }}
                >
                  {routingNote}
                </div>
              )}
            </div>
          )}

          {/* INPUT DATA */}
          {inputRows && inputRows.length > 0 && (
            <div style={{ padding: "16px 20px 6px" }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginBottom: 10,
                }}
              >
                <span style={MONO_LABEL}>Input data</span>
                <span style={{ fontSize: 10.5, color: "var(--ink-3)" }}>
                  drag a field into a parameter ↓
                </span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                {inputRows.map((f) => (
                  <FieldRow
                    key={f.key}
                    token={f.token}
                    path={f.path}
                    valuePreview={f.preview}
                    tag={f.tag}
                    variant="input"
                  />
                ))}
              </div>
            </div>
          )}

          {/* PARAMETERS — the existing config editor; expression fields are drop targets */}
          {parameters && (
            <div style={{ padding: "12px 20px 6px" }}>
              <div style={{ ...MONO_LABEL, marginBottom: 10 }}>Parameters</div>
              <div className="naary-drop-scope">{parameters}</div>
            </div>
          )}

          {/* OUTPUT / LOGS (split out for the large-files check) */}
          <DockOutputTabs
            nodeId={nodeId ?? ""}
            run={run}
            isPinned={isPinned}
            pinnedOutput={pinnedOutput}
          />
        </div>
      )}
    </aside>
  );
}
