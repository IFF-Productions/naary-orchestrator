/**
 * Status hero for the redesigned Run Detail screen. Paused-on-approval runs get
 * the calm amber card with decide-in-place Approve & resume / Reject (durable
 * waiting must NEVER read as an error); paused-on-webhook keeps the resume-URL
 * affordance; running = ember spinner; completed = green; failed/rejected = red.
 * Every fact rendered (node, since-time, age, timeout, cost) is real run data —
 * anything unknown is simply omitted.
 */
import { useState } from "react";
import { Button, Icon } from "../../../components";
import { runStatusUi } from "../../../lib/run-status";
import { fmtAge, fmtWhen } from "./run-view-model";

/** Approval-node config facts the hero may show — only what the config has.
 *  Mirrors ApprovalNodeConfig (@naary/dsl) — the run-detail casts the paused
 *  gate's config to this, so every rendered fact is real graph data. */
export interface ApprovalInfo {
  title?: string;
  instructions?: string;
  timeoutHours?: number;
  /** Slice 1 routing: who may decide (emails and/or permission-group ids). */
  approvers?: { emails?: string[]; groupIds?: string[] };
  /** Display-only SLA (due = pause + slaHours). */
  slaHours?: number;
  remindAfterHours?: number[];
  escalateAfterHours?: number;
  escalateTo?: string;
}

export interface StatusHeroProps {
  status: string;
  /** Display label of the node the run is on (null = unknown). */
  currentNodeLabel: string | null;
  /** When the run went idle (last history event) — the "since" anchor. */
  sinceIso: string | null;
  approval?: ApprovalInfo | null;
  acting: boolean;
  onDecide: (approved: boolean) => void;
  /** awaiting_webhook: the signed resume URL (null while loading). */
  resumeUrl?: string | null;
  /** Failed runs: the failure detail the history recorded. */
  errorDetail?: string | null;
  executedCount: number;
  totalCount: number;
}

function HeroShell({
  color,
  soft,
  children,
}: {
  color: string;
  soft: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        border: `1px solid color-mix(in srgb, ${color} 55%, transparent)`,
        background: `linear-gradient(120deg, ${soft}, var(--panel))`,
        borderRadius: "var(--radius-xl)",
        padding: "20px 22px",
        position: "relative",
        overflow: "hidden",
      }}
    >
      {children}
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontSize: "var(--text-xs)",
        color: "var(--ink-2)",
        border: "1px solid var(--line-2)",
        borderRadius: "var(--radius-pill)",
        padding: "5px 11px",
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
      }}
    >
      {children}
    </span>
  );
}

/** Amber clock tile with the expanding ping ring. */
function WaitTile() {
  return (
    <span
      style={{
        width: 46,
        height: 46,
        flex: "none",
        borderRadius: 12,
        border: "1px solid var(--state-paused)",
        color: "var(--state-paused)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        position: "relative",
      }}
    >
      <span
        style={{
          position: "absolute",
          inset: -1,
          borderRadius: 12,
          background: "var(--state-paused)",
          opacity: 0.18,
          animation: "rdPing 1.8s ease-out infinite",
          pointerEvents: "none",
        }}
      />
      <Icon name="clock" size={22} />
    </span>
  );
}

const DURABLE_COPY =
  "The run is durable — it resumes the instant a decision arrives, even across a redeploy.";

export function StatusHero(props: StatusHeroProps) {
  const { status } = props;
  if (status === "awaiting_approval") return <ApprovalHero {...props} />;
  if (status === "awaiting_webhook") return <WebhookHero {...props} />;
  if (status === "running") return <RunningHero {...props} />;
  if (status === "completed") return <CompletedHero {...props} />;
  return <ClosedHero {...props} />;
}

/* ---------------- Paused — waiting on approval (the hero state) ---------------- */

