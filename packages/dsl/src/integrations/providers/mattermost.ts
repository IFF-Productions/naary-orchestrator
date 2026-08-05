// ── Mattermost (self-hosted or Cloud; base = the connection's server URL, e.g.
//    https://chat.acme.com. Auth: a personal access token or bot token as a Bearer —
//    exactly what the API v4 expects, so the default "bearer" scheme is correct) ─────────
import type { IntegrationProvider } from "../types";

export const MATTERMOST: IntegrationProvider = {
  key: "mattermost",
  label: "Mattermost",
  baseUrlFromConnection: true,
  serverUrlExample: "https://your-mattermost.example.com",
  authScheme: "bearer",
  description:
    "Post to Mattermost — send a message, reply in a thread, react, or read channel history.",
  auth: "A custom connection whose Server URL is your Mattermost base URL (e.g. https://chat.your-company.com) and whose token is a personal access token or bot token, sent as `Authorization: Bearer <token>` (Mattermost API v4).",
  actions: [
    {
      key: "send_message",
      label: "Send message",
      description:
        "Create a post in a channel — or reply in a thread by setting the root post id.",
      method: "POST",
      pathTemplate: "/api/v4/posts",
      write: true,
      fields: [
        {
          key: "channel_id",
          label: "Channel id",
          in: "body",
          required: true,
          hint: "26-char channel id — resolve a name with 'Get channel by name'",
        },
        { key: "message", label: "Message", in: "body", required: true },
        {
          key: "root_id",
          label: "Thread root post id",
          in: "body",
          required: false,
          hint: "reply inside that post's thread",
        },
      ],
    },
    {
      key: "get_channel_by_name",
      label: "Get channel by name",
      description:
        "Resolve a team + channel name to the channel (and its id) — feed it to Send message.",
      method: "GET",
      pathTemplate: "/api/v4/teams/name/{teamName}/channels/name/{channelName}",
      write: false,
      fields: [
        {
          key: "teamName",
          label: "Team name",
          in: "path",
          required: true,
          hint: "the team's URL slug, e.g. acme",
        },
        {
          key: "channelName",
          label: "Channel name",
          in: "path",
          required: true,
          hint: "the channel's URL slug, e.g. town-square",
        },
      ],
    },
    {
      key: "list_channel_posts",
      label: "List channel posts",
      description: "Read a channel's recent posts (newest first).",
      method: "GET",
      pathTemplate: "/api/v4/channels/{channelId}/posts",
      write: false,
      fields: [
        { key: "channelId", label: "Channel id", in: "path", required: true },
        {
          key: "per_page",
          label: "Per page",
          in: "query",
          required: false,
          type: "number",
        },
        {
          key: "page",
          label: "Page",
          in: "query",
          required: false,
          type: "number",
        },
      ],
    },
    {
      key: "add_reaction",
      label: "Add reaction",
      description: "React to a post with an emoji.",
      method: "POST",
      pathTemplate: "/api/v4/reactions",
      write: true,
      fields: [
        {
          key: "user_id",
          label: "User id",
          in: "body",
          required: true,
          hint: "the reacting user — the token's own user id",
        },
        { key: "post_id", label: "Post id", in: "body", required: true },
        {
          key: "emoji_name",
          label: "Emoji name",
          in: "body",
          required: true,
          hint: "without colons, e.g. white_check_mark",
        },
      ],
    },
    {
      key: "get_user_by_username",
      label: "Get user by username",
      description: "Look a user up by username (for their id / email).",
      method: "GET",
      pathTemplate: "/api/v4/users/username/{username}",
      write: false,
      fields: [
        { key: "username", label: "Username", in: "path", required: true },
      ],
    },
    {
      key: "get_me",
      label: "Get current user",
      description:
        "Return the user this token belongs to. Needs no arguments, so it is the connection check — and it also proves the Server URL points at a real Mattermost.",
      method: "GET",
      pathTemplate: "/api/v4/users/me",
      write: false,
      probe: true,
      fields: [],
    },
  ],
};
