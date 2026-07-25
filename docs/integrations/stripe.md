---
title: 'Create customers, take payments and issue refunds from a workflow.'
provider: stripe
label: 'Stripe'
category: 'Finance & Accounting'
authType: bearer
serverUrlRequired: false
actionCount: 5
writeActionCount: 3
oneClickTestable: true
probeAction: list_charges
liveVerified: false
---

<!-- Sections marked GENERATED come from packages/dsl/src/integrations.ts via
     `pnpm gen:integration-docs`. Edit the catalog (or docs/integration-prose.ts for the
     prose), never this file — packages/dsl/test/integration-docs.spec.ts fails on drift. -->

# Stripe

Create customers, take payments and issue refunds from a workflow.

## Before you start

- **You need:** a secret key (`sk_test_…` / `sk_live_…`).
- **How the token is sent:** A standard `Authorization: Bearer <token>` header. Paste only the token.
- **Server URL:** not needed — Naary always calls `https://api.stripe.com/v1`.

## Get your credentials

1. In the Stripe dashboard, open **Developers → API keys** and copy a **secret** key.
2. Start with a **test-mode** key (`sk_test_…`) and keep it in your sandbox environment.
3. Prefer a restricted key limited to the resources the workflow needs.

## Connect it in Naary

1. Go to **Integrations → Connect a server**.
2. Pick the **Stripe** tile (or *Custom* if you are configuring it by hand).
3. Leave **Server URL** as the default — this provider has a fixed API base.
4. Paste the credential into the token field and save.
5. Connections are **per environment** — a sandbox connection and a prod connection are separate rows, so test credentials can never be used by a production run.

## Verify it works

**One-click:** this provider has an argument-free read (`list_charges` → `GET /charges`), so a connection test can confirm the credential without touching your data.

Either way, the definitive check is **single-node Test** on the canvas: drop a **Stripe** node, pick this connection and the *List charges* action, and run just that node. It executes the real activity with the real credential and shows you the provider's actual response.

> **Not yet proven against the real API.** This provider's request shape is typed and unit-tested, but no automated test has ever called the live service. If your first call fails with a 4xx, the fault may be ours — check `docs/integrations/VERIFICATION.md` and open an issue rather than assuming your token is wrong.

## Actions

| Action | Method | Endpoint | Required fields | Optional fields |
| --- | --- | --- | --- | --- |
| **Create customer** (write) | `POST` | `/customers` | — | `email`, `name`, `description` |
| Get customer | `GET` | `/customers/{customerId}` | `customerId` | — |
| **Create payment intent** (write) | `POST` | `/payment_intents` | `amount`, `currency` | `customer`, `description` |
| List charges | `GET` | `/charges` | — | `customer`, `limit` |
| **Create refund** (write) | `POST` | `/refunds` | `charge` | `amount` |

Fields can be typed in statically or **bound** to an upstream step's output (`{ from: <nodeId>, path: <dotted.path> }`) — ids and generated text are usually bound.

The 3 write actions run **at-most-once**: a transient failure fails the node instead of retrying, so a lost response cannot double-post. Re-run deliberately if you need to.

## Output

`{ status, ok, body }` — `status` is the HTTP status code, `ok` is whether it was 2xx, and `body` is the provider's parsed response. Branch on `<nodeId>.status` with an `if` or `switch` node.

## Gotchas

- The publishable key (`pk_…`) will not work — it must be the secret key.
- **Live keys move real money.** Use Naary's per-environment connections: `sk_test_…` in sandbox, `sk_live_…` in prod, so a sandbox run can never charge a customer.
- *Create refund* is irreversible. Gate it behind human approval.

## Troubleshooting

| Symptom | Most likely cause |
| --- | --- |
| **401 / 403 on every call** | The credential is wrong, expired, or missing a scope. Paste only the token, with no `Bearer ` prefix of your own. |
| **`host is not allowed` / egress error** | The target resolves to a private or loopback address. Naary's SSRF guard blocks those, so self-hosted instances must be reachable at a public hostname. |
| **Works in sandbox, fails in prod (or vice versa)** | Connections are per-environment. Each environment needs its own connection row with its own credential. |
| **Node output shows `status: 200` but nothing happened** | Some providers report failures in the body with a 200. Check `<nodeId>.body` before trusting the status. |

---

Adding a node to a canvas, binding fields and reading output are the same for every provider — see [the integrations overview](./README.md). For how any of this is verified, see [VERIFICATION.md](./VERIFICATION.md).