function ApprovalHero({
  currentNodeLabel,
  sinceIso,
  approval,
  acting,
  onDecide,
}: StatusHeroProps) {
  const age = sinceIso
    ? fmtAge(Date.now() - new Date(sinceIso).getTime())
    : null;
  // Slice 1 routing facts, straight from the gate's config (real graph data).
  const approverParts = [
    ...(approval?.approvers?.emails ?? []),
    ...(approval?.approvers?.groupIds ?? []).map((g) => `@${g}`),
  ];
  const approvers = approverParts.length > 0 ? approverParts.join(", ") : null;
  // Real due-by when the gate has an SLA and we know when it paused.
  const dueMs =
    approval?.slaHours && sinceIso
      ? new Date(sinceIso).getTime() + approval.slaHours * 3_600_000
      : null;
  const slaChip = dueMs
    ? dueMs < Date.now()
      ? { label: `SLA breached ${fmtAge(Date.now() - dueMs)} ago`, bad: true }
      : { label: `due in ${fmtAge(dueMs - Date.now())}`, bad: false }
    : null;
  return (
    <HeroShell color="var(--state-paused)" soft="var(--paused-soft)">
      <div style={{ display: "flex", alignItems: "flex-start", gap: 16 }}>
        <WaitTile />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 18,
              fontWeight: "var(--weight-bold)",
              color: "var(--ink)",
              letterSpacing: "var(--tracking-tight)",
            }}
          >
            Paused — waiting on approval
          </div>
          <div
            style={{
              fontSize: "var(--text-body)",
              color: "var(--ink-2)",
              marginTop: 5,
              lineHeight: "var(--leading-body)",
            }}
          >
            Suspended at{" "}
            <strong style={{ color: "var(--ink-soft)", fontWeight: 600 }}>
              {currentNodeLabel ?? "the approval gate"}
            </strong>
            {sinceIso && (
              <>
                {" "}
                since{" "}
                <strong
                  style={{ color: "var(--state-paused)", fontWeight: 600 }}
                >
                  {fmtWhen(sinceIso)}
                </strong>
                {age && (
                  <>
                    {" "}
                    ·{" "}
                    <strong
                      style={{ color: "var(--state-paused)", fontWeight: 600 }}
                    >
                      {age} ago
                    </strong>
                  </>
                )}
              </>
            )}
            . {DURABLE_COPY}
          </div>
          {(approval?.title || approval?.instructions) && (
            <div
              style={{
                marginTop: 11,
                padding: "9px 12px",
                borderLeft: "2px solid var(--state-paused)",
                background: "color-mix(in srgb, var(--card) 60%, transparent)",
                borderRadius: "0 8px 8px 0",
                fontSize: "var(--text-sm)",
                color: "var(--ink-soft)",
              }}
            >
              {approval.title && (
                <div style={{ fontWeight: "var(--weight-semibold)" }}>
                  {approval.title}
                </div>
              )}
              {approval.instructions && (
                <div style={{ color: "var(--ink-2)", marginTop: 3 }}>
                  {approval.instructions}
                </div>
              )}
            </div>
          )}
          <div
            style={{ display: "flex", gap: 9, flexWrap: "wrap", marginTop: 13 }}
          >
            {age && (
              <Chip>
                <Icon name="clock" size={12} />
                waiting{" "}
                <span style={{ color: "var(--state-paused)" }}>{age}</span>
              </Chip>
            )}
            {slaChip && (
              <Chip>
                <Icon name="clock" size={12} />
                <span
                  style={{
                    color: slaChip.bad
                      ? "var(--state-error)"
                      : "var(--state-paused)",
                  }}
                >
                  {slaChip.label}
                </span>
              </Chip>
            )}
            {!slaChip && approval?.slaHours !== undefined && (
              <Chip>SLA {approval.slaHours}h</Chip>
            )}
            {approvers && (
              <Chip>
                Approvers:{" "}
                <span style={{ color: "var(--ink-soft)" }}>{approvers}</span>
              </Chip>
            )}
            {approval?.escalateAfterHours !== undefined && (
              <Chip>
                Escalates after {approval.escalateAfterHours}h
                {approval.escalateTo ? (
                  <span style={{ color: "var(--ink-soft)" }}>
                    → {approval.escalateTo}
                  </span>
                ) : null}
              </Chip>
            )}
            {approval?.timeoutHours !== undefined && (
              <Chip>Approval timeout: {approval.timeoutHours}h</Chip>
            )}
          </div>
          <div
            style={{
              display: "flex",
              gap: 10,
              marginTop: 16,
              flexWrap: "wrap",
            }}
          >
            <Button
              variant="positive"
              icon="check"
              disabled={acting}
              onClick={() => onDecide(true)}
            >
              Approve &amp; resume
            </Button>
            <Button
              variant="danger"
              disabled={acting}
              onClick={() => onDecide(false)}
            >
              Reject
            </Button>
          </div>
        </div>
      </div>
    </HeroShell>
  );
}

/* ---------------- Paused — waiting for a webhook (keeps the resume-URL flow) ---------------- */

function WebhookHero({
  currentNodeLabel,
  sinceIso,
  resumeUrl,
}: StatusHeroProps) {
  const [copied, setCopied] = useState(false);
  const age = sinceIso
    ? fmtAge(Date.now() - new Date(sinceIso).getTime())
    : null;
  return (
    <HeroShell color="var(--state-paused)" soft="var(--paused-soft)">
      <div style={{ display: "flex", alignItems: "flex-start", gap: 16 }}>
        <WaitTile />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 18,
              fontWeight: "var(--weight-bold)",
              color: "var(--ink)",
              letterSpacing: "var(--tracking-tight)",
            }}
          >
            Paused — waiting for a webhook
          </div>
          <div
            style={{
              fontSize: "var(--text-body)",
              color: "var(--ink-2)",
              marginTop: 5,
              lineHeight: "var(--leading-body)",
            }}
          >
            Suspended at{" "}
            <strong style={{ color: "var(--ink-soft)", fontWeight: 600 }}>
              {currentNodeLabel ?? "a wait step"}
            </strong>
            {sinceIso && (
              <>
                {" "}
                since{" "}
                <strong
                  style={{ color: "var(--state-paused)", fontWeight: 600 }}
                >
                  {fmtWhen(sinceIso)}
                </strong>
                {age ? ` · ${age} ago` : ""}
              </>
            )}
            . It resumes when an external system POSTs to its resume URL — the
            URL carries a signed token, so treat it like a secret.{" "}
            {DURABLE_COPY}
          </div>
          <div
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              marginTop: 13,
            }}
          >
            <code
              className="mono"
              style={{
                flex: 1,
                minWidth: 0,
                overflowX: "auto",
                whiteSpace: "nowrap",
                fontSize: "var(--text-xs)",
                background: "var(--surface)",
                border: "1px solid var(--line)",
                borderRadius: "var(--radius-xs)",
                padding: "8px 10px",
                color: "var(--ink)",
              }}
            >
              {resumeUrl ?? "Loading resume URL…"}
            </code>
            <Button
              variant="secondary"
              icon={copied ? "check" : "copy"}
              disabled={!resumeUrl}
              onClick={() => {
                if (!resumeUrl) return;
                void navigator.clipboard?.writeText(resumeUrl);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
      </div>
    </HeroShell>
  );
}

