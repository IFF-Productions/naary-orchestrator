// Execution log section (curated Temporal history) for the RunDetail screen.
import { useEffect, useState } from "react";
import { Card, LoadingBlock } from "../../../components";
import { api, type RunEvent } from "../../../lib/api";
import { SectionTitle } from "./shared";

/* ---- Execution log: the run's curated Temporal history (durable record). ---- */
const LOG_KIND_COLOR: Record<string, string> = {
  started: "var(--state-info)",
  activity: "var(--node-agent)",
  signal: "var(--node-approval)",
  timer: "var(--state-paused)",
  completed: "var(--state-done)",
  error: "var(--state-error)",
  continued: "var(--ink-3)",
};

export function RunLog({ id }: { id: string }) {
  const [events, setEvents] = useState<Awaited<
    ReturnType<typeof api.getRunHistory>
  > | null>(null);

  // Poll the history until a terminal event appears — the closing event can lag
  // the status flip, so a single fetch can miss it.
  useEffect(() => {
    let live = true;
    let t: ReturnType<typeof setTimeout>;
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

  return (
    <Card style={{ padding: "18px 20px", marginTop: 16 }}>
      <SectionTitle>Execution log</SectionTitle>
      {!events ? (
        <LoadingBlock label="Loading log…" />
      ) : events.length === 0 ? (
        <div style={{ color: "var(--ink-3)", fontSize: "var(--text-body)" }}>
          No events yet.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
          {events.map((ev) => (
            <div
              key={ev.id}
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 10,
                padding: "6px 0",
                borderTop: "1px solid var(--line)",
              }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  flex: "none",
                  marginTop: 5,
                  background: LOG_KIND_COLOR[ev.kind] ?? "var(--ink-3)",
                }}
              />
              <span
                style={{
                  flex: 1,
                  fontSize: "var(--text-body)",
                  color: "var(--ink)",
                }}
              >
                {ev.label}
                {ev.detail && (
                  <span
                    className="mono"
                    style={{
                      color: "var(--ink-3)",
                      marginLeft: 8,
                      fontSize: "var(--text-xs)",
                    }}
                  >
                    {ev.detail}
                  </span>
                )}
              </span>
              <span
                className="mono"
                style={{
                  fontSize: "var(--text-2xs)",
                  color: "var(--ink-3)",
                  flex: "none",
                }}
              >
                {ev.at ? new Date(ev.at).toLocaleTimeString() : ""}
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
