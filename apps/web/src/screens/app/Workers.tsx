// Worker view (Queue-mode program): the connected worker fleet + live slot usage, read from the
// operator-only GET /workers registry (fed by each replica's WorkerHeartbeat). Owner/admin only —
// a 403 renders an access notice rather than an error. Auto-refreshes so online/slots stay live.
import { useCallback, useEffect, useRef, useState } from "react";
import { EmptyState, Icon, Skeleton } from "../../components";
import {
  api,
  HttpError,
  UnauthorizedError,
  type WorkerRow,
} from "../../lib/api";
import { PHONE_QUERY, useMediaQuery } from "../../lib/useMediaQuery";

const COLS = "1.8fr 0.9fr 1fr 1.4fr 0.9fr 1fr";
/** Below this the 6 columns get cramped — scroll horizontally inside the card instead. */
const TABLE_MIN_WIDTH = 780;
const REFRESH_MS = 5_000;

/** Compact relative time for the last heartbeat (self-contained — no shared util needed). */
function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Utilization → color token: green under half, amber approaching full, brand at/over capacity. */
function slotColor(active: number, max: number): string {
  if (max <= 0) return "var(--ink-3)";
  const r = active / max;
  if (r >= 1) return "var(--brand)";
  if (r >= 0.75) return "var(--state-warn, #d98a2b)";
  return "var(--state-done)";
}

function SlotBar({ active, max }: { active: number; max: number }) {
  const pct = max > 0 ? Math.min(100, Math.round((active / max) * 100)) : 0;
  const color = slotColor(active, max);
  return (
    <div style={{ display: "grid", gap: 4, minWidth: 96 }}>
      <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-2)" }}>
        <span className="mono" style={{ color }}>
          {active}
        </span>
        <span style={{ color: "var(--ink-3)" }}> / {max} slots</span>
      </div>
      <div
        style={{
          height: 5,
          borderRadius: 999,
          background: "var(--line)",
          overflow: "hidden",
        }}
      >
        <div style={{ width: `${pct}%`, height: "100%", background: color }} />
      </div>
    </div>
  );
}

function StatusBadge({ online }: { online: boolean }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: "var(--text-xs)",
        fontWeight: "var(--weight-semibold)",
        color: online ? "var(--state-done)" : "var(--ink-3)",
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: 999,
          background: online ? "var(--state-done)" : "var(--ink-3)",
        }}
      />
      {online ? "Online" : "Stale"}
    </span>
  );
}

