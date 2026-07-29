---
title: 'Send SMS and place voice calls from a workflow.'
provider: twilio
label: 'Twilio'
category: 'Communication'
authType: basic
serverUrlRequired: false
actionCount: 5
writeActionCount: 2
oneClickTestable: true
probeAction: list_accounts
liveVerified: false
---

<!-- Sections marked GENERATED come from packages/dsl/src/integrations.ts via
     `pnpm gen:integration-docs`. Edit the catalog (or
     packages/dsl/src/docs/integration-prose.ts for the prose), never this file —
     packages/dsl/test/integration-docs.spec.ts fails on drift. -->

# Twilio

Send SMS and place voice calls from a workflow.

## Before you start

- **You need:** an Account SID and Auth Token.
- **How the token is sent:** HTTP Basic — Naary base64-encodes the credential pair for you. Paste the raw `user:secret` pair, not a pre-encoded string.
- **Server URL:** not needed — Naary always calls `https://api.twilio.com/2010-04-01`.

## Get your credentials

1. Copy the **Account SID** and **Auth Token** from your Twilio Console dashboard.
2. Combine them as `AccountSid:AuthToken` — Naary sends that as HTTP Basic.
3. Buy or verify a sending phone number under **Phone Numbers**.

## Connect it in Naary

1. Go to **Integrations → Connect a server**.
2. Pick the **Twilio** tile (or *Custom* if you are configuring it by hand).
3. Leave **Server URL** as the default — this provider has a fixed API base.
4. Paste the credential into the token field and save.
5. Connections are **per environment** — a sandbox connection and a prod connection are separate rows, so test credentials can never be used by a production run.

## Verify it works

**One-click:** this provider has an argument-free read (`list_accounts` → `GET /Accounts.json`), so a connection test can confirm the credential without touching your data.

Either way, the definitive check is **single-node Test** on the canvas: drop a **Twilio** node, pick this connection and the *List accounts* action, and run just that node. It executes the real activity with the real credential and shows you the provider's actual response.

> **Not yet proven against the real API.** This provider's request shape is typed and unit-tested, but no automated test has ever called the live service. If your first call fails with a 4xx, the fault may be ours — check `docs/integrations/VERIFICATION.md` and open an issue rather than assuming your token is wrong.

## Actions

| Action | Method | Endpoint | Required fields | Optional fields |
| --- | --- | --- | --- | --- |
| **Send SMS** (write) | `POST` | `/Accounts/{accountSid}/Messages.json` | `accountSid`, `To`, `From`, `Body` | — |
| Get message | `GET` | `/Accounts/{accountSid}/Messages/{messageSid}.json` | `accountSid`, `messageSid` | — |
| List messages | `GET` | `/Accounts/{accountSid}/Messages.json` | `accountSid` | `To`, `From`, `PageSize` |
| **Make call** (write) | `POST` | `/Accounts/{accountSid}/Calls.json` | `accountSid`, `To`, `From`, `Url` | — |
| List accounts | `GET` | `/Accounts.json` | — | — |

Fields can be typed in statically or **bound** to an upstream step's output (`{ from: <nodeId>, path: <dotted.path> }`) — ids and generated text are usually bound.

The 2 write actions run **at-most-once**: a transient failure fails the node instead of retrying, so a lost response cannot double-post. Re-run deliberately if you need to.

## Output

`{ status, ok, body }` — `status` is the HTTP status code, `ok` is whether it was 2xx, and `body` is the provider's parsed response. Branch on `<nodeId>.status` with an `if` or `switch` node.

## Gotchas

- **The write actions are currently broken — see issue #707.** `send_sms` and `make_call` send a JSON body, but Twilio's REST API requires `application/x-www-form-urlencoded` for POST bodies (their docs are explicit), so both are rejected. The read actions work. This is a known bug of ours, not a setup mistake on your side.
- Set the node's `accountSid` field **as well as** the connection token: the URL path needs it explicitly and it is not derived from the credential.
- Trial accounts can only message **verified** numbers.
- Automated SMS and voice are legally regulated (consent, quiet hours, AI-voice disclosure). See `docs/design/OUTBOUND-VOICE-CALL.md` before running anything at volume.

## Troubleshooting

| Symptom | Most likely cause |
| --- | --- |
| **401 / 403 on every call** | The credential is wrong, expired, or missing a scope. Check you pasted the full `user:secret` pair and not just the secret. |
| **`host is not allowed` / egress error** | The target resolves to a private or loopback address. Naary's SSRF guard blocks those, so self-hosted instances must be reachable at a public hostname. |
| **Works in sandbox, fails in prod (or vice versa)** | Connections are per-environment. Each environment needs its own connection row with its own credential. |
| **Node output shows `status: 200` but nothing happened** | Some providers report failures in the body with a 200. Check `<nodeId>.body` before trusting the status. |

---

Adding a node to a canvas, binding fields and reading output are the same for every provider — see [the integrations overview](./README.md). For how any of this is verified, see [VERIFICATION.md](./VERIFICATION.md).
