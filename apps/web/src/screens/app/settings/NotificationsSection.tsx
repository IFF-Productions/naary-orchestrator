// Notification channels (Slack/Teams) section of the Settings screen.
import { Button, Card } from "../../../components";
import type {
  NotificationChannel,
  NotificationChannelType,
} from "../../../lib/api";
import { Field, inputStyle } from "./shared";

/** The notification channels the UI renders — each configured + toggled INDEPENDENTLY.
 *  Adding email later = one more entry here + the server-side type. */
export const NOTIFICATION_CHANNELS: {
  type: NotificationChannelType;
  label: string;
  placeholder: string;
  hint?: string;
}[] = [
  {
    type: "slack",
    label: "Slack",
    placeholder: "https://hooks.slack.com/services/…",
  },
  {
    type: "teams",
    label: "Microsoft Teams",
    placeholder: "https://prod-00.westus.logic.azure.com/workflows/…",
    hint: "Paste a Teams Workflows (Power Automate) webhook URL — “When a Teams webhook request is received”. We send an Adaptive Card; the legacy Office 365 connector format isn’t supported.",
  },
];

/** Channel config as held in edit state — webhookUrl is a string ("" not null) for the input. */
export type EditableChannel = Omit<NotificationChannel, "webhookUrl"> & {
  webhookUrl: string;
};

export function defaultChannel(type: NotificationChannelType): EditableChannel {
  return {
    type,
    enabled: false,
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
  saveChannel,
  testChannel,
}: {
  channels: Record<string, EditableChannel>;
  loaded: boolean;
  notifBusy: Record<string, boolean>;
  notifStatus: Record<string, string>;
  notifTestBusy: Record<string, boolean>;
  notifTest: Record<string, { ok: boolean; message?: string }>;
  patchChannel: (
    type: NotificationChannelType,
    patch: Partial<EditableChannel>,
  ) => void;
  saveChannel: (type: NotificationChannelType) => Promise<void>;
  testChannel: (type: NotificationChannelType) => Promise<void>;
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
        message (with Approve / Reject / View-run buttons) on each event.
        Configure each channel independently — enable the ones you use; alerts
        go to every enabled channel.
      </div>
      {NOTIFICATION_CHANNELS.map((meta) => {
        const ch = channels[meta.type];
        const busy = !!notifBusy[meta.type];
        const testBusy = !!notifTestBusy[meta.type];
        const chStatus = notifStatus[meta.type];
        const chTest = notifTest[meta.type];
        return (
          <Card
            key={meta.type}
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
              }}
            >
              <div
                style={{
                  fontSize: "var(--text-body)",
                  fontWeight: "var(--weight-semibold)",
                  color: "var(--ink)",
                }}
              >
                {meta.label}
              </div>
              <label
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  cursor: loaded ? "pointer" : "default",
                }}
                title={`Turn ${meta.label} notifications on or off`}
              >
                <input
                  type="checkbox"
                  checked={ch.enabled}
                  onChange={(e) =>
                    patchChannel(meta.type, { enabled: e.target.checked })
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
            <Field label="Webhook URL">
              <input
                value={ch.webhookUrl}
                onChange={(e) =>
                  patchChannel(meta.type, { webhookUrl: e.target.value })
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
                  patchChannel(meta.type, {
                    onApprovalPending: e.target.checked,
                  })
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
                  patchChannel(meta.type, { onRunFailed: e.target.checked })
                }
                disabled={!loaded}
              />
              <span
                style={{ fontSize: "var(--text-body)", color: "var(--ink)" }}
              >
                When a run fails
              </span>
            </label>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <Button
                variant="primary"
                loading={busy}
                disabled={!loaded}
                onClick={() => void saveChannel(meta.type)}
              >
                {busy ? "Saving…" : "Save"}
              </Button>
              <Button
                variant="secondary"
                icon="bell"
                disabled={testBusy || !loaded || !ch.webhookUrl.trim()}
                onClick={() => void testChannel(meta.type)}
                title={
                  ch.webhookUrl.trim()
                    ? `POST a sample message to your ${meta.label} webhook`
                    : "Add a webhook URL first"
                }
              >
                {testBusy ? "Sending…" : "Send test"}
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
    </>
  );
}
