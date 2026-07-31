// ── Discord (cloud, discord.com/api/v10; auth = a bot token sent as
//    `Authorization: Bot <token>`, a custom header form, not a plain Bearer (#655).
//    `get_me` is the credential probe) ─────────────────────────────────────────────────
import type { IntegrationProvider } from "../types";

export const DISCORD: IntegrationProvider = {
  key: "discord",
  label: "Discord",
  baseUrl: "https://discord.com/api/v10",
  authScheme: { header: "Authorization", prefix: "Bot " },
  description:
    "Act on Discord — send channel messages, read channels/messages, open DMs, and react.",
  auth: "A custom connection whose token is a Discord bot token — sent as `Authorization: Bot <token>` (#655).",
  actions: [
    {
      key: "send_message",
      label: "Send message",
      description: "Send a message to a channel.",
      method: "POST",
      pathTemplate: "/channels/{channelId}/messages",
      write: true,
      fields: [
        {
          key: "channelId",
          label: "Channel id",
          in: "path",
          required: true,
        },
        { key: "content", label: "Content", in: "body", required: true },
        {
          key: "tts",
          label: "Text-to-speech",
          in: "body",
          required: false,
          type: "boolean",
        },
        {
          key: "embeds",
          label: "Embeds (JSON)",
          in: "body",
          required: false,
          type: "json",
          hint: "array of Discord embed objects",
        },
      ],
    },
    {
      key: "get_channel",
      label: "Get channel",
      description: "Fetch a channel by id.",
      method: "GET",
      pathTemplate: "/channels/{channelId}",
      write: false,
      fields: [
        { key: "channelId", label: "Channel id", in: "path", required: true },
      ],
    },
    {
      key: "list_messages",
      label: "List messages",
      description: "List messages in a channel, with optional paging.",
      method: "GET",
      pathTemplate: "/channels/{channelId}/messages",
      write: false,
      fields: [
        { key: "channelId", label: "Channel id", in: "path", required: true },
        {
          key: "limit",
          label: "Limit",
          in: "query",
          required: false,
          type: "number",
          hint: "1–100 (default 50)",
        },
        {
          key: "before",
          label: "Before",
          in: "query",
          required: false,
          hint: "message id — get messages before this id",
        },
        {
          key: "after",
          label: "After",
          in: "query",
          required: false,
          hint: "message id — get messages after this id",
        },
      ],
    },
    {
      key: "create_dm",
      label: "Create DM",
      description: "Open (or fetch) a DM channel with a user.",
      method: "POST",
      pathTemplate: "/users/@me/channels",
      write: true,
      fields: [
        {
          key: "recipient_id",
          label: "Recipient id",
          in: "body",
          required: true,
          hint: "the user id to DM",
        },
      ],
    },
    {
      key: "add_reaction",
      label: "Add reaction",
      description: "React to a message with an emoji (as the bot).",
      method: "PUT",
      pathTemplate:
        "/channels/{channelId}/messages/{messageId}/reactions/{emoji}/@me",
      // A mutation: it adds a visible reaction to someone's message. Was mismarked `write: false`,
      // which (a) made the interpreter RETRY it — Discord's PUT is idempotent so no duplicate
      // reaction, but a failed call read as a branchable result instead of failing the node — and
      // (b) put it in the pool "Test connection" (#701) selects a safe read from, where the only
      // thing keeping it out was its required fields. Slack's identical `add_reaction` is `true`.
      write: true,
      fields: [
        { key: "channelId", label: "Channel id", in: "path", required: true },
        { key: "messageId", label: "Message id", in: "path", required: true },
        {
          key: "emoji",
          label: "Emoji",
          in: "path",
          required: true,
          hint: "a unicode emoji (e.g. 👍) or `name:id` for a custom emoji — it's URL-encoded automatically",
        },
      ],
    },
    {
      key: "get_me",
      label: "Get current bot user",
      description:
        "Return the bot user this token belongs to. Needs no arguments, so it is the connection check.",
      method: "GET",
      pathTemplate: "/users/@me",
      write: false,
      probe: true,
      fields: [],
    },
  ],
};
