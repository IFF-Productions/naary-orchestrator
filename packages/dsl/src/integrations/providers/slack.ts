// ── Slack (Web API; static base slack.com/api; auth = a bot token `xoxb-…` as Bearer,
//    stored on a "custom" connection) ────────────────────────────────────────────────
import type { IntegrationProvider } from "../types";

export const SLACK: IntegrationProvider = {
  key: "slack",
  label: "Slack",
  baseUrl: "https://slack.com/api",
  description: "Post to Slack — send a message, reply in a thread, or react.",
  auth: "A custom connection whose token is a Slack bot token (`xoxb-…`) with the needed scopes (e.g. chat:write, reactions:write). The Server URL is unused (base is slack.com).",
  credentialSetup: {
    tokenUrl: "https://api.slack.com/apps",
    scopes: ["chat:write", "reactions:write"],
    steps: [
      "Create an app for your workspace at api.slack.com/apps.",
      "Under OAuth & Permissions add the bot token scopes above, then install the app to the workspace.",
      "Copy the Bot User OAuth Token (`xoxb-…`) — not the User token, and not the Signing Secret.",
      "Invite the bot into every channel it posts in (`/invite @your-app`); installing does not join channels.",
    ],
    tokenFormat:
      "Paste the bot token (`xoxb-…`) on its own — `Bearer ` is added for you. A `xoxp-…` user token or the app's Signing Secret will not work.",
  },
  unprobeableReason:
    "Slack can't be checked from here, and not because it lacks an endpoint: `auth.test` needs no " +
    'arguments, but the Slack Web API answers HTTP 200 with `{"ok": false}` for a dead token. ' +
    "The check reads the HTTP status, so probing it would call every expired Slack token healthy — " +
    "worse than saying nothing. Test a Slack connection with an integration node on a canvas " +
    "(single-node Test), which reads the response body.",
  actions: [
    {
      key: "post_message",
      label: "Post message",
      description: "Send a message to a channel (or reply in a thread).",
      method: "POST",
      pathTemplate: "/chat.postMessage",
      write: true,
      fields: [
        {
          key: "channel",
          label: "Channel",
          in: "body",
          required: true,
          hint: "#channel or a channel ID",
        },
        { key: "text", label: "Text", in: "body", required: true },
        {
          key: "threadTs",
          label: "Thread ts",
          in: "body",
          required: false,
          bodyPath: "thread_ts",
          hint: "reply under this message ts",
        },
      ],
    },
    {
      key: "update_message",
      label: "Update message",
      description: "Edit a message you posted.",
      method: "POST",
      pathTemplate: "/chat.update",
      write: true,
      fields: [
        { key: "channel", label: "Channel", in: "body", required: true },
        {
          key: "ts",
          label: "Message ts",
          in: "body",
          required: true,
          hint: "timestamp of the message to edit",
        },
        { key: "text", label: "Text", in: "body", required: true },
      ],
    },
    {
      key: "add_reaction",
      label: "Add reaction",
      description: "React to a message with an emoji.",
      method: "POST",
      pathTemplate: "/reactions.add",
      write: true,
      fields: [
        { key: "channel", label: "Channel", in: "body", required: true },
        { key: "timestamp", label: "Message ts", in: "body", required: true },
        {
          key: "name",
          label: "Emoji",
          in: "body",
          required: true,
          hint: "emoji name without colons, e.g. white_check_mark",
        },
      ],
    },
  ],
};
