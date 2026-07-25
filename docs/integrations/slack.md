---
title: 'Post and update Slack messages, and react to them, from a workflow.'
provider: slack
label: 'Slack'
category: 'Communication'
authType: bearer
serverUrlRequired: false
actionCount: 3
writeActionCount: 3
oneClickTestable: false
liveVerified: false
---

<!-- Sections marked GENERATED come from packages/dsl/src/integrations.ts via
     `pnpm gen:integration-docs`. Edit the catalog (or
     packages/dsl/src/docs/integration-prose.ts for the prose), never this file —
     packages/dsl/test/integration-docs.spec.ts fails on drift. -->

# Slack

Post and update Slack messages, and react to them, from a workflow.

## Before you start

- **You need:** a bot user OAuth token (`xoxb-…`).
- **Scopes / permissions:** `chat:write`, plus `reactions:write` for the reaction action
- **How the token is sent:** A standard `Authorization: Bearer <token>` header. Paste only the token.
- **Server URL:** not needed — Naary always calls `https://slack.com/api`.

## Get your credentials

1. Create an app at **api.slack.com/apps** for your workspace.
2. Under **OAuth & Permissions**, add the bot token scopes below, install the app, and copy the **Bot User OAuth Token**.
3. Invite the bot into each channel it will post in (`/invite @your-app`).

## Connect it in Naary

1. Go to **Integrations → Connect a server**.
2. Pick the **Slack** tile (or *Custom* if you are configuring it by hand).
3. Leave **Server URL** as the default — this provider has a fixed API base.
4. Paste the credential into the token field and save.
5. Connections are **per environment** — a sandbox connection and a prod connection are separate rows, so test credentials can never be used by a production run.

## Verify it works

**No one-click check:** every action here writes, so there is no safe argument-free call to probe with.

Either way, the definitive check is **single-node Test** on the canvas: drop a **Slack** node, pick this connection, choose an action and fill its fields, and run just that node. It executes the real activity with the real credential and shows you the provider's actual response.

Every Slack action writes, so this test performs a **real** action on your account — send to a scratch channel or test record, not a live one.

A concrete first run:

1. Create a scratch channel and invite the bot to it.
2. Add a **Post message** node with that `channel` and any `text`, and run it.
3. Confirm the message appears and the output shows `body.ok: true` with a `ts`.
4. Then chain **Add reaction**, binding `timestamp` to `<post-node>.body.ts`.

> **Not yet proven against the real API.** This provider's request shape is typed and unit-tested, but no automated test has ever called the live service. If your first call fails with a 4xx, the fault may be ours — check `docs/integrations/VERIFICATION.md` and open an issue rather than assuming your token is wrong.

## Actions

| Action | Method | Endpoint | Required fields | Optional fields |
| --- | --- | --- | --- | --- |
| **Post message** (write) | `POST` | `/chat.postMessage` | `channel`, `text` | `threadTs` |
| **Update message** (write) | `POST` | `/chat.update` | `channel`, `ts`, `text` | — |
| **Add reaction** (write) | `POST` | `/reactions.add` | `channel`, `timestamp`, `name` | — |

Fields can be typed in statically or **bound** to an upstream step's output (`{ from: <nodeId>, path: <dotted.path> }`) — ids and generated text are usually bound.

The 3 write actions run **at-most-once**: a transient failure fails the node instead of retrying, so a lost response cannot double-post. Re-run deliberately if you need to.

### Flat fields → nested payload

You fill in flat fields; the node assembles the nested body the API expects.

- **Post message**: `threadTs` → `thread_ts`

## Output

`{ status, ok, body }` — `status` is the HTTP status code, `ok` is whether it was 2xx, and `body` is the provider's parsed response. Branch on `<nodeId>.status` with an `if` or `switch` node.

## Gotchas

- A bot that has not been invited to the channel gets `not_in_channel` — inviting is separate from installing.
- Slack answers `200 OK` even when the call **failed**: the real result is `body.ok`. Branch on `<nodeId>.body.ok`, not on `status`.
- Channel can be an id (`C0…`, stable) or `#name` (breaks when renamed). Prefer the id.
- For run notifications and approval buttons, use a **notification channel** instead — that path is already built and has a send-test.

## Troubleshooting

| Symptom | Most likely cause |
| --- | --- |
| **401 / 403 on every call** | The credential is wrong, expired, or missing a scope. Paste only the token, with no `Bearer ` prefix of your own. |
| **`host is not allowed` / egress error** | The target resolves to a private or loopback address. Naary's SSRF guard blocks those, so self-hosted instances must be reachable at a public hostname. |
| **Works in sandbox, fails in prod (or vice versa)** | Connections are per-environment. Each environment needs its own connection row with its own credential. |
| **Node output shows `status: 200` but nothing happened** | Some providers report failures in the body with a 200. Check `<nodeId>.body` before trusting the status. |

---

Adding a node to a canvas, binding fields and reading output are the same for every provider — see [the integrations overview](./README.md). For how any of this is verified, see [VERIFICATION.md](./VERIFICATION.md).
