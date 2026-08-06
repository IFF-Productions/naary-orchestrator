---
title: 'Read and manage Shopify products and orders from a workflow.'
provider: shopify
label: 'Shopify'
category: 'Finance & Accounting'
authType: custom-header
serverUrlRequired: true
actionCount: 5
writeActionCount: 3
oneClickTestable: true
probeAction: list_products
liveVerified: false
---

<!-- Sections marked GENERATED come from packages/dsl/src/integrations.ts via
     `pnpm gen:integration-docs`. Edit the catalog (or
     packages/dsl/src/docs/integration-prose.ts for the prose), never this file —
     packages/dsl/test/integration-docs.spec.ts fails on drift. -->

# Shopify

Read and manage Shopify products and orders from a workflow.

## Before you start

- **You need:** an Admin API access token.
- **Scopes / permissions:** `read_products`/`write_products`, `write_orders` as required
- **How the token is sent:** A custom header: `X-Shopify-Access-Token: <token>` — a **bare** value, with no `Bearer ` prefix. Naary applies this for you; paste only the token itself.
- **Server URL: required.** `https://{your-store}.myshopify.com/admin/api/{api_version}` — substitute your store handle, and put a currently-supported version in the last segment. Shopify ships one every quarter and supports each for at least 12 months, so read the current list off [its release-schedule table](https://shopify.dev/docs/api/usage/versioning) rather than copying a date: `2026-07` was the newest stable as of August 2026. Getting this wrong is the most common cause of a setup that looks right and 404s.

## Get your credentials

1. In your Shopify admin, open **Settings → Apps and sales channels → Develop apps** and create an app. The chosen app developer needs the *Develop apps* permission.
2. Configure its Admin API scopes, install it on the store, then reveal the **Admin API access token**.

## Connect it in Naary

1. Go to **Integrations → Connect a server**.
2. Pick the **Shopify** tile (or *Custom* if you are configuring it by hand).
3. Set **Server URL** to `https://{your-store}.myshopify.com/admin/api/{api_version}` — substitute your store handle, and put a currently-supported version in the last segment. Shopify ships one every quarter and supports each for at least 12 months, so read the current list off [its release-schedule table](https://shopify.dev/docs/api/usage/versioning) rather than copying a date: `2026-07` was the newest stable as of August 2026.
4. Paste the credential into the token field and save.
5. Connections are **per environment** — a sandbox connection and a prod connection are separate rows, so test credentials can never be used by a production run.

## Verify it works

**One-click:** this provider has an argument-free read (`list_products` → `GET /products.json`), so a connection test can confirm the credential without touching your data.

Either way, the definitive check is **single-node Test** on the canvas: drop a **Shopify** node, pick this connection and the *List products* action, and run just that node. It executes the real activity with the real credential and shows you the provider's actual response.

> **Not yet proven against the real API.** This provider's request shape is typed and unit-tested, but no automated test has ever called the live service. If your first call fails with a 4xx, the fault may be ours — check `docs/integrations/VERIFICATION.md` and open an issue rather than assuming your token is wrong.

## Actions

| Action | Method | Endpoint | Required fields | Optional fields |
| --- | --- | --- | --- | --- |
| Get product | `GET` | `/products/{productId}.json` | `productId` | — |
| List products | `GET` | `/products.json` | — | `limit`, `vendor` |
| **Create product** (write) | `POST` | `/products.json` | `title` | `bodyHtml`, `vendor`, `productType` |
| **Update product** (write) | `PUT` | `/products/{productId}.json` | `productId` | `title`, `bodyHtml`, `vendor`, `productType` |
| **Create order** (write) | `POST` | `/orders.json` | `lineItems` | `email`, `financialStatus` |

Fields can be typed in statically or **bound** to an upstream step's output (`{ from: <nodeId>, path: <dotted.path> }`) — ids and generated text are usually bound.

The 3 write actions run **at-most-once**: a transient failure fails the node instead of retrying, so a lost response cannot double-post. Re-run deliberately if you need to.

### Flat fields → nested payload

You fill in flat fields; the node assembles the nested body the API expects.

- **Create product**: `title` → `product.title`, `bodyHtml` → `product.body_html`, `vendor` → `product.vendor`, `productType` → `product.product_type`
- **Update product**: `title` → `product.title`, `bodyHtml` → `product.body_html`, `vendor` → `product.vendor`, `productType` → `product.product_type`
- **Create order**: `lineItems` → `order.line_items`, `email` → `order.email`, `financialStatus` → `order.financial_status`

## Output

`{ status, ok, body }` — `status` is the HTTP status code, `ok` is whether it was 2xx, and `body` is the provider's parsed response. Branch on `<nodeId>.status` with an `if` or `switch` node.

## Gotchas

- The token goes in an `X-Shopify-Access-Token` header, not `Authorization`. Naary handles it — but it is why the token fails in a generic HTTP node configured for Bearer.
- The Server URL embeds a dated **API version**, and an expired one does **not** start failing — Shopify *falls forward* and answers as the oldest still-supported version instead. So a stale URL keeps returning `200` while quietly serving a different API than the one you asked for; you will not get a 4xx to tell you. Re-check the version against Shopify's [release schedule](https://shopify.dev/docs/api/usage/versioning) on a calendar, not on an error.

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
