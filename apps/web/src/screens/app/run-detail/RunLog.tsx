// Execution log (curated Temporal history) for the RunDetail screen: the
// polling hook + the design's mono, timestamped log panel. The screen owns the
// hook (it also derives start/paused-since times from the events) and feeds the
// panel wherever the log renders.
import { useEffect, useState } from "react";
import { LoadingBlock } from "../../../components";
import { api, type RunEvent } from "../../../lib/api";
import { NodeOutputBody } from "./NodeOutputBody";

/* ---- kind → row colour (durable record; waiting reads calm, never error). ---- */
const LOG_KIND_COLOR: Record<string, string> = {
  started: "var(--state-info)",
  activity: "var(--node-agent)",
  signal: "var(--node-approval)",
  timer: "var(--state-paused)",
  completed: "var(--state-done)",
  error: "var(--state-error)",
  continued: "var(--ink-3)",
  node: "var(--ink-3)", // synthetic per-step rows, muted against the real Temporal events
};

/** One log row. A superset of RunEvent so synthetic client-side per-step rows (string id, kind
 *  "node") can be interleaved with the server's curated Temporal events by timestamp. */
export interface LogEntry {
  id: string | number;
  at: string | null;
  kind: string;
  label: string;
  detail?: string;
  /**
   * The step this row is about, when it is about one. Its presence is what makes a row
   * expandable — the fields below are the payload, kept STRUCTURED rather than appended to
   * `label` so the collapsed line stays scannable and the allowlist that guards it stays
   * meaningful (see NodeLogRows).
   */
  nodeId?: string;
  /** The step's configuration resolved against the run's data (`$secrets` stay literal). */
  input?: unknown;
  /** The step's own output from the run ctx. */
  output?: unknown;
  /** Set when the step ran more than once — its ctx holds only the LAST run's values. */
  ranTimes?: number;
}

/**
 * Poll the run's curated history until a terminal event appears (the closing
 * event can lag the status flip, so a single fetch can miss it).
 */
export function useRunHistory(id: string): RunEvent[] | null {
  const [events, setEvents] = useState<RunEvent[] | null>(null);

  useEffect(() => {
    let live = true;
    let t: ReturnType<typeof setTimeout>;
    setEvents(null); // navigating between runs must not show the old run's log
    const done = (evs: RunEvent[]) =>
      evs.some((e) => ["completed", "error", "continued"].includes(e.kind));
    const tick = async () => {
      try {
        const e = await api.getRunHistory(id);
        if (!live) return;
        setEvents(e);
        if (!done(e)) t = setTimeout(tick, 2000);
      } catch {
        if (live) t = setTimeout(tick, 2000);
      }
    };
    tick();
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [id]);

  return events;
}

/** Is there anything to show if this row is opened? A row whose step produced neither a resolved
 *  input nor an output has nothing behind the caret, so it doesn't get one — an expander that
 *  opens onto "nothing here" is worse than no expander. */
function hasPayload(ev: LogEntry): boolean {
  return (
    ev.nodeId !== undefined &&
    (ev.input !== undefined || ev.output !== undefined)
  );
}

/** One expanded step: what it was given, and what it produced. */
function StepPayload({ ev }: { ev: LogEntry }) {
  return (
    <div
      style={{
        margin: "4px 0 10px 0",
        padding: "10px 12px",
        border: "1px solid var(--line)",
        borderRadius: 8,
        background: "var(--surface)",
        // The log well is 11.5px mono; the payload is real content, so it reads at body size.
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-xs)",
      }}
    >
      {ev.ranTimes !== undefined && (
        <div style={{ color: "var(--state-paused)", marginBottom: 8 }}>
          This step ran {ev.ranTimes} times — a loop iteration or a retry
          attempt. Only the last run's values are kept, so that is what's below.
        </div>
      )}
      {ev.input !== undefined && (
        <>
          <PayloadLabel>
            input{" "}
            <span style={{ textTransform: "none", letterSpacing: 0 }}>
              — this step's settings, filled in with this run's data
            </span>
          </PayloadLabel>
          <NodeOutputBody output={ev.input} />
        </>
      )}
      {ev.output !== undefined && (
        <>
          <PayloadLabel style={ev.input !== undefined ? { marginTop: 12 } : {}}>
            output
          </PayloadLabel>
          <NodeOutputBody output={ev.output} />
        </>
      )}
    </div>
  );
}

