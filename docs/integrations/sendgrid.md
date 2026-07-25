---
title: 'Send transactional email and manage contacts via SendGrid.'
provider: sendgrid
label: 'SendGrid'
category: 'Marketing'
authType: bearer
serverUrlRequired: false
actionCount: 3
writeActionCount: 2
oneClickTestable: true
probeAction: list_templates
liveVerified: false
---

<!-- Sections marked GENERATED come from packages/dsl/src/integrations.ts via
     `pnpm gen:integration-docs`. Edit the catalog (or docs/integration-prose.ts for the
     prose), never this file — packages/dsl/test/integration-docs.spec.ts fails on drift. -->

# SendGrid

Send transactional email and manage contacts via SendGrid.

## Before you start

- **You need:** an API key.
- **Scopes / permissions:** *Mail Send* at minimum; add *Marketing* for the contacts action
- **How the token is sent:** A standard `Authorization: Bearer <token>` header. Paste only the token.
- **Server URL:** not needed — Naary always calls `https://api.sendgrid.com/v3`.

## Get your credentials

1. In SendGrid, open **Settings → API Keys** and create a key with the access below.
2. Verify a sender identity (**Settings → Sender Authentication**) — SendGrid rejects mail from unverified senders.

## Connect it in Naary

1. Go to **Integrations → Connect a server**.
2. Pick the **SendGrid** tile (or *Custom* if you are configuring it by hand).
3. Leave **Server URL** as the default — this provider has a fixed API base.
4. Paste the credential into the token field and save.
5. Connections are **per environment** — a sandbox connection and a prod connection are separate rows, so test credentials can never be used by a production run.

## Verify it works

**One-click:** this provider has an argument-free read (`list_templates` → `GET /templates`), so a connection test can confirm the credential without touching your data.

Either way, the definitive check is **single-node Test** on the canvas: drop a **SendGrid** node, pick this connection and the *List templates* action, and run just that node. It executes the real activity with the real credential and shows you the provider's actual response.

> **Not yet proven against the real API.** This provider's request shape is typed and unit-tested, but no automated test has ever called the live service. If your first call fails with a 4xx, the fault may be ours — check `docs/integrations/VERIFICATION.md` and open an issue rather than assuming your token is wrong.

## Actions

| Action | Method | Endpoint | Required fields | Optional fields |
| --- | --- | --- | --- | --- |
| **Send mail** (write) | `POST` | `/mail/send` | `personalizations`, `from`, `subject`, `content` | — |
| **Upsert contacts** (write) | `PUT` | `/marketing/contacts` | `contacts` | — |
| List templates | `GET` | `/templates` | — | `generations` |

Fields can be typed in statically or **bound** to an upstream step's output (`{ from: <nodeId>, path: <dotted.path> }`) — ids and generated text are usually bound.

The 2 write actions run **at-most-once**: a transient failure fails the node instead of retrying, so a lost response cannot double-post. Re-run deliberately if you need to.

## Output

`{ status, ok, body }` — `status` is the HTTP status code, `ok` is whether it was 2xx, and `body` is the provider's parsed response. Branch on `<nodeId>.status` with an `if` or `switch` node.

## Gotchas

- An unverified `from` address fails with 403 even though the key is valid. Sender verification is a separate step.
- *Send mail* takes SendGrid's nested `personalizations` shape — usually easier to build in a `set` node and bind in.
- For ordinary transactional mail, Naary's own `sendEmail` node over SMTP is simpler; use SendGrid when you want their templates and analytics.

## Troubleshooting

| Symptom | Most likely cause |
| --- | --- |
| **401 / 403 on every call** | The credential is wrong, expired, or missing a scope. Paste only the token, with no `Bearer ` prefix of your own. |
| **`host is not allowed` / egress error** | The target resolves to a private or loopback address. Naary's SSRF guard blocks those, so self-hosted instances must be reachable at a public hostname. |
| **Works in sandbox, fails in prod (or vice versa)** | Connections are per-environment. Each environment needs its own connection row with its own credential. |
| **Node output shows `status: 200` but nothing happened** | Some providers report failures in the body with a 200. Check `<nodeId>.body` before trusting the status. |

---

Adding a node to a canvas, binding fields and reading output are the same for every provider — see [the integrations overview](./README.md). For how any of this is verified, see [VERIFICATION.md](./VERIFICATION.md).
