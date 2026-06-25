/**
 * Observability — latency / cost / error-rate analytics (last 7 days).
 * All chart numbers are illustrative and defined locally (mock.ts is not edited).
 */

interface Stat {
  label: string;
  value: string;
  unit: string;
  delta: string;
  /** literal arrow + semantic color, matching the DC (down latency = good/green). */
  arrow: "up" | "down";
  good: boolean;
}

const stats: Stat[] = [
  {
    label: "p95 latency",
    value: "2.4",
    unit: "s",
    delta: "0.3s vs last week",
    arrow: "down",
    good: true,
  },
  {
    label: "Error rate",
    value: "1.3",
    unit: "%",
    delta: "0.2% vs last week",
    arrow: "up",
    good: false,
  },
  {
    label: "Throughput",
    value: "29.1",
    unit: "k runs",
    delta: "8% vs last week",
    arrow: "up",
    good: true,
  },
];

interface ExpensiveRow {
  wf: string;
  runs: string;
  avg: string;
  total: string;
}

const expensive: ExpensiveRow[] = [
  { wf: "Lead enrichment", runs: "880", avg: "$0.082", total: "$72.16" },
  { wf: "Support router", runs: "2,310", avg: "$0.024", total: "$55.44" },
  { wf: "Invoice extraction", runs: "412", avg: "$0.031", total: "$12.77" },
];

const cardStyle: React.CSSProperties = {
  background: "var(--card)",
  border: "1px solid var(--line)",
  borderRadius: 12,
  boxShadow: "var(--shadow-card)",
};

