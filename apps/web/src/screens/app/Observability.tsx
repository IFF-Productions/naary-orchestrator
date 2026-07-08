/**
 * Observability — real-data analytics for the tenant.
 * Driven by the control plane: recent runs (api.listRuns) + the usage ledger
 * (api.getUsage, tenant-scoped via api.getMe). The ledger stores tokens + cost
 * only, so we surface run counts, token/cost totals, the recent run list, and a
 * per-model usage breakdown — no fabricated latency/error charts or per-run
 * statuses (run status lives in Temporal, only on the run-detail view).
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Icon, ProgressBar } from "../../components";
import {
  api,
  type RunSummary,
  type UsageReport,
  UnauthorizedError,
} from "../../lib/api";
import { RunVolumeChart, SpendChart } from "./charts";

const cardStyle: React.CSSProperties = {
  background: "var(--card)",
  border: "1px solid var(--line)",
  borderRadius: "var(--radius-lg)",
  boxShadow: "var(--shadow-card)",
};

/** Compact relative time from an ISO timestamp (no date lib). */
function ago(iso: string): string {
  const then = new Date(iso).getTime();
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function fmtUsd(n: number): string {
  return `$${n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: n > 0 && n < 1 ? 4 : 2,
  })}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

export function Observability() {
  const navigate = useNavigate();
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [usage, setUsage] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const { tenantId } = await api.getMe();
        const [r, u] = await Promise.all([
          api.listRuns(),
          api.getUsage(tenantId),
        ]);
        if (cancelled) return;
        setRuns(r);
        setUsage(u);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(
          e instanceof UnauthorizedError
            ? "Sign in to view observability."
            : "Could not reach the control plane (apps/api on :3000).",
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const stats = [
    { label: "Recent runs", value: runs ? `${runs.length}` : "—", mono: false },
    {
      label: "Tokens used",
      value: usage ? fmtTokens(usage.totalTokens) : "—",
      mono: true,
    },
    {
      label: "Total cost",
      value: usage ? fmtUsd(usage.totalCostUsd) : "—",
      mono: true,
    },
  ];

  const byModel = usage?.byModel ?? [];
  const maxModelTokens = byModel.reduce(
    (m, r) => Math.max(m, r.totalTokens),
    0,
  );

  return (
    <div style={{ padding: "22px 28px 40px", maxWidth: 1300 }}>
      {/* heading */}
      <div style={{ marginBottom: 18 }}>
        <div
          style={{
            fontSize: "var(--text-title)",
            fontWeight: "var(--weight-bold)",
            color: "var(--ink)",
            letterSpacing: "var(--tracking-tight)",
          }}
        >
          Observability
        </div>
        <div
          style={{
            fontSize: "var(--text-body)",
            color: "var(--ink-2)",
            marginTop: 4,
          }}
        >
          Runs and token/cost usage for your tenant.
        </div>
      </div>

      {error && (
        <div
          style={{
            marginBottom: 16,
            padding: "10px 12px",
            borderRadius: "var(--radius-sm)",
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

      {/* ===== real charts (bucketed from runs + usage) ===== */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 14,
          marginBottom: 16,
        }}
      >
        <RunVolumeChart days={14} />
        <SpendChart days={14} />
      </div>

      {/* ===== stat row ===== */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: 14,
          marginBottom: 16,
        }}
      >
        {stats.map((s) => (
          <div key={s.label} style={{ ...cardStyle, padding: 16 }}>
            <div
              className="mono"
              style={{
                fontSize: "var(--text-2xs)",
                fontWeight: "var(--weight-semibold)",
                letterSpacing: "var(--tracking-label)",
                textTransform: "uppercase",
                color: "var(--ink-3)",
              }}
            >
              {s.label}
            </div>
            <div
              className={s.mono ? "mono" : undefined}
              style={{
                fontSize: "var(--text-xl)",
                fontWeight: "var(--weight-bold)",
                color: "var(--ink)",
                marginTop: 8,
                letterSpacing: "var(--tracking-tight)",
              }}
            >
              {loading ? "…" : s.value}
            </div>
          </div>
        ))}
      </div>

      {/* ===== recent runs + per-model usage ===== */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 16,
        }}
      >
        {/* recent runs */}
        <div style={{ ...cardStyle, overflow: "hidden" }}>
          <div
            style={{
              padding: "16px 18px 12px",
              fontSize: "var(--text-body)",
              fontWeight: "var(--weight-semibold)",
              color: "var(--ink)",
            }}
          >
            Recent runs
          </div>
          <div
            className="mono-label"
            style={{
              display: "grid",
              gridTemplateColumns: "1.6fr 1fr 0.4fr",
              gap: 10,
              padding: "8px 18px",
              borderTop: "1px solid var(--line)",
              borderBottom: "1px solid var(--line)",
            }}
          >
            <span>Run</span>
            <span>Started</span>
            <span />
          </div>

          {loading && (
            <div
              style={{
                padding: 18,
                fontSize: "var(--text-body)",
                color: "var(--ink-3)",
              }}
            >
              Loading…
            </div>
          )}
          {!loading && !error && runs?.length === 0 && (
            <div
              style={{
                padding: 18,
                fontSize: "var(--text-body)",
                color: "var(--ink-3)",
              }}
            >
              No runs yet — start one from the Runs screen.
            </div>
          )}
          {!loading &&
            (runs ?? []).map((r, i, arr) => (
              <div
                key={r.workflowId}
                className="run-row"
                onClick={() =>
                  navigate(`/app/runs/${encodeURIComponent(r.workflowId)}`)
                }
                style={{
                  display: "grid",
                  gridTemplateColumns: "1.6fr 1fr 0.4fr",
                  gap: 10,
                  padding: "12px 18px",
                  borderBottom:
                    i < arr.length - 1 ? "1px solid var(--line)" : undefined,
                  alignItems: "center",
                  cursor: "pointer",
                }}
              >
                <span
                  className="mono"
                  style={{ fontSize: "var(--text-xs)", color: "var(--brand)" }}
                >
                  {r.workflowId}
                </span>
                <span
                  className="mono"
                  style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}
                >
                  {ago(r.createdAt)}
                </span>
                <span style={{ textAlign: "right" }}>
                  <Icon
                    name="chevron-right"
                    size={14}
                    style={{ color: "var(--ink-3)" }}
                  />
                </span>
              </div>
            ))}
        </div>

        {/* per-model usage */}
        <div style={{ ...cardStyle, overflow: "hidden" }}>
          <div
            style={{
              padding: "16px 18px 12px",
              fontSize: "var(--text-body)",
              fontWeight: "var(--weight-semibold)",
              color: "var(--ink)",
            }}
          >
            Usage by model
          </div>
          <div
            className="mono-label"
            style={{
              display: "grid",
              gridTemplateColumns: "2fr 1fr 1fr",
              gap: 10,
              padding: "8px 18px",
              borderTop: "1px solid var(--line)",
              borderBottom: "1px solid var(--line)",
            }}
          >
            <span>Model</span>
            <span>Tokens</span>
            <span>Cost</span>
          </div>

          {loading && (
            <div
              style={{
                padding: 18,
                fontSize: "var(--text-body)",
                color: "var(--ink-3)",
              }}
            >
              Loading…
            </div>
          )}
          {!loading && !error && byModel.length === 0 && (
            <div
              style={{
                padding: 18,
                fontSize: "var(--text-body)",
                color: "var(--ink-3)",
              }}
            >
              No usage recorded yet.
            </div>
          )}
          {!loading &&
            byModel.map((m, i) => (
              <div
                key={m.model}
                style={{
                  display: "grid",
                  gridTemplateColumns: "2fr 1fr 1fr",
                  gap: 10,
                  padding: "12px 18px",
                  borderBottom:
                    i < byModel.length - 1
                      ? "1px solid var(--line)"
                      : undefined,
                  alignItems: "center",
                }}
              >
                <span style={{ minWidth: 0 }}>
                  <span
                    style={{
                      fontSize: "var(--text-body)",
                      color: "var(--ink)",
                      fontWeight: "var(--weight-medium)",
                      display: "block",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {m.model}
                  </span>
                  <div style={{ marginTop: 6 }}>
                    <ProgressBar
                      value={
                        maxModelTokens > 0
                          ? (m.totalTokens / maxModelTokens) * 100
                          : 0
                      }
                    />
                  </div>
                </span>
                <span
                  className="mono"
                  style={{ fontSize: "var(--text-xs)", color: "var(--ink-2)" }}
                >
                  {fmtTokens(m.totalTokens)}
                </span>
                <span
                  className="mono"
                  style={{ fontSize: "var(--text-xs)", color: "var(--ink)" }}
                >
                  {fmtUsd(m.costUsd)}
                </span>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}
