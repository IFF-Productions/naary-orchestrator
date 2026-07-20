import { Checkbox, Icon } from "../../../components";
import type { AwaitingApproval } from "../../../lib/api";
import { toneColors, type WaitingInfo } from "./urgency";

/**
 * One request in the approvals queue: checkbox (batch select) · approval-gate
 * icon tile · title + workflow · requester line · right-aligned waiting-age chip.
 * Clicking the row focuses it in the detail panel; the checkbox toggles batch
 * selection without changing focus.
 */
export function QueueRow({
  item,
  waiting,
  active,
  checked,
  disabled,
  onFocus,
  onToggleCheck,
}: {
  item: AwaitingApproval;
  waiting: WaitingInfo;
  /** This row is the one shown in the detail panel. */
  active: boolean;
  checked: boolean;
  disabled: boolean;
  onFocus: () => void;
  onToggleCheck: () => void;
}) {
  const tone = toneColors(waiting.tone);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={item.title}
      onClick={onFocus}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onFocus();
        }
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "11px 12px",
        borderRadius: "var(--radius-lg)",
        cursor: "pointer",
        border: `1px solid ${active ? "var(--brand)" : "var(--line-mid)"}`,
        background: active ? "var(--hover)" : "var(--card)",
        transition: "background .12s ease, border-color .12s ease",
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = "var(--hover)";
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = "var(--card)";
      }}
    >
      <span
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        style={{ display: "inline-flex", flex: "none" }}
      >
        <Checkbox
          checked={checked}
          onChange={() => {
            if (!disabled) onToggleCheck();
          }}
        />
      </span>

      {/* Every inbox entry is a human-approval gate — the approval node accent. */}
      <span
        style={{
          width: 34,
          height: 34,
          flex: "none",
          borderRadius: "var(--radius-md)",
          border:
            "1px solid color-mix(in srgb, var(--node-approval) 55%, transparent)",
          color: "var(--node-approval)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon name="approval" size={17} />
      </span>

      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: "block",
            fontSize: "var(--text-body)",
            fontWeight: "var(--weight-semibold)",
            color: "var(--ink)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {item.title}
        </span>
        <span
          style={{
            display: "block",
            fontSize: 11.5,
            color: "var(--ink-faint)",
            marginTop: 2,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {item.workflowKey ?? "workflow"} · gate {item.nodeId}
        </span>
      </span>

      <span style={{ textAlign: "right", flex: "none" }}>
        <span
          style={{
            display: "inline-block",
            fontSize: 11,
            fontWeight: "var(--weight-semibold)",
            color: tone.fg,
            background: tone.bg,
            border: `1px solid ${tone.bd}`,
            borderRadius: "var(--radius-pill)",
            padding: "2px 9px",
          }}
        >
          {waiting.label}
        </span>
        <span
          style={{
            display: "block",
            fontSize: 10.5,
            color: "var(--ink-3)",
            marginTop: 3,
            fontFamily: "var(--font-mono)",
          }}
        >
          {new Date(item.pausedAt ?? item.createdAt).toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
      </span>
    </div>
  );
}
