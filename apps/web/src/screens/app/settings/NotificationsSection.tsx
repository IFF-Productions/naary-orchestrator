// Notification channels (Slack/Teams) section of the Settings screen. A workspace can
// have ANY NUMBER of channels per type (e.g. two Slack webhooks for #alerts and #oncall) —
// each is its own card, saved/tested/deleted independently.
import { Button, Card } from "../../../components";
import type {
  NotificationChannel,
  NotificationChannelType,
} from "../../../lib/api";
import { Field, inputStyle } from "./shared";

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
  channels,
  loaded,
  notifBusy,
  notifStatus,
  notifTestBusy,
  notifTest,
  patchChannel,
  addChannel,
  saveChannel,
  deleteChannel,
  testChannel,
}: {
  channels: EditableChannel[];
  loaded: boolean;
  notifBusy: Record<string, boolean>;
  notifStatus: Record<string, string>;
  notifTestBusy: Record<string, boolean>;
  notifTest: Record<string, { ok: boolean; message?: string }>;
  patchChannel: (localKey: string, patch: Partial<EditableChannel>) => void;
  addChannel: (type: NotificationChannelType) => void;
  saveChannel: (localKey: string) => Promise<void>;
  deleteChannel: (localKey: string) => Promise<void>;
  testChannel: (localKey: string) => Promise<void>;
}) {
  return (
    <>
      <div
        className="mono"
        style={{
          fontSize: "var(--text-2xs)",
          fontWeight: "var(--weight-semibold)",
          letterSpacing: "var(--tracking-label)",
          textTransform: "uppercase",
          color: "var(--ink-3)",
          margin: "24px 0 12px",
        }}
      >
        Notifications
      </div>
      <div
        style={{
          fontSize: "var(--text-body)",
          lineHeight: "var(--leading-snug)",
          color: "var(--ink-2)",
          marginBottom: 12,
        }}
      >
        Get pinged when a run needs a human — an approval can wait for days, so
        it shouldn't rely on someone watching the inbox. We POST a formatted
        message (with Approve / Reject / View-run buttons) on each event. Add as
        many webhooks as you need — e.g. Slack #alerts AND #oncall; alerts go to
        every enabled one.
      </div>
      <div
        style={{
          fontSize: "var(--text-sm)",
          color: "var(--ink-3)",
          marginBottom: 12,
        }}
      >
        Channels belong to the current environment — each environment routes its
        own alerts, so a sandbox failure never pages production's channels.
      </div>
      {channels.map((ch) => {
        const meta = CHANNEL_META[ch.type];
        const key = ch.localKey;
        const busy = !!notifBusy[key];
        const testBusy = !!notifTestBusy[key];
        const chStatus = notifStatus[key];
        const chTest = notifTest[key];
        return (
          <Card
            key={key}
            style={{
              padding: 18,
              marginBottom: 12,
              opacity: ch.enabled ? 1 : 0.72,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 14,
                gap: 12,
              }}
            >
              <div
                style={{
                  fontSize: "var(--text-body)",
                  fontWeight: "var(--weight-semibold)",
                  color: "var(--ink)",
                  whiteSpace: "nowrap",
                }}
              >
                {meta.title}
                {!ch.id && (
                  <span
                    style={{
                      marginLeft: 8,
                      fontSize: "var(--text-2xs)",
                      color: "var(--ink-3)",
                      fontWeight: "var(--weight-regular)",
                    }}
                  >
                    (not saved yet)
                  </span>
                )}
              </div>
              <label
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  cursor: loaded ? "pointer" : "default",
                }}
                title={`Turn this ${meta.title} webhook on or off`}
              >
                <input
                  type="checkbox"
                  checked={ch.enabled}
                  onChange={(e) =>
                    patchChannel(key, { enabled: e.target.checked })
                  }
                  disabled={!loaded}
                />
                <span
                  style={{ fontSize: "var(--text-sm)", color: "var(--ink-2)" }}
                >
                  {ch.enabled ? "Enabled" : "Disabled"}
                </span>
              </label>
            </div>
            {meta.hint && (
              <div
                style={{
                  fontSize: "var(--text-sm)",
                  color: "var(--ink-3)",
                  margin: "0 0 12px",
                  lineHeight: "var(--leading-snug)",
                }}
              >
                {meta.hint}
              </div>
            )}
            <Field label="Label">
              <input
                value={ch.label}
                onChange={(e) => patchChannel(key, { label: e.target.value })}
                placeholder={
                  ch.type === "slack" ? "#alerts (optional)" : "Ops (optional)"
                }
                style={inputStyle}
                disabled={!loaded}
              />
            </Field>
            <Field label="Webhook URL">
              <input
                value={ch.webhookUrl}
                onChange={(e) =>
                  patchChannel(key, { webhookUrl: e.target.value })
                }
                placeholder={meta.placeholder}
                style={inputStyle}
                disabled={!loaded}
              />
            </Field>
            <label
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                marginBottom: 10,
              }}
            >
              <input
                type="checkbox"
                checked={ch.onApprovalPending}
                onChange={(e) =>
                  patchChannel(key, { onApprovalPending: e.target.checked })
                }
                disabled={!loaded}
              />
              <span
                style={{ fontSize: "var(--text-body)", color: "var(--ink)" }}
              >
                When an approval is waiting
              </span>
            </label>
            <label
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                marginBottom: 14,
              }}
            >
              <input
                type="checkbox"
                checked={ch.onRunFailed}
                onChange={(e) =>
                  patchChannel(key, { onRunFailed: e.target.checked })
                }
                disabled={!loaded}
              />
              <span
                style={{ fontSize: "var(--text-body)", color: "var(--ink)" }}
              >
                When a run fails
              </span>
            </label>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <Button
                variant="primary"
                loading={busy}
                disabled={!loaded}
                onClick={() => void saveChannel(key)}
              >
                {busy ? "Saving…" : "Save"}
              </Button>
              <Button
                variant="secondary"
                icon="bell"
                disabled={
                  testBusy || !loaded || !ch.id || !ch.webhookUrl.trim()
                }
                onClick={() => void testChannel(key)}
                title={
                  !ch.id
                    ? "Save the channel first"
                    : ch.webhookUrl.trim()
                      ? `POST a sample message to this ${meta.title} webhook`
                      : "Add a webhook URL first"
                }
              >
                {testBusy ? "Sending…" : "Send test"}
              </Button>
              <Button
                variant="secondary"
                icon="trash"
                disabled={busy || !loaded}
                onClick={() => void deleteChannel(key)}
                title={ch.id ? "Delete this webhook" : "Discard this draft"}
              >
                {ch.id ? "Delete" : "Discard"}
              </Button>
              {chStatus && (
                <span
                  style={{
                    fontSize: "var(--text-sm)",
                    color: "var(--state-done)",
                  }}
                >
                  {chStatus}
                </span>
              )}
              {chTest && (
                <span
                  style={{
                    fontSize: "var(--text-sm)",
                    color: chTest.ok
                      ? "var(--state-done)"
                      : "var(--state-error)",
                  }}
                >
                  {chTest.ok
                    ? "✓ Test sent — check your channel."
                    : chTest.message}
                </span>
              )}
            </div>
          </Card>
        );
      })}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        {(Object.keys(CHANNEL_META) as NotificationChannelType[]).map(
          (type) => (
            <Button
              key={type}
              variant="secondary"
              icon="plus"
              disabled={!loaded}
              onClick={() => addChannel(type)}
            >
              Add {CHANNEL_META[type].title} webhook
            </Button>
          ),
        )}
      </div>
    </>
  );
}
