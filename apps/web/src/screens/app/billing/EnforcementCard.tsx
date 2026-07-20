/**
 * Enforcement policy card — the ladder Naary actually applies, straight from the
 * persisted budget config: an optional ALERT rung (alertThresholdPct — a real
 * server-side notification, shown only when configured), ONE monthly rung at
 * 100% (reject, downgrade, or pause), plus the two per-run guards (per-execution
 * cap, step limit). A rung glows when live spend has crossed it.
 */
import type { BudgetView } from "../../../lib/api";
import { Button, Card } from "../../../components";
import { ALERT_PCT, enforcementLadder, type LadderRung } from "./billing-model";

const TONE = {
  warn: {
    fg: "var(--state-paused)",
    bg: "var(--paused-soft)",
    bd: "var(--state-paused)",
  },
  bad: {
    fg: "var(--state-error)",
    bg: "var(--error-soft)",
    bd: "var(--state-error)",
  },
  neutral: {
    fg: "var(--ink-2)",
    bg: "var(--card-2)",
    bd: "var(--line-2)",
  },
} as const;

function Rung({ rung }: { rung: LadderRung }) {
  const tone = TONE[rung.tone];
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        border: `1px solid ${rung.active ? tone.bd : "var(--line-mid)"}`,
        background: rung.active ? tone.bg : "var(--card)",
        borderRadius: 10,
        padding: "11px 13px",
      }}
    >
      <span
        className="mono"
        style={{
          fontSize: "var(--text-xs)",
          fontWeight: "var(--weight-bold)",
          color: tone.fg,
          background: tone.bg,
          border: `1px solid ${tone.bd}`,
          borderRadius: 7,
          padding: "4px 8px",
          flex: "none",
          minWidth: 44,
          textAlign: "center",
        }}
      >
        {rung.at}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: "var(--text-sm)",
            fontWeight: "var(--weight-semibold)",
            color: "var(--ink)",
          }}
        >
          {rung.title}
        </div>
        <div
          style={{
            fontSize: "var(--text-xs)",
            color: "var(--ink-faint)",
            marginTop: 1,
            lineHeight: 1.45,
          }}
        >
          {rung.desc}
        </div>
      </div>
      {rung.active && (
        <span
          title="Spend has crossed this rung"
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: "var(--brand)",
            boxShadow: "0 0 8px var(--brand)",
            flex: "none",
          }}
        />
      )}
    </div>
  );
}

export function EnforcementCard({
  budget,
  pct,
  onEdit,
}: {
  budget: BudgetView | null;
  /** Monthly spend as % of cap (0 when no budget). */
  pct: number;
  onEdit: () => void;
}) {
  return (
    <Card pad={false} style={{ padding: "22px 24px" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: "var(--text-body)",
              fontWeight: "var(--weight-bold)",
              color: "var(--ink)",
            }}
          >
            Enforcement policy
          </div>
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-faint)",
              marginTop: 3,
              lineHeight: 1.5,
            }}
          >
            What Naary does as spend approaches the cap. Applied live, per run.
          </div>
        </div>
        <Button size="sm" onClick={onEdit}>
          {budget ? "Edit policy" : "Set budget"}
        </Button>
      </div>

      {budget ? (
        <>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 9,
              marginTop: 16,
            }}
          >
            {enforcementLadder(budget, pct).map((rung) => (
              <Rung key={rung.title} rung={rung} />
            ))}
          </div>
          {/* The disclaimer only applies while NO server-side alert exists; once
              alertThresholdPct is configured the ladder's Alert rung replaces it. */}
          {budget.alertThresholdPct == null && (
            <div
              style={{
                marginTop: 14,
                paddingTop: 14,
                borderTop: "1px solid var(--line)",
                fontSize: "var(--text-xs)",
                color: "var(--ink-faint)",
                lineHeight: 1.5,
              }}
            >
              The {ALERT_PCT}% marker on the meter is a dashboard threshold — no
              server-side spend alert is configured; enforcement applies at the
              rungs above.
            </div>
          )}
        </>
      ) : (
        <div
          style={{
            marginTop: 16,
            fontSize: "var(--text-sm)",
            color: "var(--ink-2)",
            lineHeight: 1.6,
          }}
        >
          No policy yet. Setting a budget adds a monthly cap (reject or
          downgrade at 100%), a per-run cap, and a step limit per run.
        </div>
      )}
    </Card>
  );
}
