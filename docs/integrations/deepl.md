---
title: 'Translate text mid-workflow and keep an eye on your character quota.'
provider: deepl
label: 'DeepL'
category: 'Utility'
authType: custom-header
serverUrlRequired: true
actionCount: 3
writeActionCount: 0
oneClickTestable: true
probeAction: get_usage
liveVerified: false
---

<!-- Sections marked GENERATED come from packages/dsl/src/integrations.ts via
     `pnpm gen:integration-docs`. Edit the catalog (or docs/integration-prose.ts for the
     prose), never this file — packages/dsl/test/integration-docs.spec.ts fails on drift. -->

# DeepL

Translate text mid-workflow and keep an eye on your character quota.

## Before you start

- **You need:** a DeepL auth key.
- **How the token is sent:** A custom header: `Authorization: DeepL-Auth-Key <token>`. Naary applies this for you; paste only the token itself.
- **Server URL: required.** `https://api-free.deepl.com` for a Free key, `https://api.deepl.com` for Pro Getting this wrong is the most common cause of a setup that looks right and 404s.

## Get your credentials

1. Open your **DeepL account → API keys** and copy the authentication key.
2. Check whether your key ends in `:fx` — that decides which host you use (below). Do not go by plan name: the original Free/Pro plans are no longer sold and current plans are named differently.

## Connect it in Naary

1. Go to **Integrations → Connect a server**.
2. Pick the **DeepL** tile (or *Custom* if you are configuring it by hand).
3. Set **Server URL** to `https://api-free.deepl.com` for a Free key, `https://api.deepl.com` for Pro.
4. Paste the credential into the token field and save.
5. Connections are **per environment** — a sandbox connection and a prod connection are separate rows, so test credentials can never be used by a production run.

## Verify it works

**One-click:** this provider has an argument-free read (`get_usage` → `GET /v2/usage`), so a connection test can confirm the credential without touching your data.

Either way, the definitive check is **single-node Test** on the canvas: drop a **DeepL** node, pick this connection and the *Get usage* action, and run just that node. It executes the real activity with the real credential and shows you the provider's actual response.

> **Not yet proven against the real API.** This provider's request shape is typed and unit-tested, but no automated test has ever called the live service. If your first call fails with a 4xx, the fault may be ours — check `docs/integrations/VERIFICATION.md` and open an issue rather than assuming your token is wrong.

## Actions

| Action | Method | Endpoint | Required fields | Optional fields |
| --- | --- | --- | --- | --- |
| Translate text | `POST` | `/v2/translate` | `text`, `target_lang` | `source_lang`, `formality`, `context`, `glossary_id` |
| Get usage | `GET` | `/v2/usage` | — | — |
| List languages | `GET` | `/v2/languages` | — | `type` |

Fields can be typed in statically or **bound** to an upstream step's output (`{ from: <nodeId>, path: <dotted.path> }`) — ids and generated text are usually bound.

## Output

`{ status, ok, body }` — `status` is the HTTP status code, `ok` is whether it was 2xx, and `body` is the provider's parsed response. Branch on `<nodeId>.status` with an `if` or `switch` node.

## Gotchas

- **A key ending `:fx` must use `api-free.deepl.com`; anything else uses `api.deepl.com`.** The wrong host returns 403 with a perfectly valid key — the single most common DeepL setup failure, and the suffix is a more reliable signal than the plan name.
- *Get usage* is the cheapest way to confirm the key works: it takes no arguments and consumes no characters.

## Troubleshooting

| Symptom | Most likely cause |
| --- | --- |
| **401 / 403 on every call** | The credential is wrong, expired, or missing a scope. Paste only the raw token — Naary adds the header and any prefix itself. |
| **404 on a call that should work** | The Server URL is wrong. Re-read the format above — a missing path suffix or version segment produces a 404, not a helpful error. |
| **`host is not allowed` / egress error** | The target resolves to a private or loopback address. Naary's SSRF guard blocks those, so self-hosted instances must be reachable at a public hostname. |
| **Works in sandbox, fails in prod (or vice versa)** | Connections are per-environment. Each environment needs its own connection row with its own credential. |
| **Node output shows `status: 200` but nothing happened** | Some providers report failures in the body with a 200. Check `<nodeId>.body` before trusting the status. |

---

Adding a node to a canvas, binding fields and reading output are the same for every provider — see [the integrations overview](./README.md). For how any of this is verified, see [VERIFICATION.md](./VERIFICATION.md).
