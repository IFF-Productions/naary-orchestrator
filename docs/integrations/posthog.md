---
title: 'Query PostHog events and people, and annotate releases, from a workflow.'
provider: posthog
label: 'PostHog'
category: 'Analytics'
authType: bearer
serverUrlRequired: false
actionCount: 4
writeActionCount: 1
oneClickTestable: false
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
- **Server URL:** not needed — Naary always calls `https://app.posthog.com`.

## Get your credentials

1. In PostHog, open **Settings → Organization → Security → Personal API key access** and create a key.
2. Note your **project id** from the project settings — most endpoints need it.

## Connect it in Naary

1. Go to **Integrations → Connect a server**.
2. Pick the **PostHog** tile (or *Custom* if you are configuring it by hand).
3. Leave **Server URL** as the default — this provider has a fixed API base.
4. Paste the credential into the token field and save.
5. Connections are **per environment** — a sandbox connection and a prod connection are separate rows, so test credentials can never be used by a production run.

## Verify it works

**No one-click check:** its read actions all need an id you have to supply, so there is no safe argument-free call to probe with.

Either way, the definitive check is **single-node Test** on the canvas: drop a **PostHog** node, pick this connection, choose a read action and fill its ids, and run just that node. It executes the real activity with the real credential and shows you the provider's actual response.

> **Not yet proven against the real API.** This provider's request shape is typed and unit-tested, but no automated test has ever called the live service. If your first call fails with a 4xx, the fault may be ours — check `docs/integrations/VERIFICATION.md` and open an issue rather than assuming your token is wrong.

## Actions

| Action | Method | Endpoint | Required fields | Optional fields |
| --- | --- | --- | --- | --- |
| List events | `GET` | `/api/projects/{projectId}/events/` | `projectId` | — |
| List persons | `GET` | `/api/projects/{projectId}/persons/` | `projectId` | `search` |
| Get person | `GET` | `/api/projects/{projectId}/persons/{personId}/` | `projectId`, `personId` | — |
| **Create annotation** (write) | `POST` | `/api/projects/{projectId}/annotations/` | `projectId`, `content` | `date_marker` |

Fields can be typed in statically or **bound** to an upstream step's output (`{ from: <nodeId>, path: <dotted.path> }`) — ids and generated text are usually bound.

The 1 write action run **at-most-once**: a transient failure fails the node instead of retrying, so a lost response cannot double-post. Re-run deliberately if you need to.

## Output

`{ status, ok, body }` — `status` is the HTTP status code, `ok` is whether it was 2xx, and `body` is the provider's parsed response. Branch on `<nodeId>.status` with an `if` or `switch` node.

## Gotchas

- A personal API key is **not** the same as the project write-only key used by the tracking SDKs. The SDK key will not work here.
- Self-hosted PostHog needs its own Server URL and must be publicly resolvable.

## Troubleshooting

| Symptom | Most likely cause |
| --- | --- |
| **401 / 403 on every call** | The credential is wrong, expired, or missing a scope. Paste only the token, with no `Bearer ` prefix of your own. |
| **`host is not allowed` / egress error** | The target resolves to a private or loopback address. Naary's SSRF guard blocks those, so self-hosted instances must be reachable at a public hostname. |
| **Works in sandbox, fails in prod (or vice versa)** | Connections are per-environment. Each environment needs its own connection row with its own credential. |
| **Node output shows `status: 200` but nothing happened** | Some providers report failures in the body with a 200. Check `<nodeId>.body` before trusting the status. |

---

Adding a node to a canvas, binding fields and reading output are the same for every provider — see [the integrations overview](./README.md). For how any of this is verified, see [VERIFICATION.md](./VERIFICATION.md).
