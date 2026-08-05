---
title: 'Query PostHog events and people, and annotate releases, from a workflow.'
provider: posthog
label: 'PostHog'
category: 'Analytics'
authType: bearer
serverUrlRequired: true
actionCount: 5
writeActionCount: 1
oneClickTestable: true
probeAction: get_me
liveVerified: false
---

<!-- Sections marked GENERATED come from packages/dsl/src/integrations.ts via
     `pnpm gen:integration-docs`. Edit the catalog (or
     packages/dsl/src/docs/integration-prose.ts for the prose), never this file —
     packages/dsl/test/integration-docs.spec.ts fails on drift. -->

# PostHog

Query PostHog events and people, and annotate releases, from a workflow.

## Before you start

- **You need:** a personal API key.
- **How the token is sent:** A standard `Authorization: Bearer <token>` header. Paste only the token.
- **Server URL: set it unless you are on `https://us.posthog.com`.** `https://us.posthog.com` for US Cloud, `https://eu.posthog.com` for EU Cloud, or your own host if you self-host. Left blank, Naary calls `https://us.posthog.com` — so a connection anywhere else must set it.

## Get your credentials

1. In PostHog, open **Settings → Organization → Security → Personal API key access** and create a key.
2. Note your **project id** from the project settings — most endpoints need it.
3. Note which **region** your project is in — it is in the URL you log in at (`us.posthog.com` or `eu.posthog.com`), and it decides the Server URL below.

## Connect it in Naary

1. Go to **Integrations → Connect a server**.
2. Pick the **PostHog** tile (or *Custom* if you are configuring it by hand).
3. Set **Server URL** to `https://us.posthog.com` for US Cloud, `https://eu.posthog.com` for EU Cloud, or your own host if you self-host (blank means `https://us.posthog.com`).
4. Paste the credential into the token field and save.
5. Connections are **per environment** — a sandbox connection and a prod connection are separate rows, so test credentials can never be used by a production run.

## Verify it works

**One-click:** this provider has an argument-free read (`get_me` → `GET /api/users/@me/`), so a connection test can confirm the credential without touching your data.

Either way, the definitive check is **single-node Test** on the canvas: drop a **PostHog** node, pick this connection and the *Get current user* action, and run just that node. It executes the real activity with the real credential and shows you the provider's actual response.

> **Not yet proven against the real API.** This provider's request shape is typed and unit-tested, but no automated test has ever called the live service. If your first call fails with a 4xx, the fault may be ours — check `docs/integrations/VERIFICATION.md` and open an issue rather than assuming your token is wrong.

## Actions

| Action | Method | Endpoint | Required fields | Optional fields |
| --- | --- | --- | --- | --- |
| List events | `GET` | `/api/projects/{projectId}/events/` | `projectId` | — |
| List persons | `GET` | `/api/projects/{projectId}/persons/` | `projectId` | `search` |
| Get person | `GET` | `/api/projects/{projectId}/persons/{personId}/` | `projectId`, `personId` | — |
| **Create annotation** (write) | `POST` | `/api/projects/{projectId}/annotations/` | `projectId`, `content` | `date_marker` |
| Get current user | `GET` | `/api/users/@me/` | — | — |

Fields can be typed in statically or **bound** to an upstream step's output (`{ from: <nodeId>, path: <dotted.path> }`) — ids and generated text are usually bound.

The 1 write action run **at-most-once**: a transient failure fails the node instead of retrying, so a lost response cannot double-post. Re-run deliberately if you need to.

## Output

`{ status, ok, body }` — `status` is the HTTP status code, `ok` is whether it was 2xx, and `body` is the provider's parsed response. Branch on `<nodeId>.status` with an `if` or `switch` node.

## Gotchas

- A personal API key is **not** the same as the project write-only key used by the tracking SDKs. The SDK key will not work here.
- PostHog's regions are **separate deployments**: a key issued on EU Cloud is unknown to the US host, so a wrong Server URL fails as an auth error and looks like a bad key. `app.posthog.com` is the legacy alias for US Cloud.
- Self-hosted PostHog needs its own Server URL and must be publicly resolvable.

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
