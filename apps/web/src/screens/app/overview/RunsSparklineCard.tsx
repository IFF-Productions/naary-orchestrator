/**
 * "Runs · last 24h" — the runs list bucketed into 24 hourly bars (run starts).
 * The most recent hours render in brand ember, earlier hours in the data blue,
 * matching the design comp. Total = runs started in the window.
 */
import { useNavigate } from "react-router-dom";

/** Hours (from the right) drawn in ember; the rest are the data blue. */
const EMBER_HOURS = 4;

export function RunsSparklineCard({
  loading,
  errored,
  buckets,
  total,
}: {
  loading: boolean;
  errored: boolean;
  /** 24 hourly counts, oldest → newest. */
  buckets: number[];
  total: number;
}) {
  const navigate = useNavigate();
  const max = Math.max(1, ...buckets);

  return (
    <div
      className="run-row"
      style={{
        border: "1px solid var(--line-mid)",
        background: "var(--card)",
        borderRadius: 14,
        padding: "16px 18px",
        boxShadow: "var(--shadow-card)",
        cursor: "pointer",
      }}
      onClick={() => navigate("/app/runs")}
      title="View runs"
    >
      <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
        <div
          style={{
            fontSize: "var(--text-body)",
            fontWeight: "var(--weight-bold)",
            color: "var(--ink)",
          }}
        >
          Runs · last 24h
        </div>
        <span
          className="mono"
          style={{
            marginLeft: "auto",
            fontSize: "var(--text-sm)",
            fontWeight: "var(--weight-semibold)",
            color: "var(--ink-soft)",
          }}
        >
          {loading ? "…" : errored ? "—" : total.toLocaleString()}
        </span>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          gap: 3,
          height: 56,
        }}
      >
        {buckets.map((v, i) => {
          const ember = i >= buckets.length - EMBER_HOURS;
          const h = v > 0 ? Math.max(4, Math.round((v / max) * 100)) : 0;
          return (
            <div
              // eslint-disable-next-line react/no-array-index-key -- fixed 24 hourly slots
              key={i}
              title={`${v} run${v === 1 ? "" : "s"}`}
              style={{
                flex: 1,
                borderRadius: "2px 2px 0 0",
                height: v > 0 ? `${h}%` : 2,
                background:
                  v > 0
                    ? ember
                      ? "var(--brand)"
                      : "var(--state-info)"
                    : "var(--line-mid)",
                animation: "ovGrowBar .5s ease",
              }}
            />
          );
        })}
      </div>
      <div
        className="mono"
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginTop: 7,
          fontSize: "var(--text-2xs)",
          color: "var(--ink-3)",
        }}
      >
        <span>24h ago</span>
        <span>now</span>
      </div>
    </div>
  );
}
