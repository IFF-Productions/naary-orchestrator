---
title: 'Manage Cloudflare zones and DNS records from a workflow.'
provider: cloudflare
label: 'Cloudflare'
category: 'Developer Tools'
authType: bearer
serverUrlRequired: false
actionCount: 4
writeActionCount: 2
oneClickTestable: true
probeAction: list_zones
liveVerified: false
---

<!-- Sections marked GENERATED come from packages/dsl/src/integrations.ts via
     `pnpm gen:integration-docs`. Edit the catalog (or docs/integration-prose.ts for the
     prose), never this file — packages/dsl/test/integration-docs.spec.ts fails on drift. -->

# Cloudflare

Manage Cloudflare zones and DNS records from a workflow.

## Before you start

- **You need:** an API token.
- **Scopes / permissions:** `Zone:Read`, plus `DNS:Edit` for the DNS write actions
- **How the token is sent:** A standard `Authorization: Bearer <token>` header. Paste only the token.
- **Server URL:** not needed — Naary always calls `https://api.cloudflare.com/client/v4`.

## Get your credentials

1. In the Cloudflare dashboard, open **My Profile → API Tokens** (or **Manage Account → API Tokens** for an account-scoped token) and create a token.
2. The **Edit zone DNS** template already grants exactly what the DNS actions need — start from it rather than hand-picking permissions.
3. Scope it to the specific zone(s) it should manage rather than all zones.
4. Prefer a scoped **API token** over the legacy Global API Key, which cannot be limited and authenticates differently.

## Connect it in Naary

1. Go to **Integrations → Connect a server**.
2. Pick the **Cloudflare** tile (or *Custom* if you are configuring it by hand).
3. Leave **Server URL** as the default — this provider has a fixed API base.
4. Paste the credential into the token field and save.
5. Connections are **per environment** — a sandbox connection and a prod connection are separate rows, so test credentials can never be used by a production run.

## Verify it works

**One-click:** this provider has an argument-free read (`list_zones` → `GET /zones`), so a connection test can confirm the credential without touching your data.

Either way, the definitive check is **single-node Test** on the canvas: drop a **Cloudflare** node, pick this connection and the *List zones* action, and run just that node. It executes the real activity with the real credential and shows you the provider's actual response.

> **Not yet proven against the real API.** This provider's request shape is typed and unit-tested, but no automated test has ever called the live service. If your first call fails with a 4xx, the fault may be ours — check `docs/integrations/VERIFICATION.md` and open an issue rather than assuming your token is wrong.

## Actions

| Action | Method | Endpoint | Required fields | Optional fields |
| --- | --- | --- | --- | --- |
| List zones | `GET` | `/zones` | — | `name` |
| List DNS records | `GET` | `/zones/{zoneId}/dns_records` | `zoneId` | `type` |
| **Create DNS record** (write) | `POST` | `/zones/{zoneId}/dns_records` | `zoneId`, `type`, `name`, `content` | `ttl` |
| **Delete DNS record** (write) | `DELETE` | `/zones/{zoneId}/dns_records/{recordId}` | `zoneId`, `recordId` | — |

Fields can be typed in statically or **bound** to an upstream step's output (`{ from: <nodeId>, path: <dotted.path> }`) — ids and generated text are usually bound.

The 2 write actions run **at-most-once**: a transient failure fails the node instead of retrying, so a lost response cannot double-post. Re-run deliberately if you need to.

## Output

`{ status, ok, body }` — `status` is the HTTP status code, `ok` is whether it was 2xx, and `body` is the provider's parsed response. Branch on `<nodeId>.status` with an `if` or `switch` node.

## Gotchas

- The legacy Global API Key uses `X-Auth-Email` + `X-Auth-Key` headers and will **not** work here — use an API token.

## Troubleshooting

| Symptom | Most likely cause |
| --- | --- |
| **401 / 403 on every call** | The credential is wrong, expired, or missing a scope. Paste only the token, with no `Bearer ` prefix of your own. |
| **`host is not allowed` / egress error** | The target resolves to a private or loopback address. Naary's SSRF guard blocks those, so self-hosted instances must be reachable at a public hostname. |
| **Works in sandbox, fails in prod (or vice versa)** | Connections are per-environment. Each environment needs its own connection row with its own credential. |
| **Node output shows `status: 200` but nothing happened** | Some providers report failures in the body with a 200. Check `<nodeId>.body` before trusting the status. |

---

Adding a node to a canvas, binding fields and reading output are the same for every provider — see [the integrations overview](./README.md). For how any of this is verified, see [VERIFICATION.md](./VERIFICATION.md).
