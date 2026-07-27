// Notifications section (redesign — the comp's per-event × channel matrix,
// _design-reference/redesign/Naary Settings.dc.html). REAL model: a workspace has
// ANY NUMBER of channels (Slack / Microsoft Teams webhooks + SMTP email lists),
// each a ROW of the matrix; the COLUMNS are the four real event flags (approval
// pending / run failed / budget threshold / promotion), toggled per cell. Channels
// belong to the ACTIVE environment (env-scoped routing: a sandbox failure never
// pages prod's channels). Expanding a row edits its label + webhook URL or SMTP
// config (connection + recipients), sends a test, or deletes it.
import { useEffect, useState } from "react";
import { Button, Icon, Switch, TextInput } from "../../../components";
import {
  api,
  type ConnectionRow,
  type Environment,
  type NotificationChannel,
  type NotificationChannelType,
  UnauthorizedError,
} from "../../../lib/api";
import { useActiveEnvironment } from "../../../lib/useActiveEnvironment";
import { PHONE_QUERY, useMediaQuery } from "../../../lib/useMediaQuery";
import {
  ChannelGlyph,
  EnvChip,
  ErrorLine,
  panelStyle,
  SectionHeader,
  SectionIntro,
} from "./shared";

/** Per-type display metadata. */
export const CHANNEL_META: Record<
  NotificationChannelType,
  { title: string; placeholder?: string; hint?: string }
> = {
  slack: {
    title: "Slack",
    placeholder: "https://hooks.slack.com/services/…",
  },
  teams: {
    title: "Microsoft Teams",
    placeholder: "https://prod-00.westus.logic.azure.com/workflows/…",
    hint: "Paste a Teams Workflows (Power Automate) webhook URL — “When a Teams webhook request is received”. We send an Adaptive Card; the legacy Office 365 connector format isn’t supported.",
  },
  email: {
    title: "Email",
    hint: "Sends through one of this environment's SMTP connections (the same connection the Send Email node uses — credentials stay server-side). Approval emails carry the same signed Approve / Reject links the Slack buttons do.",
  },
};

/** The four REAL per-channel event flags — the matrix's columns. */
export const EVENT_COLUMNS: {
  key:
    "onApprovalPending" | "onRunFailed" | "onBudgetThreshold" | "onPromotion";
  title: string;
  hint: string;
  /** Approval messages carry decide-in-place Approve/Reject actions. */
  decide?: boolean;
}[] = [
  {
    key: "onApprovalPending",
    title: "Approval",
    hint: "When a run pauses for approval — the message carries Approve / Reject decide-in-place actions (buttons in Slack/Teams, signed links in email)",
    decide: true,
  },
  {
    key: "onRunFailed",
    title: "Run failed",
    hint: "When a run errors or times out",
  },
  {
    key: "onBudgetThreshold",
    title: "Budget",
    hint: "When monthly spend crosses the budget alert threshold (at most once per calendar month; set the threshold in Usage & budgets)",
  },
  {
    key: "onPromotion",
    title: "Promotion",
    hint: "When a workflow is promoted into this environment",
  },
];

/** Channel config as held in edit state — strings ("" not null) for the inputs, plus a
 *  stable `localKey` (server id, or a draft key until the first save assigns one). */
export type EditableChannel = Omit<
  NotificationChannel,
  "id" | "label" | "webhookUrl" | "emailConnectionId" | "emailTo"
> & {
  localKey: string;
  id?: string;
  label: string;
  webhookUrl: string;
  emailConnectionId: string;
  /** Comma-separated in the input; split on save. */
  emailTo: string;
};

let draftCounter = 0;
/** A new, not-yet-saved channel — created server-side on first Save. */
export function draftChannel(type: NotificationChannelType): EditableChannel {
  draftCounter += 1;
  return {
    localKey: `draft-${draftCounter}`,
    type,
    label: "",
    enabled: true,
    webhookUrl: "",
    emailConnectionId: "",
    emailTo: "",
    onApprovalPending: true,
    onRunFailed: true,
    // Budget alerts (Slice 3) + promotions (Slice 4) are opt-in — never
    // surprise-enabled on a new channel.
    onBudgetThreshold: false,
    onPromotion: false,
  };
}

