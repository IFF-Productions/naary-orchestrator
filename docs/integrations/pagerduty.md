---
title: 'Raise, acknowledge and resolve PagerDuty incidents from a workflow.'
provider: pagerduty
label: 'PagerDuty'
category: 'Developer Tools'
authType: custom-header
serverUrlRequired: false
actionCount: 6
writeActionCount: 4
oneClickTestable: true
probeAction: list_incidents
liveVerified: false
---

<!-- Sections marked GENERATED come from packages/dsl/src/integrations.ts via
     `pnpm gen:integration-docs`. Edit the catalog (or docs/integration-prose.ts for the
     prose), never this file — packages/dsl/test/integration-docs.spec.ts fails on drift. -->

# PagerDuty

Raise, acknowledge and resolve PagerDuty incidents from a workflow.

## Before you start

- **You need:** a REST API key.
- **How the token is sent:** A custom header: `Authorization: Token token=<token>`. Naary applies this for you; paste only the token itself.
- **Server URL:** not needed — Naary always calls `https://api.pagerduty.com`.

## Get your credentials

1. In PagerDuty, open **Integrations → Developer Tools → API Access Keys** and click **Create New API Key**. You need to be an Admin or Account Owner.
2. Tick **Read-only API Key** unless the workflow needs to create or change incidents — a read-only key cannot page anyone by mistake.
3. Note whether it is account-scoped or user-scoped — that decides whether you must send a `From` address.

## Connect it in Naary

1. Go to **Integrations → Connect a server**.
2. Pick the **PagerDuty** tile (or *Custom* if you are configuring it by hand).
3. Leave **Server URL** as the default — this provider has a fixed API base.
4. Paste the credential into the token field and save.
5. Connections are **per environment** — a sandbox connection and a prod connection are separate rows, so test credentials can never be used by a production run.

## Verify it works

**One-click:** this provider has an argument-free read (`list_incidents` → `GET /incidents`), so a connection test can confirm the credential without touching your data.

Either way, the definitive check is **single-node Test** on the canvas: drop a **PagerDuty** node, pick this connection and the *List incidents* action, and run just that node. It executes the real activity with the real credential and shows you the provider's actual response.

> **Not yet proven against the real API.** This provider's request shape is typed and unit-tested, but no automated test has ever called the live service. If your first call fails with a 4xx, the fault may be ours — check `docs/integrations/VERIFICATION.md` and open an issue rather than assuming your token is wrong.

## Actions

| Action | Method | Endpoint | Required fields | Optional fields |
| --- | --- | --- | --- | --- |
| **Create incident** (write) | `POST` | `/incidents` | `title`, `serviceId` | `From`, `urgency`, `incident_key`, `details` |
| List incidents | `GET` | `/incidents` | — | `statuses[]`, `service_ids[]`, `since`, `until`, `limit`, `offset`, `sort_by` |
| Get incident | `GET` | `/incidents/{id}` | `id` | — |
| **Acknowledge incident** (write) | `PUT` | `/incidents/{id}` | `id` | `From` |
| **Resolve incident** (write) | `PUT` | `/incidents/{id}` | `id` | `From`, `resolution` |
| **Add note** (write) | `POST` | `/incidents/{id}/notes` | `id`, `content` | `From` |

Fields can be typed in statically or **bound** to an upstream step's output (`{ from: <nodeId>, path: <dotted.path> }`) — ids and generated text are usually bound.

The 4 write actions run **at-most-once**: a transient failure fails the node instead of retrying, so a lost response cannot double-post. Re-run deliberately if you need to.

### Flat fields → nested payload

You fill in flat fields; the node assembles the nested body the API expects.

- **Create incident**: `title` → `incident.title`, `serviceId` → `incident.service.id`, `urgency` → `incident.urgency`, `incident_key` → `incident.incident_key`, `details` → `incident.body.details`
- **Resolve incident**: `resolution` → `incident.resolution`
- **Add note**: `content` → `note.content`

## Output

`{ status, ok, body }` — `status` is the HTTP status code, `ok` is whether it was 2xx, and `body` is the provider's parsed response. Branch on `<nodeId>.status` with an `if` or `switch` node.

## Gotchas

- The header is `Authorization: Token token=<key>` — PagerDuty's own scheme, not a Bearer. Naary applies it.
- Write actions need a **`From` header set to a PagerDuty user's login email** unless the key is user-scoped. Without it you get 400.
- Creating an incident **pages a human.** Use a test service while you are wiring the workflow up.

## Troubleshooting

| Symptom | Most likely cause |
| --- | --- |
| **401 / 403 on every call** | The credential is wrong, expired, or missing a scope. Paste only the raw token — Naary adds the header and any prefix itself. |
| **`host is not allowed` / egress error** | The target resolves to a private or loopback address. Naary's SSRF guard blocks those, so self-hosted instances must be reachable at a public hostname. |
| **Works in sandbox, fails in prod (or vice versa)** | Connections are per-environment. Each environment needs its own connection row with its own credential. |
| **Node output shows `status: 200` but nothing happened** | Some providers report failures in the body with a 200. Check `<nodeId>.body` before trusting the status. |

---

Adding a node to a canvas, binding fields and reading output are the same for every provider — see [the integrations overview](./README.md). For how any of this is verified, see [VERIFICATION.md](./VERIFICATION.md).
