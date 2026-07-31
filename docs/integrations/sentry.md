---
title: 'Triage Sentry issues from a workflow — list, inspect, resolve.'
provider: sentry
label: 'Sentry'
category: 'Developer Tools'
authType: bearer
serverUrlRequired: false
actionCount: 5
writeActionCount: 1
oneClickTestable: true
probeAction: list_organizations
liveVerified: false
---

<!-- Sections marked GENERATED come from packages/dsl/src/integrations.ts via
     `pnpm gen:integration-docs`. Edit the catalog (or
     packages/dsl/src/docs/integration-prose.ts for the prose), never this file —
     packages/dsl/test/integration-docs.spec.ts fails on drift. -->

# Sentry

Triage Sentry issues from a workflow — list, inspect, resolve.

## Before you start

- **You need:** an auth token.
- **Scopes / permissions:** `project:read`, `event:read`, plus `event:write` to resolve or ignore issues
- **How the token is sent:** A standard `Authorization: Bearer <token>` header. Paste only the token.
- **Server URL:** not needed — Naary always calls `https://sentry.io/api/0`.

## Get your credentials

1. In Sentry, open **Settings → Auth Tokens** (organisation-level for CI use) and create a token.

## Connect it in Naary

1. Go to **Integrations → Connect a server**.
2. Pick the **Sentry** tile (or *Custom* if you are configuring it by hand).
3. Leave **Server URL** as the default — this provider has a fixed API base.
4. Paste the credential into the token field and save.
5. Connections are **per environment** — a sandbox connection and a prod connection are separate rows, so test credentials can never be used by a production run.

## Verify it works

**One-click:** this provider has an argument-free read (`list_organizations` → `GET /organizations/`), so a connection test can confirm the credential without touching your data.

Either way, the definitive check is **single-node Test** on the canvas: drop a **Sentry** node, pick this connection and the *List organizations* action, and run just that node. It executes the real activity with the real credential and shows you the provider's actual response.

> **Not yet proven against the real API.** This provider's request shape is typed and unit-tested, but no automated test has ever called the live service. If your first call fails with a 4xx, the fault may be ours — check `docs/integrations/VERIFICATION.md` and open an issue rather than assuming your token is wrong.

## Actions

| Action | Method | Endpoint | Required fields | Optional fields |
| --- | --- | --- | --- | --- |
| List issues | `GET` | `/projects/{organizationSlug}/{projectSlug}/issues/` | `organizationSlug`, `projectSlug` | `query`, `statsPeriod` |
| Get issue | `GET` | `/organizations/{organizationSlug}/issues/{issueId}/` | `organizationSlug`, `issueId` | — |
| **Update issue** (write) | `PUT` | `/organizations/{organizationSlug}/issues/{issueId}/` | `organizationSlug`, `issueId`, `status` | — |
| List projects | `GET` | `/organizations/{organizationSlug}/projects/` | `organizationSlug` | — |
| List organizations | `GET` | `/organizations/` | — | — |

Fields can be typed in statically or **bound** to an upstream step's output (`{ from: <nodeId>, path: <dotted.path> }`) — ids and generated text are usually bound.

The 1 write action run **at-most-once**: a transient failure fails the node instead of retrying, so a lost response cannot double-post. Re-run deliberately if you need to.

## Output

`{ status, ok, body }` — `status` is the HTTP status code, `ok` is whether it was 2xx, and `body` is the provider's parsed response. Branch on `<nodeId>.status` with an `if` or `switch` node.

## Gotchas

- Sentry's own DSN is **not** an auth token — the DSN sends events in, tokens read them back out.
- Self-hosted Sentry needs its own Server URL.

## Troubleshooting

| Symptom | Most likely cause |
| --- | --- |
| **401 / 403 on every call** | The credential is wrong, expired, or missing a scope. Paste only the token, with no `Bearer ` prefix of your own. |
| **`host is not allowed` / egress error** | The target resolves to a private or loopback address. Naary's SSRF guard blocks those, so self-hosted instances must be reachable at a public hostname. |
| **Works in sandbox, fails in prod (or vice versa)** | Connections are per-environment. Each environment needs its own connection row with its own credential. |
| **Node output shows `status: 200` but nothing happened** | Some providers report failures in the body with a 200. Check `<nodeId>.body` before trusting the status. |

---

Adding a node to a canvas, binding fields and reading output are the same for every provider — see [the integrations overview](./README.md). For how any of this is verified, see [VERIFICATION.md](./VERIFICATION.md).