function toEditable(c: NotificationChannel): Omit<EditableChannel, "localKey"> {
  return {
    ...c,
    label: c.label ?? "",
    webhookUrl: c.webhookUrl ?? "",
    emailConnectionId: c.emailConnectionId ?? "",
    emailTo: c.emailTo.join(", "),
  };
}

/** The wire patch for a channel's CURRENT edit state (event flags + type-specific config). */
function toPatch(ch: EditableChannel) {
  return {
    label: ch.label.trim() || null,
    enabled: ch.enabled,
    onApprovalPending: ch.onApprovalPending,
    onRunFailed: ch.onRunFailed,
    onBudgetThreshold: ch.onBudgetThreshold,
    onPromotion: ch.onPromotion,
    ...(ch.type === "email"
      ? {
          emailConnectionId: ch.emailConnectionId || null,
          emailTo: ch.emailTo
            .split(",")
            .map((t) => t.trim())
            .filter((t) => t !== ""),
        }
      : { webhookUrl: ch.webhookUrl.trim() || null }),
  };
}

/** The comp's 22px checkmark/dash toggle tile — one matrix cell. */
function EventTile({
  on,
  label,
  onToggle,
}: {
  on: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      style={{
        width: 22,
        height: 22,
        flex: "none",
        padding: 0,
        borderRadius: 7,
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        border: `1px solid ${on ? "var(--state-done)" : "var(--line-2)"}`,
        background: on
          ? "color-mix(in srgb, var(--state-done) 14%, transparent)"
          : "var(--card)",
        color: on ? "var(--state-done)" : "var(--ink-faint)",
      }}
    >
      <svg width={13} height={13} viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
          d={on ? "M5 12.5 10 17.5 19.5 7" : "M6 12h12"}
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

/** Matrix grid: channel identity | 4 event columns | expand chevron.
 *  The identity floor (220px) is what keeps the channel NAME readable at the matrix's narrowest —
 *  at the old 180px floor the name was the only shrinkable element in the cell, so after the type
 *  glyph and gaps it ellipsised to near-nothing (#665). It stays under the 620px scroll floor of
 *  the panel below (220 + 4×70 + 28 + 5×8 gaps + 36 padding = 604), so raising it does NOT widen
 *  the horizontal scroll at any viewport. */
const GRID_COLUMNS = "minmax(220px,1.6fr) repeat(4, minmax(70px,1fr)) 28px";

export function NotificationsSection({
  tenantId,
  envs,
}: {
  tenantId: string | null;
  envs: Environment[];
}) {
  /**
   * PHONE (#708). At 390px this matrix hid 260px — 42% of every row — behind a scroller with no
   * affordance: the channel column alone asks for 220px, leaving nothing for four toggle columns,
   * so every event checkbox was off-canvas and the screen showed a list of channel names with no
   * way to see or change what any of them routes.
   *
   * #708 fenced this table off as its own slice because its `EventTile` cells are 22px
   * inline-styled toggles that the `.btn-icon` rule can't reach, and because a phone bump would
   * change the matrix's row height and column budget. Cards dissolve that objection rather than
   * working around it: stacked, there IS no column budget, and each toggle sits on its own line
   * with the event name beside it — so it can take a real touch target without crowding a
   * neighbour, unlike the grant matrix whose checkboxes are 37px apart.
   */
  const phone = useMediaQuery(PHONE_QUERY);
  const activeEnvSel = useActiveEnvironment();
  const activeEnv =
    envs.find((e) => e.slug === activeEnvSel || e.id === activeEnvSel) ??
    envs.find((e) => e.isDefault) ??
    envs[0];

  const [channels, setChannels] = useState<EditableChannel[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // This environment's SMTP connections — the email channel's connection picker.
  const [smtpConns, setSmtpConns] = useState<ConnectionRow[]>([]);
  // Per-channel transient UI state (keyed by localKey).
  const [rowBusy, setRowBusy] = useState<Record<string, boolean>>({});
  const [rowStatus, setRowStatus] = useState<Record<string, string>>({});
  const [testBusy, setTestBusy] = useState<Record<string, boolean>>({});
  const [testResult, setTestResult] = useState<
    Record<string, { ok: boolean; message?: string }>
  >({});

  useEffect(() => {
    if (!tenantId) return;
    let live = true;
    (async () => {
      try {
        const list = await api.listNotificationChannels(tenantId);
        if (!live) return;
        setChannels(list.map((c) => ({ ...toEditable(c), localKey: c.id })));
        setLoaded(true);
        setError(null);
      } catch (e) {
        if (live)
          setError(
            e instanceof UnauthorizedError
              ? "Sign in to view notification channels."
              : "Could not load notification channels.",
          );
      }
    })();
    (async () => {
      try {
        const conns = await api.listConnections(tenantId);
        if (live) setSmtpConns(conns.filter((c) => c.type === "smtp"));
      } catch {
        // Best-effort — the picker just shows the "no SMTP connections" hint.
      }
    })();
    return () => {
      live = false;
    };
  }, [tenantId]);

  function patchChannel(localKey: string, patch: Partial<EditableChannel>) {
    setChannels((prev) =>
      prev.map((c) => (c.localKey === localKey ? { ...c, ...patch } : c)),
    );
  }

  function addChannel(type: NotificationChannelType) {
    const draft = draftChannel(type);
    setChannels((prev) => [...prev, draft]);
    setExpanded((x) => ({ ...x, [draft.localKey]: true }));
  }

  /** Matrix cell click: flip locally, and persist immediately for a SAVED row (a draft
   *  keeps the flag locally until its first Save creates it). Reverts on failure. */
  async function toggleFlag(
    localKey: string,
    key: (typeof EVENT_COLUMNS)[number]["key"],
  ) {
    const ch = channels.find((c) => c.localKey === localKey);
    if (!ch || !tenantId) return;
    const next = !ch[key];
    patchChannel(localKey, { [key]: next });
    if (!ch.id) return; // draft — persisted on first Save
    try {
      await api.saveNotificationChannel(tenantId, ch.id, { [key]: next });
    } catch (e) {
      patchChannel(localKey, { [key]: !next }); // revert — the server didn't take it
      setError(
        e instanceof UnauthorizedError
          ? "Sign in to edit notifications."
          : "Could not save the toggle.",
      );
    }
  }

  async function saveChannel(localKey: string) {
    if (!tenantId) return;
    const ch = channels.find((c) => c.localKey === localKey);
    if (!ch) return;
    setRowBusy((b) => ({ ...b, [localKey]: true }));
    setRowStatus((s) => ({ ...s, [localKey]: "" }));
    setError(null);
    try {
      const patch = toPatch(ch);
      // A draft has no server id yet → create; afterwards it patches in place. The
      // localKey stays put so transient UI state (busy/status) survives the first save.
      const saved = ch.id
        ? await api.saveNotificationChannel(tenantId, ch.id, patch)
        : await api.createNotificationChannel(tenantId, {
            type: ch.type,
            ...patch,
          });
      patchChannel(localKey, { ...toEditable(saved), localKey, id: saved.id });
      setRowStatus((s) => ({ ...s, [localKey]: "Saved." }));
    } catch (e) {
      setError(
        e instanceof UnauthorizedError
          ? "Sign in to save notifications."
          : e instanceof Error && e.message
            ? e.message
            : "Could not save the channel.",
      );
    } finally {
      setRowBusy((b) => ({ ...b, [localKey]: false }));
    }
  }

  async function deleteChannel(localKey: string) {
    if (!tenantId) return;
    const ch = channels.find((c) => c.localKey === localKey);
    if (!ch) return;
    setRowBusy((b) => ({ ...b, [localKey]: true }));
    setError(null);
    try {
      // A draft only exists locally — just drop it; a saved row is deleted server-side.
      if (ch.id) await api.deleteNotificationChannel(tenantId, ch.id);
      setChannels((prev) => prev.filter((c) => c.localKey !== localKey));
    } catch (e) {
      setError(
        e instanceof UnauthorizedError
          ? "Sign in to edit notifications."
          : "Could not delete the channel.",
      );
    } finally {
      setRowBusy((b) => ({ ...b, [localKey]: false }));
    }
  }

  async function testChannel(localKey: string) {
    if (!tenantId) return;
    const ch = channels.find((c) => c.localKey === localKey);
    if (!ch?.id) return; // drafts have nothing saved to test
    setTestBusy((b) => ({ ...b, [localKey]: true }));
    setTestResult((t) => {
      const { [localKey]: _drop, ...rest } = t;
      return rest;
    });
    try {
      // Tests the SAVED config for this channel — save edits first.
      const res = await api.testNotificationChannel(tenantId, ch.id);
      setTestResult((t) => ({ ...t, [localKey]: res }));
    } catch {
      setTestResult((t) => ({
        ...t,
        [localKey]: { ok: false, message: "Could not send the test." },
      }));
    } finally {
      setTestBusy((b) => ({ ...b, [localKey]: false }));
    }
  }

  /** One-line descriptor under the row label (type + destination). */
  function rowSubtitle(ch: EditableChannel): string {
    const meta = CHANNEL_META[ch.type];
    if (ch.type === "email") {
      return `${meta.title} · ${ch.emailTo.trim() || "no recipients yet"}`;
    }
    return `${meta.title} · ${
      ch.webhookUrl
        ? ch.webhookUrl.replace(/^https?:\/\//, "")
        : "no webhook URL yet"
    }`;
  }

  /** Whether Send test can work on the SAVED row. */
  function testHint(ch: EditableChannel): string | null {
    if (!ch.id) return "Save the channel first";
    if (ch.type === "email") {
      return ch.emailConnectionId && ch.emailTo.trim()
        ? null
        : "Pick an SMTP connection and recipients first";
    }
    return ch.webhookUrl.trim() ? null : "Add a webhook URL first";
  }

  return (
    <div>
      <SectionHeader
        title="Notifications"
        action={
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {(Object.keys(CHANNEL_META) as NotificationChannelType[]).map(
              (type) => (
                <Button
                  key={type}
                  variant={type === "slack" ? "primary" : "secondary"}
                  icon="plus"
                  disabled={!loaded}
                  onClick={() => addChannel(type)}
                >
                  {CHANNEL_META[type].title}
                </Button>
              ),
            )}
          </div>
        }
      />
      <SectionIntro>
        {/* The wording has to match the layout: on phone there are no columns any more, and
            telling someone to read a column that isn't there is its own small lie. */}
        Per-event channels — each row is a channel (Slack, Teams or email),
        {phone
          ? " with a switch per event; a checked switch means that channel gets that event."
          : " each column a real event; a checked cell means that channel gets that event."}{" "}
        Approval messages carry{" "}
        <strong style={{ color: "var(--ink-soft)" }}>decide-in-place</strong>{" "}
        Approve / Reject actions — buttons in Slack and Teams, the same signed
        links in email — so approvers act without leaving their inbox or
        channel. Channels belong to{" "}
        {activeEnv ? (
          <>
            the <EnvChip env={activeEnv} /> environment
          </>
        ) : (
          "the active environment"
        )}{" "}
        — each environment routes its own alerts, so a sandbox failure never
        pages production's channels.
      </SectionIntro>

      {error && <ErrorLine>{error}</ErrorLine>}

      <div style={panelStyle}>
        <div style={{ overflowX: phone ? undefined : "auto" }}>
          <div style={{ minWidth: phone ? undefined : 620 }}>
            {/* Matrix header — mono uppercase, per the comp. Desktop/tablet only: on phone each
                toggle is labelled in place, so a column header would name nothing. */}
            {!phone && (
            <div
              className="mono"
              style={{
                display: "grid",
                gridTemplateColumns: GRID_COLUMNS,
                alignItems: "center",
                gap: 8,
                padding: "11px 18px",
                borderBottom: "1px solid var(--line)",
                background: "var(--card-2, var(--card))",
                fontSize: 10.5,
                letterSpacing: ".08em",
                textTransform: "uppercase",
                color: "var(--ink-faint)",
              }}
            >
              <span>Channel</span>
              {EVENT_COLUMNS.map((col) => (
                <span
                  key={col.key}
                  title={col.hint}
                  style={{ textAlign: "center" }}
                >
                  {col.title}
                  {col.decide && (
                    <span
                      title="Carries Approve / Reject decide-in-place actions"
                      style={{
                        display: "block",
                        textTransform: "none",
                        letterSpacing: 0,
                        fontSize: 9,
                        color: "var(--node-approval)",
                      }}
                    >
                      decide-in-place
                    </span>
                  )}
                </span>
              ))}
              <span />
            </div>
            )}

            {!loaded && !error && (
              <div
                style={{
                  padding: "13px 18px",
                  fontSize: "var(--text-sm)",
                  color: "var(--ink-3)",
                }}
              >
                Loading channels…
              </div>
            )}
            {loaded && channels.length === 0 && (
              <div
                style={{
                  padding: "16px 18px",
                  fontSize: "var(--text-sm)",
                  color: "var(--ink-3)",
                }}
              >
                No channels in this environment yet — add a Slack or Teams
                webhook, or an email list; each event goes to every enabled,
                checked channel.
              </div>
            )}
            {channels.map((ch) => {
              const key = ch.localKey;
              const meta = CHANNEL_META[ch.type];
              const open = !!expanded[key];
              const busy = !!rowBusy[key];
              const tBusy = !!testBusy[key];
              const status = rowStatus[key];
              const test = testResult[key];
              const tHint = testHint(ch);
              // The row's identity. It can still ellipsise on a phone, so it also becomes the
              // title (hover/long-press reveals the full name).
              const name =
                ch.label ||
                (ch.type === "email" ? "Email list" : `${meta.title} webhook`);
              return (
                <div
                  key={key}
                  style={{ borderBottom: "1px solid var(--line)" }}
                >
                  <div
                    className="naary-set-row"
                    role="button"
                    tabIndex={0}
                    onClick={() => setExpanded((x) => ({ ...x, [key]: !open }))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setExpanded((x) => ({ ...x, [key]: !open }));
                      }
                    }}
                    style={{
                      display: "grid",
                      // Phone: one column, so the identity line and each labelled toggle stack.
                      gridTemplateColumns: phone ? "1fr" : GRID_COLUMNS,
                      alignItems: "center",
                      gap: phone ? 10 : 8,
                      padding: phone ? "13px 16px" : "13px 18px",
                      cursor: "pointer",
                      opacity: ch.enabled ? 1 : 0.6,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                        minWidth: 0,
                      }}
                    >
                      <span
                        style={{
                          width: 28,
                          height: 28,
                          flex: "none",
                          borderRadius: 8,
                          border: "1px solid var(--line-2)",
                          background: "var(--card)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          color: "var(--ink-2)",
                        }}
                      >
                        <ChannelGlyph type={ch.type} size={14} />
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            fontSize: 12.5,
                            fontWeight: "var(--weight-semibold)",
                            color: "var(--ink)",
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            minWidth: 0,
                          }}
                        >
                          <span
                            title={name}
                            style={{
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {name}
                          </span>
                          {!ch.id && (
                            <span
                              style={{
                                fontSize: "var(--text-2xs)",
                                color: "var(--ink-3)",
                                fontWeight: "var(--weight-regular)",
                                flex: "none",
                              }}
                            >
                              (not saved yet)
                            </span>
                          )}
                          {/* No env chip here: the list is env-FILTERED server-side (every row
                              belongs to the active environment), so a per-row chip repeats the one
                              in the intro above while stealing the name's width — at the identity
                              column's floor the "production" pill + status dot left the name a few
                              ellipsised characters (#665). The env belongs to the section, not the
                              row; `label` is what tells same-type channels apart. */}
                          <span
                            title={ch.enabled ? "Enabled" : "Disabled"}
                            style={{
                              width: 7,
                              height: 7,
                              flex: "none",
                              borderRadius: "50%",
                              background: ch.enabled
                                ? "var(--state-done)"
                                : "var(--state-idle)",
                            }}
                          />
                        </div>
                        <div
                          className="mono"
                          style={{
                            fontSize: 11,
                            color: "var(--ink-faint)",
                            marginTop: 1,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {rowSubtitle(ch)}
                        </div>
                      </div>
                    </div>
                    {EVENT_COLUMNS.map((col) => {
                      const tile = (
                        <EventTile
                          on={ch[col.key]}
                          label={`${col.title} — ${
                            ch.label || meta.title
                          } (${ch[col.key] ? "on" : "off"})`}
                          onToggle={() => void toggleFlag(key, col.key)}
                        />
                      );
                      if (!phone)
                        return (
                          <div
                            key={col.key}
                            style={{
                              display: "flex",
                              justifyContent: "center",
                            }}
                          >
                            {tile}
                          </div>
                        );
                      // Phone: the event NAME travels with its toggle. The column header is gone,
                      // and an unlabelled checkbox would be a switch for something unnamed —
                      // worse than a hidden column, since you could enable the wrong alert.
                      return (
                        <div
                          key={col.key}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 10,
                            paddingLeft: 40,
                          }}
                        >
                          {tile}
                          <span
                            style={{
                              fontSize: "var(--text-xs)",
                              color: "var(--ink-2)",
                            }}
                          >
                            {col.title}
                            {col.decide && (
                              <span
                                style={{
                                  color: "var(--node-approval)",
                                  marginLeft: 6,
                                }}
                              >
                                decide-in-place
                              </span>
                            )}
                          </span>
                        </div>
                      );
                    })}
                    {/* Desktop: the trailing 28px column. On phone it would land alone on its own
                        line reading as a stray glyph, and the whole row is already the expand
                        control (role="button"), so the affordance is not lost. */}
                    {!phone && (
                      <Icon
                        name={open ? "chevron-down" : "chevron-right"}
                        size={14}
                        style={{
                          color: "var(--ink-3)",
                          flex: "none",
                          justifySelf: "end",
                        }}
                      />
                    )}
                  </div>

                  {open && (
                    <div
                      style={{
                        padding: "4px 18px 16px 58px",
                        display: "grid",
                        gap: 12,
                        animation: "naaryFadeUp .2s ease",
                      }}
                    >
                      {meta.hint && (
                        <div
                          style={{
                            fontSize: "var(--text-sm)",
                            color: "var(--ink-3)",
                            lineHeight: "var(--leading-snug)",
                            maxWidth: 560,
                          }}
                        >
                          {meta.hint}
                        </div>
                      )}
                      <div
                        style={{
                          display: "flex",
                          gap: 10,
                          flexWrap: "wrap",
                        }}
                      >
                        <TextInput
                          value={ch.label}
                          onChange={(e) =>
                            patchChannel(key, { label: e.target.value })
                          }
                          placeholder={
                            ch.type === "slack"
                              ? "#alerts (label, optional)"
                              : ch.type === "email"
                                ? "Ops list (label, optional)"
                                : "Ops (label, optional)"
                          }
                          style={{ flex: "1 1 160px", maxWidth: 220 }}
                          disabled={!loaded}
                        />
                        {ch.type === "email" ? (
                          <>
                            <select
                              aria-label="SMTP connection"
                              value={ch.emailConnectionId}
                              onClick={(e) => e.stopPropagation()}
                              onChange={(e) =>
                                patchChannel(key, {
                                  emailConnectionId: e.target.value,
                                })
                              }
                              disabled={!loaded}
                              style={{
                                flex: "1 1 180px",
                                maxWidth: 260,
                                fontSize: "var(--text-sm)",
                                padding: "5px 8px",
                                borderRadius: "var(--radius-sm)",
                                border: "1px solid var(--line-2)",
                                background: "var(--card)",
                                color: "var(--ink)",
                              }}
                            >
                              <option value="">
                                {smtpConns.length
                                  ? "Pick an SMTP connection…"
                                  : "No SMTP connections in this environment"}
                              </option>
                              {smtpConns.map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.label || c.serverUrl || c.id}
                                </option>
                              ))}
                            </select>
                            <TextInput
                              value={ch.emailTo}
                              onChange={(e) =>
                                patchChannel(key, { emailTo: e.target.value })
                              }
                              placeholder="ops@acme.io, oncall@acme.io (max 10)"
                              style={{ flex: "2 1 240px" }}
                              disabled={!loaded}
                            />
                          </>
                        ) : (
                          <TextInput
                            value={ch.webhookUrl}
                            onChange={(e) =>
                              patchChannel(key, { webhookUrl: e.target.value })
                            }
                            placeholder={meta.placeholder}
                            style={{ flex: "2 1 240px" }}
                            disabled={!loaded}
                          />
                        )}
                      </div>
                      {ch.type === "email" && !smtpConns.length && (
                        <div
                          style={{
                            fontSize: "var(--text-sm)",
                            color: "var(--ink-3)",
                          }}
                        >
                          Add an SMTP connection in Integrations first — email
                          channels send through it.
                        </div>
                      )}
                      <label
                        style={{
                          display: "flex",
                          gap: 9,
                          alignItems: "center",
                          cursor: "pointer",
                        }}
                      >
                        <Switch
                          checked={ch.enabled}
                          onChange={(v) => patchChannel(key, { enabled: v })}
                        />
                        <span
                          style={{
                            fontSize: "var(--text-body)",
                            color: "var(--ink)",
                          }}
                        >
                          {ch.enabled
                            ? "Channel enabled"
                            : "Channel disabled — the worker skips it entirely"}
                        </span>
                      </label>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                          flexWrap: "wrap",
                        }}
                      >
                        <Button
                          variant="primary"
                          size="sm"
                          loading={busy}
                          disabled={!loaded}
                          onClick={() => void saveChannel(key)}
                        >
                          Save
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          icon="bell"
                          disabled={tBusy || !loaded || !!tHint}
                          loading={tBusy}
                          onClick={() => void testChannel(key)}
                          title={
                            tHint ??
                            (ch.type === "email"
                              ? "Send a sample email to the saved recipients"
                              : `POST a sample message to this ${meta.title} webhook`)
                          }
                        >
                          Send test
                        </Button>
                        <Button
                          variant="danger"
                          size="sm"
                          icon="trash"
                          disabled={busy || !loaded}
                          onClick={() => void deleteChannel(key)}
                          title={
                            ch.id ? "Delete this channel" : "Discard this draft"
                          }
                        >
                          {ch.id ? "Delete" : "Discard"}
                        </Button>
                        {status && (
                          <span
                            style={{
                              fontSize: "var(--text-sm)",
                              color: "var(--state-done)",
                            }}
                          >
                            {status}
                          </span>
                        )}
                        {test && (
                          <span
                            style={{
                              fontSize: "var(--text-sm)",
                              color: test.ok
                                ? "var(--state-done)"
                                : "var(--state-error)",
                            }}
                          >
                            {test.ok
                              ? ch.type === "email"
                                ? "✓ Test sent — check the recipients' inboxes."
                                : "✓ Test sent — check your channel."
                              : test.message}
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
