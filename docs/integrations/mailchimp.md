---
title: 'Add and update Mailchimp audience members, and create campaigns.'
provider: mailchimp
label: 'Mailchimp'
category: 'Marketing'
authType: bearer
serverUrlRequired: true
actionCount: 6
writeActionCount: 3
oneClickTestable: true
probeAction: ping
liveVerified: false
---

<!-- Sections marked GENERATED come from packages/dsl/src/integrations.ts via
     `pnpm gen:integration-docs`. Edit the catalog (or
     packages/dsl/src/docs/integration-prose.ts for the prose), never this file —
     packages/dsl/test/integration-docs.spec.ts fails on drift. -->

# Mailchimp

Add and update Mailchimp audience members, and create campaigns.

## Before you start

- **You need:** an API key.
- **How the token is sent:** A standard `Authorization: Bearer <token>` header. Paste only the token.
- **Server URL: required.** `https://{dc}.api.mailchimp.com/3.0`, where `{dc}` is your key's datacenter suffix (e.g. `us19`). A missing `/3.0` suffix 404s, but the **datacenter** — the part people actually get wrong — does not: a `{dc}` that disagrees with your key returns **401 with a perfectly valid key**, which looks like a bad credential. The suffix is printed after the `-` in the key itself.

## Get your credentials

1. In Mailchimp, open **Account → Extras → API keys** and create a key.
2. Read your **server prefix** off the browser URL after logging in — `https://us19.admin.mailchimp.com/` means `us19`. It is also the suffix on the key itself.
3. Read the **datacenter suffix** off the end of the key (e.g. `…-us19` → `us19`) — you need it for the Server URL.

## Connect it in Naary

1. Go to **Integrations → Connect a server**.
2. Pick the **Mailchimp** tile (or *Custom* if you are configuring it by hand).
3. Set **Server URL** to `https://{dc}.api.mailchimp.com/3.0`, where `{dc}` is your key's datacenter suffix (e.g. `us19`).
4. Paste the credential into the token field and save.
5. Connections are **per environment** — a sandbox connection and a prod connection are separate rows, so test credentials can never be used by a production run.

## Verify it works

**One-click:** this provider has an argument-free read (`ping` → `GET /ping`), so a connection test can confirm the credential without touching your data.

Either way, the definitive check is **single-node Test** on the canvas: drop a **Mailchimp** node, pick this connection and the *Ping (health check)* action, and run just that node. It executes the real activity with the real credential and shows you the provider's actual response.

> **Not yet proven against the real API.** This provider's request shape is typed and unit-tested, but no automated test has ever called the live service. If your first call fails with a 4xx, the fault may be ours — check `docs/integrations/VERIFICATION.md` and open an issue rather than assuming your token is wrong.

## Actions

| Action | Method | Endpoint | Required fields | Optional fields |
| --- | --- | --- | --- | --- |
| **Add member** (write) | `POST` | `/lists/{listId}/members` | `listId`, `email_address`, `status` | `merge_fields` |
| Get member | `GET` | `/lists/{listId}/members/{subscriberHash}` | `listId`, `subscriberHash` | — |
| **Update member** (write) | `PATCH` | `/lists/{listId}/members/{subscriberHash}` | `listId`, `subscriberHash` | `status`, `merge_fields` |
| List members | `GET` | `/lists/{listId}/members` | `listId` | `status`, `count` |
| **Create campaign** (write) | `POST` | `/campaigns` | `type` | `recipients`, `settings` |
| Ping (health check) | `GET` | `/ping` | — | — |

Fields can be typed in statically or **bound** to an upstream step's output (`{ from: <nodeId>, path: <dotted.path> }`) — ids and generated text are usually bound.

The 3 write actions run **at-most-once**: a transient failure fails the node instead of retrying, so a lost response cannot double-post. Re-run deliberately if you need to.

## Output

`{ status, ok, body }` — `status` is the HTTP status code, `ok` is whether it was 2xx, and `body` is the provider's parsed response. Branch on `<nodeId>.status` with an `if` or `switch` node.

## Gotchas

- The datacenter in the URL must match the one in your key, or every call 401s with a perfectly valid key.
- `listId` is the Audience ID from **Audience → Settings**.
- Mailchimp keys members by the MD5 hash of the lowercased email — the *Add member* action handles that, but a hand-built HTTP call would not.

## Troubleshooting

| Symptom | Most likely cause |
| --- | --- |
| **401 / 403 on every call** | The credential is wrong, expired, or missing a scope. Paste only the token, with no `Bearer ` prefix of your own. |
| **404 on a call that should work** | The Server URL is wrong. Re-read the format above — a missing or mistyped path segment produces a 404, not a helpful error. |
| **`host is not allowed` / egress error** | The target resolves to a private or loopback address. Naary's SSRF guard blocks those, so self-hosted instances must be reachable at a public hostname. |
| **Works in sandbox, fails in prod (or vice versa)** | Connections are per-environment. Each environment needs its own connection row with its own credential. |
| **Node output shows `status: 200` but nothing happened** | Some providers report failures in the body with a 200. Check `<nodeId>.body` before trusting the status. |

---

Adding a node to a canvas, binding fields and reading output are the same for every provider — see [the integrations overview](./README.md). For how any of this is verified, see [VERIFICATION.md](./VERIFICATION.md).
