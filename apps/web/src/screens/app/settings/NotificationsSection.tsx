// Notifications section (redesign). REAL model: a workspace has ANY NUMBER of
// webhook channels per type (Slack / Microsoft Teams) — there are no per-event
// email/webhook toggles. Channels belong to the ACTIVE environment (env-scoped
// routing: a sandbox failure never pages prod's channels). Each row = one channel
// with its type glyph, env chip, event flags and the teal "decide-in-place" chip
// when it carries approval Approve/Reject buttons; expanding a row edits, tests
// (send-test) or deletes it.
import { useEffect, useState } from "react";
import { Button, Checkbox, Icon, Switch, TextInput } from "../../../components";
import {
  api,
  type Environment,
  type NotificationChannel,
  type NotificationChannelType,
  UnauthorizedError,
} from "../../../lib/api";
import { useActiveEnvironment } from "../../../lib/useActiveEnvironment";
import {
  ChannelGlyph,
  DecideInPlaceChip,
  EnvChip,
  ErrorLine,
  panelStyle,
  SectionHeader,
  SectionIntro,
} from "./shared";

/** Per-type display metadata. Adding email later = one more entry here + the server-side type. */
export const CHANNEL_META: Record<
  NotificationChannelType,
  { title: string; placeholder: string; hint?: string }
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
};

/** Channel config as held in edit state — strings ("" not null) for the inputs, plus a
 *  stable `localKey` (server id, or a draft key until the first save assigns one). */
export type EditableChannel = Omit<
  NotificationChannel,
  "id" | "label" | "webhookUrl"
> & {
  localKey: string;
  id?: string;
  label: string;
  webhookUrl: string;
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
    onApprovalPending: true,
    onRunFailed: true,
  };
}

