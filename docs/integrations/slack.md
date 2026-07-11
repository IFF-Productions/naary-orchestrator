# Slack integration

Post to Slack from a workflow — send a message, reply in a thread, or add a reaction. Pairs
naturally with human-approval ("notify a channel, then wait for a decision").

## Setup

1. **Create a Slack app + bot token.** At <https://api.slack.com/apps>, create an app, add the
   bot scopes you need (`chat:write` to post, `chat:write` + message ownership to update,
   `reactions:write` to react), install it to your workspace, and copy the **Bot User OAuth Token**
   (`xoxb-…`).
2. **Add the connection.** In **Integrations → Connect a server**:
   - **Type:** Custom
   - **Server URL:** `https://slack.com` (unused — the node calls `slack.com/api` directly)
   - **Auth (token):** the `xoxb-…` bot token (sent as a Bearer token).
3. **Add the Slack node**, pick this connection, choose an action, and fill the fields.

> Invite the bot to any private channel it should post in (`/invite @your-app`).

## Actions

| Action | Method | Endpoint | Fields (\* required) |
| --- | --- | --- | --- |
| **Post message** (write) | POST | `/chat.postMessage` | channel\*, text\*, threadTs |
| **Update message** (write) | POST | `/chat.update` | channel\*, ts\*, text\* |
| **Add reaction** (write) | POST | `/reactions.add` | channel\*, timestamp\*, name\* |

- `channel` is a `#channel` name or a channel ID; `threadTs` replies under a message's `ts`.
- `name` (reaction) is the emoji name **without** colons, e.g. `white_check_mark`.
- Write actions run **at-most-once** (no auto-retry) so a lost response can't double-post.

## Output

`{ status, ok, body }`. **Note:** Slack returns HTTP `200` even for logical failures — check
**`<nodeId>.body.ok`** (Slack's own flag) and `body.error`, not just the HTTP `status`. On success,
`body.ts` is the posted message's timestamp (feed it into *Update message* / *Add reaction*).

## Verify it works (live smoke test)

1. Point the connection at a test workspace; invite the bot to a test channel.
2. Add **Slack → Post message**, set `channel` (e.g. `#test`) and `text`, run the workflow.
3. Confirm the message appears and the node output shows `body.ok: true` with a `ts`. Then wire
   **Add reaction** binding `timestamp` to `<post-node>.body.ts`.