/* ---------------- Running (ember) ---------------- */

function RunningHero({ currentNodeLabel }: StatusHeroProps) {
  return (
    <HeroShell color="var(--brand)" soft="var(--brand-soft)">
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <span
          style={{
            width: 22,
            height: 22,
            flex: "none",
            border:
              "3px solid color-mix(in srgb, var(--brand) 25%, transparent)",
            borderTopColor: "var(--brand)",
            borderRadius: "50%",
            display: "inline-block",
            animation: "naarySpin .7s linear infinite",
          }}
        />
        <div>
          <div
            style={{
              fontSize: 16,
              fontWeight: "var(--weight-bold)",
              color: "var(--ink)",
            }}
          >
            Running
          </div>
          <div
            style={{
              fontSize: "var(--text-sm)",
              color: "var(--ink-2)",
              marginTop: 3,
            }}
          >
            {currentNodeLabel ? (
              <>
                Executing{" "}
                <strong style={{ color: "var(--ink-soft)", fontWeight: 600 }}>
                  {currentNodeLabel}
                </strong>{" "}
                —{" "}
              </>
            ) : null}
            this view polls live · state is checkpointed after every step.
          </div>
        </div>
      </div>
    </HeroShell>
  );
}

/* ---------------- Completed (green) ---------------- */

function CompletedHero({ executedCount, totalCount }: StatusHeroProps) {
  return (
    <HeroShell color="var(--state-done)" soft="var(--done-soft)">
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <span
          style={{
            width: 40,
            height: 40,
            flex: "none",
            borderRadius: 11,
            background: "var(--state-done)",
            color: "#04120b",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name="check" size={20} strokeWidth={2.6} />
        </span>
        <div>
          <div
            style={{
              fontSize: 16,
              fontWeight: "var(--weight-bold)",
              color: "var(--ink)",
            }}
          >
            Run completed
          </div>
          <div
            style={{
              fontSize: "var(--text-sm)",
              color: "var(--ink-2)",
              marginTop: 3,
            }}
          >
            {totalCount > 0
              ? `${executedCount} of ${totalCount} steps ran · `
              : ""}
            durable record kept — every step below is replayable history.
          </div>
        </div>
      </div>
    </HeroShell>
  );
}

/* ---------------- Rejected / failed / other close reasons (red) ---------------- */

function ClosedHero({
  status,
  currentNodeLabel,
  errorDetail,
}: StatusHeroProps) {
  const ui = runStatusUi(status);
  const grey = ui.state === "idle";
  const color = grey ? "var(--state-idle)" : "var(--state-error)";
  const soft = grey ? "var(--idle-soft)" : "var(--error-soft)";
  const copy =
    status === "rejected"
      ? "Stopped at the approval gate — no downstream steps ran."
      : status === "canceled" || status === "terminated"
        ? "The run was stopped before it finished."
        : status === "budget_exceeded"
          ? "Stopped because it hit its budget cap — no further spend."
          : (errorDetail ??
            (currentNodeLabel
              ? `Stopped at ${currentNodeLabel}.`
              : "The run did not finish."));
  return (
    <HeroShell color={color} soft={soft}>
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <span
          style={{
            width: 40,
            height: 40,
            flex: "none",
            borderRadius: 11,
            border: `1px solid color-mix(in srgb, ${color} 60%, transparent)`,
            color,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name={grey ? "info" : "x"} size={20} strokeWidth={2.2} />
        </span>
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: 16,
              fontWeight: "var(--weight-bold)",
              color: "var(--ink)",
            }}
          >
            Run {ui.label.toLowerCase()}
          </div>
          <div
            style={{
              fontSize: "var(--text-sm)",
              color: "var(--ink-2)",
              marginTop: 3,
              overflowWrap: "anywhere",
            }}
          >
            {copy}
          </div>
        </div>
      </div>
    </HeroShell>
  );
}
