---
title: 'Read and send Outlook mail and manage calendar events via Microsoft Graph.'
provider: msgraph
label: 'Microsoft Graph'
category: 'Productivity'
authType: bearer
serverUrlRequired: false
actionCount: 4
writeActionCount: 2
oneClickTestable: false
liveVerified: false
---

<!-- Sections marked GENERATED come from packages/dsl/src/integrations.ts via
     `pnpm gen:integration-docs`. Edit the catalog (or
     packages/dsl/src/docs/integration-prose.ts for the prose), never this file —
     packages/dsl/test/integration-docs.spec.ts fails on drift. -->

# Microsoft Graph

Read and send Outlook mail and manage calendar events via Microsoft Graph.

## Before you start

- **You need:** a Microsoft Graph OAuth access token.
- **Scopes / permissions:** `Mail.Read`, `Mail.Send`, `Calendars.ReadWrite` as required
- **How the token is sent:** A standard `Authorization: Bearer <token>` header. Paste only the token.
- **Server URL:** not needed — Naary always calls `https://graph.microsoft.com/v1.0`.

## Get your credentials

1. Register an application in **Microsoft Entra ID (Azure AD) → App registrations**.
2. Add the Graph permissions below and grant admin consent.
3. Obtain an access token for the app (client-credentials flow for unattended use).

## Connect it in Naary

1. Go to **Integrations → Connect a server**.
2. Pick the **Microsoft Graph** tile (or *Custom* if you are configuring it by hand).
3. Leave **Server URL** as the default — this provider has a fixed API base.
4. Paste the credential into the token field and save.
5. Connections are **per environment** — a sandbox connection and a prod connection are separate rows, so test credentials can never be used by a production run.

## Verify it works

**No one-click check:** its read actions all need an id you have to supply, so there is no safe argument-free call to probe with.

Either way, the definitive check is **single-node Test** on the canvas: drop a **Microsoft Graph** node, pick this connection, choose a read action and fill its ids, and run just that node. It executes the real activity with the real credential and shows you the provider's actual response.

> **Not yet proven against the real API.** This provider's request shape is typed and unit-tested, but no automated test has ever called the live service. If your first call fails with a 4xx, the fault may be ours — check `docs/integrations/VERIFICATION.md` and open an issue rather than assuming your token is wrong.

## Actions

| Action | Method | Endpoint | Required fields | Optional fields |
| --- | --- | --- | --- | --- |
| List messages | `GET` | `/users/{userId}/messages` | `userId` | — |
| **Send mail** (write) | `POST` | `/users/{userId}/sendMail` | `userId`, `message` | `saveToSentItems` |
| List events | `GET` | `/users/{userId}/events` | `userId` | — |
| **Create event** (write) | `POST` | `/users/{userId}/events` | `userId`, `subject`, `start`, `end` | — |

Fields can be typed in statically or **bound** to an upstream step's output (`{ from: <nodeId>, path: <dotted.path> }`) — ids and generated text are usually bound.

The 2 write actions run **at-most-once**: a transient failure fails the node instead of retrying, so a lost response cannot double-post. Re-run deliberately if you need to.

## Output

`{ status, ok, body }` — `status` is the HTTP status code, `ok` is whether it was 2xx, and `body` is the provider's parsed response. Branch on `<nodeId>.status` with an `if` or `switch` node.

## Gotchas

- Graph access tokens last about an hour — plan for rotation on any unattended workflow.
- `userId` is the user's object id or UPN. **`me` only works for delegated (user) tokens** — with an application (client-credentials) token you must address the user explicitly, e.g. `/users/{id}/sendMail`; `/me/sendMail` is rejected outright.
- Application permissions reach the **whole tenant** unless you scope them — a mail-send app can send as anyone.

## Troubleshooting

| Symptom | Most likely cause |
| --- | --- |
| **401 / 403 on every call** | The credential is wrong, expired, or missing a scope. Paste only the token, with no `Bearer ` prefix of your own. |
| **`host is not allowed` / egress error** | The target resolves to a private or loopback address. Naary's SSRF guard blocks those, so self-hosted instances must be reachable at a public hostname. |
| **Works in sandbox, fails in prod (or vice versa)** | Connections are per-environment. Each environment needs its own connection row with its own credential. |
| **Node output shows `status: 200` but nothing happened** | Some providers report failures in the body with a 200. Check `<nodeId>.body` before trusting the status. |

---

Adding a node to a canvas, binding fields and reading output are the same for every provider — see [the integrations overview](./README.md). For how any of this is verified, see [VERIFICATION.md](./VERIFICATION.md).