export function Workers() {
  const phone = useMediaQuery(PHONE_QUERY);
  const [workers, setWorkers] = useState<WorkerRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // Keep the latest workers around so a refresh doesn't flash the skeleton (only the first load does).
  const loaded = useRef(false);

  const load = useCallback(async () => {
    try {
      const rows = await api.listWorkers();
      setWorkers(rows);
      setError(null);
      loaded.current = true;
    } catch (e) {
      if (e instanceof UnauthorizedError) {
        setError("Sign in to view the worker fleet.");
      } else if (e instanceof HttpError && e.status === 403) {
        setError("Only workspace owners or admins can view the worker fleet.");
      } else {
        setError("Could not reach the control plane (apps/api on :3000).");
      }
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => {
      setNow(Date.now());
      void load();
    }, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const online = workers?.filter((w) => w.online) ?? [];
  const activeSlots = online.reduce((s, w) => s + w.activeActivities, 0);
  const capacity = online.reduce((s, w) => s + w.maxActivities, 0);

  return (
    <div
      style={{
        padding: phone ? "22px 14px 40px" : "22px 28px 40px",
        maxWidth: 1100,
      }}
    >
      <div style={{ marginBottom: 22 }}>
        <div
          style={{
            fontSize: "var(--text-title)",
            fontWeight: "var(--weight-bold)",
            color: "var(--ink)",
            letterSpacing: "var(--tracking-tight)",
          }}
        >
          Workers
        </div>
        <div
          style={{
            fontSize: "var(--text-body)",
            color: "var(--ink-2)",
            marginTop: 4,
          }}
        >
          The connected worker fleet and live slot usage. Infra telemetry —
          owner/admin only.
        </div>
      </div>

      {/* summary band (only once loaded without error) */}
      {workers && !error && (
        <div
          style={{
            display: "flex",
            gap: phone ? 14 : 28,
            flexWrap: "wrap",
            marginBottom: 20,
            padding: "12px 16px",
            border: "1px solid var(--line)",
            borderRadius: "var(--radius-md)",
            background: "var(--card)",
          }}
        >
          <Stat
            label="Online replicas"
            value={`${online.length} / ${workers.length}`}
          />
          <Stat label="Slots in use" value={`${activeSlots} / ${capacity}`} />
          <Stat
            label="Utilization"
            value={
              capacity > 0
                ? `${Math.round((activeSlots / capacity) * 100)}%`
                : "—"
            }
          />
        </div>
      )}

      {error && (
        <div
          style={{
            padding: "10px 12px",
            borderRadius: "var(--radius-md)",
            background: "var(--error-soft)",
            border:
              "1px solid color-mix(in srgb, var(--state-error) 40%, transparent)",
            color: "var(--state-error)",
            fontSize: "var(--text-sm)",
          }}
        >
          {error}
        </div>
      )}

      {!error && workers === null && !loaded.current && (
        <div style={{ display: "grid", gap: 8 }}>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} height={52} />
          ))}
        </div>
      )}

      {!error && workers && workers.length === 0 && (
        <EmptyState
          icon="grid"
          title="No workers connected"
          body="Start a worker (npm run worker) — it registers a heartbeat and appears here within a few seconds."
        />
      )}

      {!error && workers && workers.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <div style={{ minWidth: phone ? undefined : TABLE_MIN_WIDTH }}>
            {!phone && (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: COLS,
                  gap: 12,
                  padding: "0 12px 8px",
                  fontSize: "var(--text-xs)",
                  color: "var(--ink-3)",
                  fontWeight: "var(--weight-semibold)",
                }}
              >
                <div>Host</div>
                <div>Version</div>
                <div>Task queue</div>
                <div>Slots</div>
                <div>Status</div>
                <div>Last seen</div>
              </div>
            )}
            <div style={{ display: "grid", gap: 8 }}>
              {workers.map((w) => (
                <WorkerRowView key={w.identity} w={w} now={now} phone={phone} />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "grid", gap: 2 }}>
      <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}>
        {label}
      </div>
      <div
        className="mono"
        style={{
          fontSize: "var(--text-lg, 18px)",
          fontWeight: "var(--weight-semibold)",
          color: "var(--ink)",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function WorkerRowView({
  w,
  now,
  phone,
}: {
  w: WorkerRow;
  now: number;
  phone: boolean;
}) {
  if (phone) {
    return (
      <div
        style={{
          border: "1px solid var(--line)",
          borderRadius: "var(--radius-md)",
          background: "var(--card)",
          padding: 12,
          display: "grid",
          gap: 8,
          opacity: w.online ? 1 : 0.6,
        }}
      >
        <div
          style={{ display: "flex", justifyContent: "space-between", gap: 8 }}
        >
          <span
            style={{
              fontWeight: "var(--weight-semibold)",
              color: "var(--ink)",
            }}
          >
            {w.host}
          </span>
          <StatusBadge online={w.online} />
        </div>
        <div
          style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}
          className="mono"
        >
          {w.version} · {w.taskQueue} · {ago(w.lastSeen, now)}
        </div>
        <SlotBar active={w.activeActivities} max={w.maxActivities} />
      </div>
    );
  }
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: COLS,
        gap: 12,
        alignItems: "center",
        padding: "12px",
        border: "1px solid var(--line)",
        borderRadius: "var(--radius-md)",
        background: "var(--card)",
        opacity: w.online ? 1 : 0.6,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontWeight: "var(--weight-semibold)",
            color: "var(--ink)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {w.host}
        </div>
        <div
          className="mono"
          style={{
            fontSize: "var(--text-2xs)",
            color: "var(--ink-3)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={w.identity}
        >
          {w.identity}
        </div>
      </div>
      <div
        className="mono"
        style={{ fontSize: "var(--text-xs)", color: "var(--ink-2)" }}
      >
        {w.version}
      </div>
      <div
        className="mono"
        style={{ fontSize: "var(--text-xs)", color: "var(--ink-2)" }}
      >
        {w.taskQueue}
      </div>
      <SlotBar active={w.activeActivities} max={w.maxActivities} />
      <StatusBadge online={w.online} />
      <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-2)" }}>
        {ago(w.lastSeen, now)}
      </div>
    </div>
  );
}
