// Execution log (curated Temporal history) for the RunDetail screen: the
// polling hook + the design's mono, timestamped log panel. The screen owns the
// hook (it also derives start/paused-since times from the events) and feeds the
// panel wherever the log renders.
import { useEffect, useState } from "react";
import { LoadingBlock } from "../../../components";
import { api, type RunEvent } from "../../../lib/api";

/* ---- kind → row colour (durable record; waiting reads calm, never error). ---- */
const LOG_KIND_COLOR: Record<string, string> = {
  started: "var(--state-info)",
  activity: "var(--node-agent)",
  signal: "var(--node-approval)",
  timer: "var(--state-paused)",
  completed: "var(--state-done)",
  error: "var(--state-error)",
  continued: "var(--ink-3)",
};

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

/** The design's log panel: dark mono well, timestamped rows coloured by kind. */
export function LogPanel({ events }: { events: RunEvent[] | null }) {
  return (
    <div
      style={{
        border: "1px solid var(--line-mid)",
        background: "var(--bg)",
        borderRadius: 10,
        padding: "12px 14px",
        fontFamily: "var(--font-mono)",
        fontSize: 11.5,
        lineHeight: 1.85,
        maxHeight: 320,
        overflowY: "auto",
      }}
    >
      {!events ? (
        <LoadingBlock label="Loading log…" />
      ) : events.length === 0 ? (
        <span style={{ color: "var(--ink-3)" }}>No events yet.</span>
      ) : (
        events.map((ev) => (
          <div key={ev.id} style={{ display: "flex", gap: 10 }}>
            <span style={{ color: "var(--ink-3)", flex: "none" }}>
              {ev.at ? new Date(ev.at).toLocaleTimeString() : "—"}
            </span>
            <span
              style={{
                color: LOG_KIND_COLOR[ev.kind] ?? "var(--ink-2)",
                minWidth: 0,
                overflowWrap: "anywhere",
              }}
            >
              {ev.label}
              {ev.detail && (
                <span style={{ color: "var(--ink-3)", marginLeft: 8 }}>
                  {ev.detail}
                </span>
              )}
            </span>
          </div>
        ))
      )}
    </div>
  );
}