export function Observability() {
  return (
    <div style={{ padding: "22px 28px 40px", maxWidth: 1300 }}>
      {/* heading */}
      <div style={{ marginBottom: 18 }}>
        <div
          style={{
            fontSize: 21,
            fontWeight: 700,
            color: "var(--ink)",
            letterSpacing: "-0.01em",
          }}
        >
          Observability
        </div>
        <div style={{ fontSize: 12.5, color: "var(--ink-2)", marginTop: 2 }}>
          Latency, cost and error-rate analytics · last 7 days.
        </div>
      </div>

      {/* ===== stat row ===== */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3,1fr)",
          gap: 14,
          marginBottom: 16,
        }}
      >
        {stats.map((s) => (
          <div key={s.label} style={{ ...cardStyle, padding: 16 }}>
            <div style={{ fontSize: 12, color: "var(--ink-2)" }}>{s.label}</div>
            <div
              style={{
                fontSize: 26,
                fontWeight: 700,
                color: "var(--ink)",
                marginTop: 6,
              }}
            >
              {s.value}
              <span style={{ fontSize: 15, color: "var(--ink-2)" }}>
                {s.unit}
              </span>
            </div>
            <div
              className="mono"
              style={{
                fontSize: 10.5,
                color: s.good ? "var(--state-done)" : "var(--state-error)",
                marginTop: 4,
              }}
            >
              {s.arrow === "down" ? "▼" : "▲"} {s.delta}
            </div>
          </div>
        ))}
      </div>

      {/* ===== latency + error charts ===== */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 16,
          marginBottom: 16,
        }}
      >
        <div style={{ ...cardStyle, padding: 18 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: "var(--ink)",
              marginBottom: 14,
            }}
          >
            Latency (p50 / p95)
          </div>
          <svg
            width="100%"
            height={150}
            viewBox="0 0 560 150"
            preserveAspectRatio="none"
            style={{ display: "block", overflow: "visible" }}
          >
            <defs>
              <linearGradient id="obs-lat" x1="0" y1="0" x2="0" y2="1">
                <stop
                  offset="0"
                  stopColor="var(--state-info)"
                  stopOpacity={0.25}
                />
                <stop
                  offset="1"
                  stopColor="var(--state-info)"
                  stopOpacity={0}
                />
              </linearGradient>
            </defs>
            <line x1="0" y1="50" x2="560" y2="50" stroke="var(--line)" />
            <line x1="0" y1="100" x2="560" y2="100" stroke="var(--line)" />
            <path
              d="M0 110 L80 95 L160 105 L240 80 L320 88 L400 70 L480 78 L560 60 L560 150 L0 150Z"
              fill="url(#obs-lat)"
            />
            <polyline
              points="0,110 80,95 160,105 240,80 320,88 400,70 480,78 560,60"
              fill="none"
              stroke="var(--state-info)"
              strokeWidth={2}
            />
            <polyline
              points="0,128 80,120 160,124 240,112 320,116 400,108 480,112 560,104"
              fill="none"
              stroke="var(--ink-3)"
              strokeWidth={1.6}
              strokeDasharray="4 4"
            />
          </svg>
        </div>

        <div style={{ ...cardStyle, padding: 18 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: "var(--ink)",
              marginBottom: 14,
            }}
          >
            Error rate
          </div>
          <svg
            width="100%"
            height={150}
            viewBox="0 0 560 150"
            preserveAspectRatio="none"
            style={{ display: "block", overflow: "visible" }}
          >
            <defs>
              <linearGradient id="obs-err" x1="0" y1="0" x2="0" y2="1">
                <stop
                  offset="0"
                  stopColor="var(--state-error)"
                  stopOpacity={0.25}
                />
                <stop
                  offset="1"
                  stopColor="var(--state-error)"
                  stopOpacity={0}
                />
              </linearGradient>
            </defs>
            <line x1="0" y1="50" x2="560" y2="50" stroke="var(--line)" />
            <line x1="0" y1="100" x2="560" y2="100" stroke="var(--line)" />
            <path
              d="M0 130 L80 125 L160 132 L240 120 L320 100 L400 118 L480 110 L560 122 L560 150 L0 150Z"
              fill="url(#obs-err)"
            />
            <polyline
              points="0,130 80,125 160,132 240,120 320,100 400,118 480,110 560,122"
              fill="none"
              stroke="var(--state-error)"
              strokeWidth={2}
            />
          </svg>
        </div>
      </div>

      {/* ===== most expensive workflows ===== */}
      <div style={{ ...cardStyle, overflow: "hidden" }}>
        <div
          style={{
            padding: "15px 18px 11px",
            fontSize: 13,
            fontWeight: 600,
            color: "var(--ink)",
          }}
        >
          Most expensive workflows
        </div>
        <div
          className="mono"
          style={{
            display: "grid",
            gridTemplateColumns: "2fr 1fr 1fr 1fr",
            gap: 10,
            padding: "9px 18px",
            borderTop: "1px solid var(--line)",
            borderBottom: "1px solid var(--line)",
            fontSize: 9.5,
            fontWeight: 600,
            letterSpacing: "0.08em",
            color: "var(--ink-3)",
            textTransform: "uppercase",
          }}
        >
          <span>Workflow</span>
          <span>Runs</span>
          <span>Avg cost</span>
          <span>Total</span>
        </div>
        {expensive.map((r, i) => (
          <div
            key={r.wf}
            style={{
              display: "grid",
              gridTemplateColumns: "2fr 1fr 1fr 1fr",
              gap: 10,
              padding: "12px 18px",
              borderBottom:
                i < expensive.length - 1 ? "1px solid var(--line)" : undefined,
              alignItems: "center",
            }}
          >
            <span
              style={{ fontSize: 12.5, color: "var(--ink)", fontWeight: 500 }}
            >
              {r.wf}
            </span>
            <span
              className="mono"
              style={{ fontSize: 11.5, color: "var(--ink-2)" }}
            >
              {r.runs}
            </span>
            <span
              className="mono"
              style={{ fontSize: 11.5, color: "var(--ink-2)" }}
            >
              {r.avg}
            </span>
            <span
              className="mono"
              style={{ fontSize: 11.5, color: "var(--ink)" }}
            >
              {r.total}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
