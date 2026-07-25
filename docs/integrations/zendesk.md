---
title: 'Read, create and update Zendesk tickets from a workflow.'
provider: zendesk
label: 'Zendesk'
category: 'Communication'
authType: basic
serverUrlRequired: true
actionCount: 5
writeActionCount: 3
oneClickTestable: true
probeAction: list_tickets
liveVerified: false
---

<!-- Sections marked GENERATED come from packages/dsl/src/integrations.ts via
     `pnpm gen:integration-docs`. Edit the catalog (or docs/integration-prose.ts for the
     prose), never this file — packages/dsl/test/integration-docs.spec.ts fails on drift. -->

# Zendesk

Read, create and update Zendesk tickets from a workflow.

## Before you start

- **You need:** an API token, paired with your agent email.
- **How the token is sent:** HTTP Basic — Naary base64-encodes the credential pair for you. Paste the raw `user:secret` pair, not a pre-encoded string.
- **Server URL: required.** `https://{your-subdomain}.zendesk.com/api/v2` Getting this wrong is the most common cause of a setup that looks right and 404s.

## Get your credentials

1. In Zendesk Admin Center, open **Apps and integrations → APIs → Zendesk API** and enable **token access**, then add an API token.
2. Combine it as `your-email@company.com/token:your-api-token` — Naary sends that as HTTP Basic.

## Connect it in Naary

1. Go to **Integrations → Connect a server**.
2. Pick the **Zendesk** tile (or *Custom* if you are configuring it by hand).
3. Set **Server URL** to `https://{your-subdomain}.zendesk.com/api/v2`.
4. Paste the credential into the token field and save.
5. Connections are **per environment** — a sandbox connection and a prod connection are separate rows, so test credentials can never be used by a production run.

## Verify it works

**One-click:** this provider has an argument-free read (`list_tickets` → `GET /tickets.json`), so a connection test can confirm the credential without touching your data.

Either way, the definitive check is **single-node Test** on the canvas: drop a **Zendesk** node, pick this connection and the *List tickets* action, and run just that node. It executes the real activity with the real credential and shows you the provider's actual response.

> **Not yet proven against the real API.** This provider's request shape is typed and unit-tested, but no automated test has ever called the live service. If your first call fails with a 4xx, the fault may be ours — check `docs/integrations/VERIFICATION.md` and open an issue rather than assuming your token is wrong.

## Actions

| Action | Method | Endpoint | Required fields | Optional fields |
| --- | --- | --- | --- | --- |
| Get ticket | `GET` | `/tickets/{ticketId}.json` | `ticketId` | — |
| List tickets | `GET` | `/tickets.json` | — | `page`, `per_page` |
| **Create ticket** (write) | `POST` | `/tickets.json` | `subject` | `comment`, `priority`, `type` |
| **Update ticket** (write) | `PUT` | `/tickets/{ticketId}.json` | `ticketId` | `status`, `priority`, `comment` |
| **Create user** (write) | `POST` | `/users.json` | `name`, `email` | — |

Fields can be typed in statically or **bound** to an upstream step's output (`{ from: <nodeId>, path: <dotted.path> }`) — ids and generated text are usually bound.

The 3 write actions run **at-most-once**: a transient failure fails the node instead of retrying, so a lost response cannot double-post. Re-run deliberately if you need to.

### Flat fields → nested payload

You fill in flat fields; the node assembles the nested body the API expects.

- **Create ticket**: `subject` → `ticket.subject`, `comment` → `ticket.comment`, `priority` → `ticket.priority`, `type` → `ticket.type`
- **Update ticket**: `status` → `ticket.status`, `priority` → `ticket.priority`, `comment` → `ticket.comment`
- **Create user**: `name` → `user.name`, `email` → `user.email`

## Output

`{ status, ok, body }` — `status` is the HTTP status code, `ok` is whether it was 2xx, and `body` is the provider's parsed response. Branch on `<nodeId>.status` with an `if` or `switch` node.

## Gotchas

- The credential format is unusual: the literal string `/token` sits between your email and the token. Getting it wrong is the usual cause of a 401 here.
- Token access is **off by default** — enabling it is a separate admin step.

## Troubleshooting

| Symptom | Most likely cause |
| --- | --- |
| **401 / 403 on every call** | The credential is wrong, expired, or missing a scope. Check you pasted the full `user:secret` pair and not just the secret. |
| **404 on a call that should work** | The Server URL is wrong. Re-read the format above — a missing path suffix or version segment produces a 404, not a helpful error. |
| **`host is not allowed` / egress error** | The target resolves to a private or loopback address. Naary's SSRF guard blocks those, so self-hosted instances must be reachable at a public hostname. |
| **Works in sandbox, fails in prod (or vice versa)** | Connections are per-environment. Each environment needs its own connection row with its own credential. |
| **Node output shows `status: 200` but nothing happened** | Some providers report failures in the body with a 200. Check `<nodeId>.body` before trusting the status. |

---

Adding a node to a canvas, binding fields and reading output are the same for every provider — see [the integrations overview](./README.md). For how any of this is verified, see [VERIFICATION.md](./VERIFICATION.md).
