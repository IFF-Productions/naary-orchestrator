/**
 * Spend-over-time stacked bars — stacked BY MODEL (the closest real dimension:
 * the ledger's line items carry provider/model/cost/createdAt; the design's
 * node-category stack has no backing data). Series order + colors are fixed by
 * the shared model ranking so the legend matches the Cost-by-model card.
 * Hover = per-day tooltip with the per-model split.
 */
import { useState } from "react";
import { modelColor, type StackedSpend, usd } from "./billing-model";

const CHART_H = 180;

/** Series color: ranked model → fixed categorical slot; "other" muted; the
 *  single-series fallback ("total") wears the brand ember. */
function seriesColor(key: string, rank: number): string {
  if (key === "other") return "var(--ink-3)";
  if (key === "total") return "var(--brand)";
  return modelColor(rank);
}

export function SpendStackedChart({ stack }: { stack: StackedSpend }) {
  const [hover, setHover] = useState<number | null>(null);
  const { series, days, max } = stack;
  const n = days.length;
  // Show ~6 tick labels along the axis.
  const tickEvery = Math.max(1, Math.ceil(n / 6));
  const hovered = hover !== null ? days[hover] : null;

  if (n === 0 || max <= 0) {
    return (
      <div
        style={{
          height: CHART_H,
          display: "grid",
          placeItems: "center",
          fontSize: "var(--text-sm)",
          color: "var(--ink-3)",
        }}
      >
        No spend in this window.
      </div>
    );
  }

  return (
    <div style={{ position: "relative" }}>
      {/* legend (a single series needs none — the card title names it) */}
      {series.length > 1 && (
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 14,
            flexWrap: "wrap",
            fontSize: "var(--text-xs)",
            color: "var(--ink-faint)",
            marginBottom: 14,
          }}
        >
          {series.map((s, i) => (
            <span
              key={s.key}
              style={{ display: "flex", alignItems: "center", gap: 6 }}
            >
              <span
                aria-hidden
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 3,
                  background: seriesColor(s.key, i),
                }}
              />
              <span className="mono">{s.label}</span>
            </span>
          ))}
        </div>
      )}

      {/* bars */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          gap: n > 45 ? 2 : 5,
          height: CHART_H,
          paddingBottom: 22,
          position: "relative",
        }}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label="daily spend by model"
      >
        <div
          aria-hidden
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: 0,
            borderTop: "1px dashed var(--line-2)",
          }}
        />
        <div
          aria-hidden
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: "50%",
            borderTop: "1px dashed var(--line-mid)",
          }}
        />
        {days.map((d, di) => {
          const hPct = (d.total / max) * 100;
          return (
            <div
              key={d.date}
              onMouseEnter={() => setHover(di)}
              style={{
                flex: 1,
                minWidth: 0,
                display: "flex",
                flexDirection: "column",
                justifyContent: "flex-end",
                height: "100%",
                position: "relative",
                cursor: "default",
                opacity: hover === null || hover === di ? 1 : 0.55,
                transition: "opacity .15s",
              }}
            >
              {d.total > 0 && (
                <div
                  style={{
                    width: "100%",
                    display: "flex",
                    // Segment 0 (top-ranked model) sits at the BASELINE.
                    flexDirection: "column-reverse",
                    borderRadius: "3px 3px 0 0",
                    overflow: "hidden",
                    height: `${Math.max(hPct, 1.5)}%`,
                  }}
                >
                  {d.parts.map((v, si) =>
                    v > 0 ? (
                      <div
                        key={series[si].key}
                        style={{
                          height: `${(v / d.total) * 100}%`,
                          minHeight: 1,
                          background: seriesColor(series[si].key, si),
                          // 2px surface gap between stacked segments.
                          boxSizing: "border-box",
                          borderTop: "2px solid var(--card)",
                        }}
                      />
                    ) : null,
                  )}
                </div>
              )}
              {di % tickEvery === 0 && (
                <span
                  className="mono"
                  style={{
                    position: "absolute",
                    bottom: -20,
                    left: 0,
                    fontSize: 9.5,
                    color: "var(--ink-3)",
                    whiteSpace: "nowrap",
                  }}
                >
                  {d.label}
                </span>
              )}
            </div>
          );
        })}

        {/* tooltip */}
        {hovered && hover !== null && (
          <div
            style={{
              position: "absolute",
              bottom: CHART_H - 16,
              left: `${((hover + 0.5) / n) * 100}%`,
              transform: `translateX(${hover > n * 0.66 ? "-100%" : hover < n * 0.33 ? "0" : "-50%"})`,
              background: "var(--panel)",
              border: "1px solid var(--line-2)",
              borderRadius: 9,
              boxShadow: "var(--shadow-raised)",
              padding: "9px 12px",
              zIndex: 3,
              pointerEvents: "none",
              minWidth: 150,
            }}
          >
            <div
              className="mono"
              style={{
                fontSize: "var(--text-2xs)",
                color: "var(--ink-3)",
                marginBottom: 5,
              }}
            >
              {hovered.label} · {usd(hovered.total)}
            </div>
            {series.map((s, si) =>
              hovered.parts[si] > 0 ? (
                <div
                  key={s.key}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: "var(--text-xs)",
                    color: "var(--ink-2)",
                    lineHeight: 1.7,
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 2,
                      background: seriesColor(s.key, si),
                    }}
                  />
                  <span className="mono" style={{ flex: 1 }}>
                    {s.label}
                  </span>
                  <span className="mono" style={{ color: "var(--ink)" }}>
                    {usd(hovered.parts[si])}
                  </span>
                </div>
              ) : null,
            )}
          </div>
        )}
      </div>
    </div>
  );
}