function PayloadLabel({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className="mono"
      style={{
        fontSize: "var(--text-2xs)",
        letterSpacing: ".1em",
        textTransform: "uppercase",
        color: "var(--ink-faint)",
        marginBottom: 6,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** The design's log panel: dark mono well, timestamped rows coloured by kind. Accepts LogEntry so
 *  the caller can interleave synthetic per-step rows with the curated Temporal events — those rows
 *  carry a payload and open to show what the step was given and what it produced. */
export function LogPanel({ events }: { events: LogEntry[] | null }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      // A new Set, not a mutation: React bails out of a state update that is Object.is-equal to
      // the previous value, so mutating and re-setting the same Set would not re-render.
      if (!next.delete(key)) next.add(key);
      return next;
    });
  return (
    <div
      // Named group — see StepTimeline: both lists carry a button per step, and the name is what
      // says which one you're in.
      role="group"
      aria-label="Execution log"
      style={{
        border: "1px solid var(--line-mid)",
        background: "var(--bg)",
        borderRadius: 10,
        padding: "12px 14px",
        fontFamily: "var(--font-mono)",
        fontSize: 11.5,
        lineHeight: 1.85,
        // 320 keeps a long history from taking over the screen. But an opened step puts real
        // content inside that same scroll well, and reading a response body through a ~15-line
        // window is its own small misery — so the panel earns more room exactly when it has
        // something worth showing, and gives it back when the row closes.
        maxHeight: open.size > 0 ? 640 : 320,
        overflowY: "auto",
      }}
    >
      {!events ? (
        <LoadingBlock label="Loading log…" />
      ) : events.length === 0 ? (
        <span style={{ color: "var(--ink-3)" }}>No events yet.</span>
      ) : (
        events.map((ev) => {
          // Stable key: kind + id (Temporal eventId is unique; synthetic per-step ids are
          // `node-<id>`). No array index — that made keys shift on re-sort/new events,
          // remounting rows (#566 review).
          const key = `${ev.kind}-${ev.id}`;
          const expandable = hasPayload(ev);
          const isOpen = open.has(key);
          const rowText = (
            <>
              {ev.label}
              {ev.detail && (
                <span style={{ color: "var(--ink-3)", marginLeft: 8 }}>
                  {ev.detail}
                </span>
              )}
            </>
          );
          return (
            <div key={key}>
              <div style={{ display: "flex", gap: 10 }}>
                <span style={{ color: "var(--ink-3)", flex: "none" }}>
                  {ev.at ? new Date(ev.at).toLocaleTimeString() : "—"}
                </span>
                {expandable ? (
                  // A real <button>: the row is an interactive disclosure, so it has to be
                  // reachable and announced as one. Styled flat so the log still reads as a log.
                  <button
                    type="button"
                    onClick={() => toggle(key)}
                    aria-expanded={isOpen}
                    title={
                      isOpen
                        ? "Hide this step's input and output"
                        : "Show this step's input and output"
                    }
                    style={{
                      background: "none",
                      border: "none",
                      padding: 0,
                      textAlign: "left",
                      cursor: "pointer",
                      font: "inherit",
                      color: LOG_KIND_COLOR[ev.kind] ?? "var(--ink-2)",
                      minWidth: 0,
                      overflowWrap: "anywhere",
                    }}
                  >
                    <span
                      aria-hidden="true"
                      style={{ color: "var(--ink-faint)", marginRight: 6 }}
                    >
                      {isOpen ? "▾" : "▸"}
                    </span>
                    {rowText}
                  </button>
                ) : (
                  <span
                    style={{
                      color: LOG_KIND_COLOR[ev.kind] ?? "var(--ink-2)",
                      minWidth: 0,
                      overflowWrap: "anywhere",
                    }}
                  >
                    {rowText}
                  </span>
                )}
              </div>
              {expandable && isOpen && <StepPayload ev={ev} />}
            </div>
          );
        })
      )}
    </div>
  );
}
