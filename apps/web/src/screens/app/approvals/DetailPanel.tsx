import { Button, Icon } from "../../../components";
import type { AwaitingApproval } from "../../../lib/api";
import { parseContextFields, toneColors, type WaitingInfo } from "./urgency";

/** Uppercase mono section caption (design: 10.5px / .1em / mono). */
function MonoLabel({ children }: { children: string }) {
  return (
    <div
      style={{
        fontSize: 10.5,
        letterSpacing: ".1em",
        textTransform: "uppercase",
        color: "var(--ink-faint)",
        fontFamily: "var(--font-mono)",
        fontWeight: "var(--weight-semibold)",
        marginBottom: 10,
      }}
    >
      {children}
    </div>
  );
}

/**
 * Right-hand detail panel: full context for the focused request + the
 * decide-in-place box (optional audit comment · Approve / Reject).
 * Renders only honest data — the fields card comes from the gate's REAL
 * pause-time contextFields (Slice 1) when present (legacy JSON-instructions
 * fallback otherwise), and the Routing section appears only when the gate
 * actually names approvers / an escalation.
 */
export function DetailPanel({
  item,
  waiting,
  simple,
  comment,
  onCommentChange,
  onDecide,
  onOpenRun,
  onRemind,
  remindBusy,
  disabled,
  busy,
}: {
  item: AwaitingApproval;
  waiting: WaitingInfo;
  simple: boolean;
  comment: string;
  onCommentChange: (v: string) => void;
  onDecide: (approved: boolean) => void;
  onOpenRun: () => void;
  /** Manual "Remind now" — re-fires the approval notification. */
  onRemind?: () => void;
  remindBusy?: boolean;
  disabled: boolean;
  /** A decision for THIS item is in flight. */
  busy: boolean;
}) {
  const tone = toneColors(waiting.tone);
  // Prefer the REAL pause-time context fields; fall back to the legacy
  // JSON-shaped-instructions derivation for older gates.
  const contextEntries = item.contextFields
    ? Object.entries(item.contextFields).map(([k, v]) => ({ k, v }))
    : null;
  const legacyFields = parseContextFields(item.instructions);
  const fields =
    contextEntries && contextEntries.length > 0 ? contextEntries : legacyFields;
  // Prose instructions render unless the instructions THEMSELVES became the card.
  const instructionsAsProse =
    !!item.instructions && !(fields !== null && fields === legacyFields);
  const hasRouting =
    (item.approvers &&
      (item.approvers.emails.length > 0 || item.approvers.groups.length > 0)) ||
    item.escalateTo ||
    item.escalateAfterHours != null;
  const noun = simple ? "automation" : "workflow";

  return (
    <div>
      {/* header */}
      <div
        style={{
          padding: "20px 22px 16px",
          borderBottom: "1px solid var(--line)",
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
          <span
            style={{
              width: 40,
              height: 40,
              flex: "none",
              borderRadius: 10,
              border:
                "1px solid color-mix(in srgb, var(--node-approval) 55%, transparent)",
              color: "var(--node-approval)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Icon name="approval" size={19} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 15,
                fontWeight: "var(--weight-bold)",
                lineHeight: 1.25,
                color: "var(--ink)",
              }}
            >
              {item.title}
            </div>
            <div
              style={{
                fontSize: 11.5,
                color: "var(--ink-faint)",
                marginTop: 3,
              }}
            >
              {item.workflowKey ?? noun} ·{" "}
              <span style={{ fontFamily: "var(--font-mono)" }}>
                {item.workflowId}
              </span>
            </div>
          </div>
        </div>
        {/* waiting-age banner (tone-colored per urgency) */}
        <div
          style={{
            marginTop: 14,
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: "var(--text-sm)",
            fontWeight: "var(--weight-medium)",
            borderRadius: "var(--radius-md)",
            padding: "9px 12px",
            color: tone.fg,
            background: tone.bg,
            border: `1px solid ${tone.bd}`,
          }}
        >
          <Icon name="clock" size={14} style={{ flex: "none" }} />
          <span>{waiting.banner}</span>
        </div>
      </div>

      {/* context */}
      <div style={{ padding: "18px 22px" }}>
        <MonoLabel>What you're approving</MonoLabel>
        {instructionsAsProse && (
          <div
            style={{
              fontSize: "var(--text-body)",
              color: "var(--ink-soft)",
              lineHeight: 1.6,
              marginBottom: 14,
              whiteSpace: "pre-wrap",
            }}
          >
            {item.instructions}
          </div>
        )}
        {!item.instructions && !fields && (
          <div
            style={{
              fontSize: "var(--text-body)",
              color: "var(--ink-2)",
              lineHeight: 1.6,
              marginBottom: 14,
            }}
          >
            This gate didn't include instructions — open the run below for the
            full picture before deciding.
          </div>
        )}
        {fields && (
          <div
            style={{
              border: "1px solid var(--line-mid)",
              background: "var(--card)",
              borderRadius: 11,
              overflow: "hidden",
              marginBottom: 2,
            }}
          >
            {fields.map((f, i) => (
              <div
                key={f.k}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "10px 14px",
                  borderBottom:
                    i < fields.length - 1 ? "1px solid var(--line)" : "none",
                }}
              >
                <span
                  style={{
                    fontSize: 11.5,
                    color: "var(--ink-faint)",
                    width: 120,
                    flex: "none",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {f.k}
                </span>
                <span
                  style={{
                    fontSize: 12.5,
                    color: "var(--ink)",
                    fontWeight: "var(--weight-medium)",
                    fontFamily: "var(--font-mono)",
                    overflowWrap: "anywhere",
                  }}
                >
                  {f.v}
                </span>
              </div>
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={onOpenRun}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 12,
            padding: 0,
            border: "none",
            background: "none",
            cursor: "pointer",
            fontSize: 11.5,
            color: "var(--ink-faint)",
            fontFamily: "var(--font-sans)",
          }}
        >
          <Icon name="external" size={13} />
          <span style={{ color: "var(--brand)" }}>
            View full run &amp; executed path →
          </span>
        </button>
      </div>

      {/* routing — only when the gate actually names approvers / an escalation */}
      {hasRouting && (
        <div style={{ padding: "0 22px 18px" }}>
          <MonoLabel>Routing</MonoLabel>
          <div
            style={{
              border: "1px solid var(--line-mid)",
              background: "var(--card)",
              borderRadius: 11,
              padding: "10px 14px",
              display: "flex",
              flexDirection: "column",
              gap: 8,
              fontSize: 12,
            }}
          >
            {item.approvers &&
              (item.approvers.emails.length > 0 ||
                item.approvers.groups.length > 0) && (
                <div style={{ display: "flex", gap: 10 }}>
                  <span
                    style={{
                      color: "var(--ink-faint)",
                      width: 92,
                      flex: "none",
                    }}
                  >
                    Approvers
                  </span>
                  <span
                    style={{
                      color: "var(--ink)",
                      fontFamily: "var(--font-mono)",
                      overflowWrap: "anywhere",
                    }}
                  >
                    {[
                      ...item.approvers.emails,
                      ...item.approvers.groups.map((g) => `@${g.name}`),
                    ].join(", ")}
                  </span>
                </div>
              )}
            {(item.escalateTo || item.escalateAfterHours != null) && (
              <div style={{ display: "flex", gap: 10 }}>
                <span
                  style={{ color: "var(--ink-faint)", width: 92, flex: "none" }}
                >
                  Escalation
                </span>
                <span style={{ color: "var(--ink)" }}>
                  {item.escalateAfterHours != null
                    ? `after ${item.escalateAfterHours}h`
                    : "configured"}
                  {item.escalateTo ? ` → ${item.escalateTo}` : ""}
                </span>
              </div>
            )}
            {item.slaHours != null && (
              <div style={{ display: "flex", gap: 10 }}>
                <span
                  style={{ color: "var(--ink-faint)", width: 92, flex: "none" }}
                >
                  SLA
                </span>
                <span style={{ color: "var(--ink)" }}>{item.slaHours}h</span>
              </div>
            )}
          </div>
          {onRemind && (
            <Button
              variant="ghost"
              icon="bell"
              loading={remindBusy}
              disabled={disabled || remindBusy}
              onClick={onRemind}
              style={{ marginTop: 10, height: 34, fontSize: 12 }}
            >
              Remind now
            </Button>
          )}
        </div>
      )}
      {/* Remind still available for un-routed gates */}
      {!hasRouting && onRemind && (
        <div style={{ padding: "0 22px 6px" }}>
          <Button
            variant="ghost"
            icon="bell"
            loading={remindBusy}
            disabled={disabled || remindBusy}
            onClick={onRemind}
            style={{ height: 34, fontSize: 12 }}
          >
            Remind now
          </Button>
        </div>
      )}

      {/* decide */}
      <div style={{ padding: "6px 22px 22px" }}>
        <MonoLabel>Your decision</MonoLabel>
        <textarea
          value={comment}
          onChange={(e) => onCommentChange(e.target.value)}
          placeholder="Add an optional comment for the audit log…"
          disabled={disabled}
          style={{
            width: "100%",
            height: 64,
            resize: "none",
            background: "var(--card)",
            border: "1px solid var(--line-2)",
            borderRadius: 10,
            padding: "10px 12px",
            fontSize: 12.5,
            color: "var(--ink)",
            fontFamily: "var(--font-sans)",
            outline: "none",
            boxSizing: "border-box",
          }}
          onFocus={(e) => (e.currentTarget.style.borderColor = "var(--brand)")}
          onBlur={(e) => (e.currentTarget.style.borderColor = "var(--line-2)")}
        />
        <div style={{ display: "flex", gap: 10, marginTop: 11 }}>
          <Button
            variant="positive"
            icon="check"
            loading={busy}
            disabled={disabled}
            onClick={() => onDecide(true)}
            style={{ flex: 1, height: 42, borderRadius: 10, fontSize: 13 }}
          >
            Approve
          </Button>
          <Button
            variant="danger"
            disabled={disabled || busy}
            onClick={() => onDecide(false)}
            style={{
              height: 42,
              padding: "0 22px",
              borderRadius: 10,
              fontSize: 13,
            }}
          >
            Reject
          </Button>
        </div>
        <div
          style={{
            marginTop: 12,
            fontSize: 11.5,
            color: "var(--ink-3)",
            lineHeight: 1.5,
          }}
        >
          Approving resumes the {noun} immediately; rejecting stops it.
        </div>
      </div>
    </div>
  );
}
