/**
 * Slice-1 approval-gate parameters (REDESIGN-FUNCTIONALITY-GAPS.md): approver routing
 * (email chips + a picker over the workspace's REAL permission groups), display SLA,
 * reminder/escalation timer offsets, and the structured context-fields card (key +
 * expression rows — values may use `{{ node.path }}`, resolved at pause time in the
 * worker activity; `$secrets` never resolves there).
 *
 * Every field maps 1:1 onto ApprovalNodeConfig (@naary/dsl). Empty structures are
 * removed from the config (not left as `{}`/`[]`) so an untouched gate keeps the exact
 * pre-Slice-1 config shape — which is also what keeps the interpreter on the old
 * replay-safe path for gates that don't use these features.
 */
import { useEffect, useMemo, useState } from "react";
import { Checkbox, Icon } from "../../components";
import { ExpressionField } from "../../components/ExpressionField";
import { api, type PermissionGroup } from "../../lib/api";
import type { ConfigSectionCtx } from "./ConfigPanel";
import { inputStyle, Labeled } from "./fields";

interface Approvers {
  emails?: string[];
  groupIds?: string[];
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const hintStyle: React.CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--ink-3)",
  marginTop: -6,
};

export function ApprovalRoutingFields({ c }: { c: ConfigSectionCtx }) {
  const { node, config, num, str, onChange, edges, nodeKinds, pins } = c;
  const approvers = (config.approvers as Approvers | undefined) ?? {};
  const emails = approvers.emails ?? [];
  const groupIds = approvers.groupIds ?? [];
  const contextFields =
    (config.contextFields as Record<string, string> | undefined) ?? {};

  // Real permission groups for the picker. Owner/admin-only endpoint — members get
  // the honest fallback (raw ids still render, nothing is invented).
  const [groups, setGroups] = useState<PermissionGroup[] | null | "denied">(
    null,
  );
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const me = await api.getMe();
        const list = await api.listGroups(me.tenantId);
        if (alive) setGroups(list);
      } catch {
        if (alive) setGroups("denied");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Email chip entry buffer.
  const [emailDraft, setEmailDraft] = useState("");
  // Reminder offsets keep a raw text buffer so "4," isn't mangled mid-typing.
  const [remindDraft, setRemindDraft] = useState<string | null>(null);
  const remindValue =
    remindDraft ??
    ((config.remindAfterHours as number[] | undefined) ?? []).join(", ");

  /** Write approvers back, dropping empty lists / the whole object when unused. */
  function patchApprovers(next: Approvers) {
    const cleaned: Approvers = {};
    if (next.emails && next.emails.length > 0) cleaned.emails = next.emails;
    if (next.groupIds && next.groupIds.length > 0)
      cleaned.groupIds = next.groupIds;
    onChange({
      approvers: Object.keys(cleaned).length > 0 ? cleaned : undefined,
    });
  }

  function addEmail(raw: string) {
    const v = raw.trim().replace(/,+$/, "");
    if (!v) return;
    setEmailDraft("");
    if (emails.some((e) => e.toLowerCase() === v.toLowerCase())) return;
    patchApprovers({ ...approvers, emails: [...emails, v] });
  }

  function commitReminders(raw: string) {
    const parts = raw
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0)
      .slice(0, 5) // schema cap
      .sort((a, b) => a - b); // schema requires ascending
    const unique = [...new Set(parts)];
    onChange({ remindAfterHours: unique.length > 0 ? unique : undefined });
  }

  const groupNameById = useMemo(() => {
    const m = new Map<string, string>();
    if (groups && groups !== "denied")
      for (const g of groups) m.set(g.id, g.name);
    return m;
  }, [groups]);

  const contextRows = Object.entries(contextFields);

  function setContextRows(rows: [string, string][]) {
    const next: Record<string, string> = {};
    for (const [k, v] of rows) next[k] = v;
    onChange({ contextFields: rows.length > 0 ? next : undefined });
  }

  return (
    <>
      {/* ---- Approvers ---- */}
      <Labeled label="Approvers — emails (blank = anyone with Run access)">
        <div>
          {emails.length > 0 && (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 6,
                marginBottom: 6,
              }}
            >
              {emails.map((e) => (
                <span
                  key={e}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                    fontSize: 11.5,
                    fontFamily: "var(--font-mono)",
                    color: EMAIL_RE.test(e)
                      ? "var(--ink-soft)"
                      : "var(--state-error)",
                    border: "1px solid var(--line-2)",
                    borderRadius: "var(--radius-pill)",
                    padding: "3px 8px",
                    background: "var(--card)",
                  }}
                >
                  {e}
                  <button
                    type="button"
                    aria-label={`Remove ${e}`}
                    onClick={() =>
                      patchApprovers({
                        ...approvers,
                        emails: emails.filter((x) => x !== e),
                      })
                    }
                    style={{
                      border: "none",
                      background: "none",
                      padding: 0,
                      cursor: "pointer",
                      color: "var(--ink-faint)",
                      display: "inline-flex",
                    }}
                  >
                    <Icon name="x" size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <input
            value={emailDraft}
            onChange={(e) => {
              const v = e.target.value;
              // Comma commits the chip (paste-a-list friendly).
              if (v.includes(",")) {
                for (const part of v.split(",")) addEmail(part);
              } else setEmailDraft(v);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addEmail(emailDraft);
              } else if (
                e.key === "Backspace" &&
                emailDraft === "" &&
                emails.length > 0
              ) {
                patchApprovers({ ...approvers, emails: emails.slice(0, -1) });
              }
            }}
            onBlur={() => addEmail(emailDraft)}
            style={inputStyle}
            placeholder="sam@acme.io — Enter to add"
          />
        </div>
      </Labeled>

      <Labeled label="Approvers — permission groups">
        {groups === null ? (
          <div style={hintStyle}>Loading groups…</div>
        ) : groups === "denied" || groups.length === 0 ? (
          <div style={hintStyle}>
            {groups === "denied"
              ? "Groups are visible to workspace owners/admins only."
              : "No permission groups yet — create them under Team → Groups."}
            {groupIds.length > 0 && (
              <> Selected: {groupIds.map((id) => `@${id}`).join(", ")}</>
            )}
          </div>
        ) : (
          <div
            style={{
              border: "1px solid var(--line-2)",
              borderRadius: 10,
              background: "var(--card)",
              maxHeight: 150,
              overflowY: "auto",
            }}
          >
            {groups.map((g) => {
              const checked = groupIds.includes(g.id);
              return (
                <label
                  key={g.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 9,
                    padding: "7px 10px",
                    cursor: "pointer",
                    fontSize: 12.5,
                    color: "var(--ink-soft)",
                    borderBottom: "1px solid var(--line)",
                  }}
                >
                  <Checkbox
                    checked={checked}
                    // The wrapping `<label>` does NOT name this: implicit labelling reaches form
                    // controls, not a `<button role="checkbox">`. Point at the group name.
                    ariaLabelledBy={`approver-group-${g.id}`}
                    onChange={() =>
                      patchApprovers({
                        ...approvers,
                        groupIds: checked
                          ? groupIds.filter((id) => id !== g.id)
                          : [...groupIds, g.id],
                      })
                    }
                  />
                  <span id={`approver-group-${g.id}`}>{g.name}</span>
                  <span
                    style={{
                      marginLeft: "auto",
                      fontSize: 10.5,
                      color: "var(--ink-faint)",
                    }}
                  >
                    {g.members.length} member{g.members.length === 1 ? "" : "s"}
                  </span>
                </label>
              );
            })}
          </div>
        )}
      </Labeled>
      <div style={hintStyle}>
        When set, only listed emails / group members can decide (workspace
        owners &amp; admins always can). Enforced server-side at decide time.
      </div>

      {/* ---- SLA / reminders / escalation ---- */}
      <Labeled label="SLA (hours) — display-only due-by">
        <input
          type="number"
          min={0}
          step={1}
          value={num("slaHours") ?? ""}
          onChange={(e) =>
            onChange({
              slaHours: e.target.value ? Number(e.target.value) : undefined,
            })
          }
          style={inputStyle}
          placeholder="e.g. 48 — powers the due/breached chips"
        />
      </Labeled>
      <Labeled label="Remind after (hours, comma-separated, max 5)">
        <input
          value={remindValue}
          onChange={(e) => setRemindDraft(e.target.value)}
          onBlur={() => {
            if (remindDraft !== null) commitReminders(remindDraft);
            setRemindDraft(null);
          }}
          style={inputStyle}
          placeholder="e.g. 4, 12 — each fires a channel reminder"
        />
      </Labeled>
      <Labeled label="Escalate after (hours)">
        <input
          type="number"
          min={0}
          step={1}
          value={num("escalateAfterHours") ?? ""}
          onChange={(e) =>
            onChange({
              escalateAfterHours: e.target.value
                ? Number(e.target.value)
                : undefined,
            })
          }
          style={inputStyle}
          placeholder="blank = never"
        />
      </Labeled>
      {num("escalateAfterHours") !== undefined && (
        <Labeled label="Escalate to (mentioned in the notification)">
          <input
            value={str("escalateTo")}
            onChange={(e) =>
              onChange({ escalateTo: e.target.value || undefined })
            }
            style={inputStyle}
            placeholder="@ops-oncall"
          />
        </Labeled>
      )}
      <div style={hintStyle}>
        Reminders/escalation are durable Temporal timers — they fire the
        workspace's notification channels even across restarts. Escalation is
        notify-only (it doesn't change who can approve).
      </div>

      {/* ---- Context fields ---- */}
      <Labeled label="Context fields (shown to the approver)">
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {contextRows.map(([k, v], i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: rows are editable in place
              key={i}
              style={{ display: "flex", gap: 6, alignItems: "flex-start" }}
            >
              <input
                value={k}
                onChange={(e) => {
                  const rows: [string, string][] = contextRows.map((r, j) =>
                    j === i ? [e.target.value, r[1]] : [r[0], r[1]],
                  );
                  setContextRows(rows);
                }}
                style={{ ...inputStyle, width: 130, flex: "none" }}
                placeholder="Amount"
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <ExpressionField
                  value={v}
                  onChange={(nv) => {
                    const rows: [string, string][] = contextRows.map((r, j) =>
                      j === i ? [r[0], nv] : [r[0], r[1]],
                    );
                    setContextRows(rows);
                  }}
                  nodeId={node.id}
                  edges={edges}
                  pins={pins}
                  nodeKinds={nodeKinds}
                  placeholder="{{ trigger.amount }}"
                />
              </div>
              <button
                type="button"
                aria-label="Remove field"
                onClick={() =>
                  setContextRows(contextRows.filter((_, j) => j !== i))
                }
                style={{
                  border: "none",
                  background: "none",
                  cursor: "pointer",
                  color: "var(--ink-faint)",
                  padding: "8px 2px",
                }}
              >
                <Icon name="x" size={13} />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setContextRows([...contextRows, ["", ""]])}
            style={{
              alignSelf: "flex-start",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              border: "1px dashed var(--line-2)",
              borderRadius: 8,
              background: "none",
              color: "var(--ink-2)",
              fontSize: 12,
              padding: "6px 10px",
              cursor: "pointer",
              fontFamily: "var(--font-sans)",
            }}
          >
            <Icon name="plus" size={12} /> Add field
          </button>
        </div>
      </Labeled>
      <div style={hintStyle}>
        Values may use <code>{"{{ node.path }}"}</code> — resolved when the run
        pauses, then shown in the approvals inbox and on the public approve
        page. <code>{"{{ $secrets.… }}"}</code> is never resolved here.
      </div>
    </>
  );
}
