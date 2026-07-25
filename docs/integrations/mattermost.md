---
title: 'Post to Mattermost channels and read recent posts from a workflow.'
provider: mattermost
label: 'Mattermost'
category: 'Communication'
authType: bearer
serverUrlRequired: true
actionCount: 5
writeActionCount: 2
oneClickTestable: false
liveVerified: false
---

<!-- Sections marked GENERATED come from packages/dsl/src/integrations.ts via
     `pnpm gen:integration-docs`. Edit the catalog (or docs/integration-prose.ts for the
     prose), never this file — packages/dsl/test/integration-docs.spec.ts fails on drift. -->

# Mattermost

Post to Mattermost channels and read recent posts from a workflow.

## Before you start

- **You need:** a personal access token or bot token.
- **How the token is sent:** A standard `Authorization: Bearer <token>` header. Paste only the token.
- **Server URL: required.** your Mattermost base URL, e.g. `https://chat.your-company.com` Getting this wrong is the most common cause of a setup that looks right and 404s.

## Get your credentials

1. Ask a Mattermost admin to enable personal access tokens (**System Console → Integrations**) if they are off.
2. Create a bot account under **Integrations → Bot Accounts** (preferred) or a personal access token in your own **Security** settings.

## Connect it in Naary

1. Go to **Integrations → Connect a server**.
2. Pick the **Mattermost** tile (or *Custom* if you are configuring it by hand).
3. Set **Server URL** to your Mattermost base URL, e.g. `https://chat.your-company.com`.
4. Paste the credential into the token field and save.
5. Connections are **per environment** — a sandbox connection and a prod connection are separate rows, so test credentials can never be used by a production run.

## Verify it works

**No one-click check:** its read actions all need an id you have to supply, so there is no safe argument-free call to probe with.

Either way, the definitive check is **single-node Test** on the canvas: drop a **Mattermost** node, pick this connection, choose a read action and fill its ids, and run just that node. It executes the real activity with the real credential and shows you the provider's actual response.

> **Not yet proven against the real API.** This provider's request shape is typed and unit-tested, but no automated test has ever called the live service. If your first call fails with a 4xx, the fault may be ours — check `docs/integrations/VERIFICATION.md` and open an issue rather than assuming your token is wrong.

## Actions

| Action | Method | Endpoint | Required fields | Optional fields |
| --- | --- | --- | --- | --- |
| **Send message** (write) | `POST` | `/api/v4/posts` | `channel_id`, `message` | `root_id` |
| Get channel by name | `GET` | `/api/v4/teams/name/{teamName}/channels/name/{channelName}` | `teamName`, `channelName` | — |
| List channel posts | `GET` | `/api/v4/channels/{channelId}/posts` | `channelId` | `per_page`, `page` |
| **Add reaction** (write) | `POST` | `/api/v4/reactions` | `user_id`, `post_id`, `emoji_name` | — |
| Get user by username | `GET` | `/api/v4/users/username/{username}` | `username` | — |

Fields can be typed in statically or **bound** to an upstream step's output (`{ from: <nodeId>, path: <dotted.path> }`) — ids and generated text are usually bound.

The 2 write actions run **at-most-once**: a transient failure fails the node instead of retrying, so a lost response cannot double-post. Re-run deliberately if you need to.

## Output

`{ status, ok, body }` — `status` is the HTTP status code, `ok` is whether it was 2xx, and `body` is the provider's parsed response. Branch on `<nodeId>.status` with an `if` or `switch` node.

## Gotchas

- **Self-hosted, and the egress guard blocks private addresses.** A Mattermost on an internal-only network is not reachable from Naary — it must resolve to a public host.
- The bot must be **added to the channel** it posts in.

## Troubleshooting

| Symptom | Most likely cause |
| --- | --- |
| **401 / 403 on every call** | The credential is wrong, expired, or missing a scope. Paste only the token, with no `Bearer ` prefix of your own. |
| **404 on a call that should work** | The Server URL is wrong. Re-read the format above — a missing path suffix or version segment produces a 404, not a helpful error. |
| **`host is not allowed` / egress error** | The target resolves to a private or loopback address. Naary's SSRF guard blocks those, so self-hosted instances must be reachable at a public hostname. |
| **Works in sandbox, fails in prod (or vice versa)** | Connections are per-environment. Each environment needs its own connection row with its own credential. |
| **Node output shows `status: 200` but nothing happened** | Some providers report failures in the body with a 200. Check `<nodeId>.body` before trusting the status. |

---

Adding a node to a canvas, binding fields and reading output are the same for every provider — see [the integrations overview](./README.md). For how any of this is verified, see [VERIFICATION.md](./VERIFICATION.md).