export function NotificationsSection({
  tenantId,
  envs,
}: {
  tenantId: string | null;
  envs: Environment[];
}) {
  const activeEnvSel = useActiveEnvironment();
  const activeEnv =
    envs.find((e) => e.slug === activeEnvSel || e.id === activeEnvSel) ??
    envs.find((e) => e.isDefault) ??
    envs[0];

  const [channels, setChannels] = useState<EditableChannel[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
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
        setChannels(
          list.map((c) => ({
            ...c,
            localKey: c.id,
            label: c.label ?? "",
            webhookUrl: c.webhookUrl ?? "",
          })),
        );
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

  async function saveChannel(localKey: string) {
    if (!tenantId) return;
    const ch = channels.find((c) => c.localKey === localKey);
    if (!ch) return;
    setRowBusy((b) => ({ ...b, [localKey]: true }));
    setRowStatus((s) => ({ ...s, [localKey]: "" }));
    setError(null);
    try {
      const patch = {
        label: ch.label.trim() || null,
        enabled: ch.enabled,
        webhookUrl: ch.webhookUrl.trim() || null,
        onApprovalPending: ch.onApprovalPending,
        onRunFailed: ch.onRunFailed,
      };
      // A draft has no server id yet → create; afterwards it patches in place. The
      // localKey stays put so transient UI state (busy/status) survives the first save.
      const saved = ch.id
        ? await api.saveNotificationChannel(tenantId, ch.id, patch)
        : await api.createNotificationChannel(tenantId, {
            type: ch.type,
            ...patch,
          });
      patchChannel(localKey, {
        ...saved,
        localKey,
        label: saved.label ?? "",
        webhookUrl: saved.webhookUrl ?? "",
      });
      setRowStatus((s) => ({ ...s, [localKey]: "Saved." }));
    } catch (e) {
      setError(
        e instanceof UnauthorizedError
          ? "Sign in to save notifications."
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
      // Tests the SAVED webhook for this channel — save an edited URL first.
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
        Webhook channels for the moments a run needs a human — we POST a
        formatted message when an approval is waiting or a run fails. Approval
        messages carry{" "}
        <strong style={{ color: "var(--ink-soft)" }}>decide-in-place</strong>{" "}
        Approve / Reject buttons, so approvers act without leaving Slack or
        Teams. Channels belong to{" "}
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
            No channels in this environment yet — add a Slack or Teams webhook;
            alerts go to every enabled one.
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
          return (
            <div key={key} style={{ borderBottom: "1px solid var(--line)" }}>
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
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "13px 18px",
                  cursor: "pointer",
                  opacity: ch.enabled ? 1 : 0.6,
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
                    }}
                  >
                    {ch.label || `${meta.title} webhook`}
                    {!ch.id && (
                      <span
                        style={{
                          fontSize: "var(--text-2xs)",
                          color: "var(--ink-3)",
                          fontWeight: "var(--weight-regular)",
                        }}
                      >
                        (not saved yet)
                      </span>
                    )}
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
                    {meta.title}
                    {" · "}
                    {ch.webhookUrl
                      ? ch.webhookUrl.replace(/^https?:\/\//, "")
                      : "no webhook URL yet"}
                  </div>
                </div>
                {ch.onApprovalPending && <DecideInPlaceChip />}
                {ch.onRunFailed && (
                  <span
                    className="mono"
                    title="Notifies when a run errors or times out"
                    style={{
                      fontSize: 10,
                      fontWeight: "var(--weight-semibold)",
                      color: "var(--ink-3)",
                      border: "1px solid var(--line-2)",
                      borderRadius: 20,
                      padding: "3px 9px",
                      flex: "none",
                      lineHeight: 1.4,
                    }}
                  >
                    run-failed
                  </span>
                )}
                {activeEnv && <EnvChip env={activeEnv} />}
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
                <Icon
                  name={open ? "chevron-down" : "chevron-right"}
                  size={14}
                  style={{ color: "var(--ink-3)", flex: "none" }}
                />
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
                          : "Ops (label, optional)"
                      }
                      style={{ flex: "1 1 160px", maxWidth: 220 }}
                      disabled={!loaded}
                    />
                    <TextInput
                      value={ch.webhookUrl}
                      onChange={(e) =>
                        patchChannel(key, { webhookUrl: e.target.value })
                      }
                      placeholder={meta.placeholder}
                      style={{ flex: "2 1 240px" }}
                      disabled={!loaded}
                    />
                  </div>
                  <label
                    style={{
                      display: "flex",
                      gap: 9,
                      alignItems: "center",
                      cursor: "pointer",
                    }}
                  >
                    <Checkbox
                      checked={ch.onApprovalPending}
                      onChange={(v) =>
                        patchChannel(key, { onApprovalPending: v })
                      }
                    />
                    <span
                      style={{
                        fontSize: "var(--text-body)",
                        color: "var(--ink)",
                      }}
                    >
                      When an approval is waiting{" "}
                      <span style={{ color: "var(--ink-3)", fontSize: 11.5 }}>
                        — the message carries Approve / Reject buttons
                      </span>
                    </span>
                  </label>
                  <label
                    style={{
                      display: "flex",
                      gap: 9,
                      alignItems: "center",
                      cursor: "pointer",
                    }}
                  >
                    <Checkbox
                      checked={ch.onRunFailed}
                      onChange={(v) => patchChannel(key, { onRunFailed: v })}
                    />
                    <span
                      style={{
                        fontSize: "var(--text-body)",
                        color: "var(--ink)",
                      }}
                    >
                      When a run fails
                    </span>
                  </label>
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
                      disabled={
                        tBusy || !loaded || !ch.id || !ch.webhookUrl.trim()
                      }
                      loading={tBusy}
                      onClick={() => void testChannel(key)}
                      title={
                        !ch.id
                          ? "Save the channel first"
                          : ch.webhookUrl.trim()
                            ? `POST a sample message to this ${meta.title} webhook`
                            : "Add a webhook URL first"
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
                        ch.id ? "Delete this webhook" : "Discard this draft"
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
                          ? "✓ Test sent — check your channel."
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
  );
}
