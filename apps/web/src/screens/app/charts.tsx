/**
 * Real dashboard charts — self-contained: each fetches its own data, buckets it by
 * day (lib/timeseries), and renders inline SVG bars. No chart lib, no new backend.
 * RunVolumeChart ← GET /executions; SpendChart ← GET /tenants/:id/usage events.
 */
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { type Bucket, bucketByDay } from "../../lib/timeseries";

function DayBars({
  buckets,
  color,
  format,
}: {
  buckets: Bucket[];
  color: string;
  format: (v: number) => string;
}) {
  const max = Math.max(1, ...buckets.map((b) => b.value));
  const W = 100 / buckets.length;
  return (
    <svg
      width="100%"
      height="120"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      style={{ display: "block" }}
      role="img"
      aria-label="daily chart"
    >
      {buckets.map((b, i) => {
        const h = (b.value / max) * 92;
        return (
          <rect
            key={b.day}
            x={i * W + W * 0.15}
            y={100 - h}
            width={W * 0.7}
            height={Math.max(h, b.value > 0 ? 1.5 : 0)}
            rx={0.6}
            fill={color}
            opacity={b.value > 0 ? 0.9 : 0.18}
          >
            <title>{`${b.label}: ${format(b.value)}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

function ChartCard({
  title,
  total,
  children,
}: {
  title: string;
  total: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        background: "var(--card)",
        border: "1px solid var(--line)",
        borderRadius: 11,
        padding: 16,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          marginBottom: 10,
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600 }}>{title}</span>
        <span style={{ fontSize: 12, color: "var(--ink-2)" }}>{total}</span>
      </div>
      {children}
    </div>
  );
}

export function RunVolumeChart({ days = 14 }: { days?: number }) {
  const [buckets, setBuckets] = useState<Bucket[] | null>(null);
  useEffect(() => {
    let live = true;
    api
      .listRuns()
      .then((runs) => {
        if (live)
          setBuckets(
            bucketByDay(
              runs.map((r) => ({ at: r.createdAt })),
              days,
              Date.now(),
            ),
          );
      })
      .catch(() => live && setBuckets([]));
    return () => {
      live = false;
    };
  }, [days]);

  const total = buckets?.reduce((s, b) => s + b.value, 0) ?? 0;
  return (
    <ChartCard title={`Runs · last ${days} days`} total={`${total} total`}>
      {buckets ? (
        <DayBars
          buckets={buckets}
          color="var(--brand)"
          format={(v) => `${v} run${v === 1 ? "" : "s"}`}
        />
      ) : (
        <Placeholder />
      )}
    </ChartCard>
  );
}

export function SpendChart({ days = 14 }: { days?: number }) {
  const [buckets, setBuckets] = useState<Bucket[] | null>(null);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const { tenantId } = await api.getMe();
        const usage = await api.getUsage(tenantId);
        const events = (usage.events ?? []) as {
          createdAt?: string;
          costUsd?: number;
        }[];
        if (live)
          setBuckets(
            bucketByDay(
              events
                .filter((e) => e.createdAt)
                .map((e) => ({
                  at: e.createdAt as string,
                  value: e.costUsd ?? 0,
                })),
              days,
              Date.now(),
            ),
          );
      } catch {
        if (live) setBuckets([]);
      }
    })();
    return () => {
      live = false;
    };
  }, [days]);

  const total = buckets?.reduce((s, b) => s + b.value, 0) ?? 0;
  return (
    <ChartCard
      title={`Spend · last ${days} days`}
      total={`$${total.toFixed(4)}`}
    >
      {buckets ? (
        <DayBars
          buckets={buckets}
          color="var(--state-done)"
          format={(v) => `$${v.toFixed(4)}`}
        />
      ) : (
        <Placeholder />
      )}
    </ChartCard>
  );
}

function Placeholder() {
  return (
    <div style={{ height: 120, display: "grid", placeItems: "center" }}>
      <span style={{ fontSize: 12, color: "var(--ink-3)" }}>Loading…</span>
    </div>
  );
}
