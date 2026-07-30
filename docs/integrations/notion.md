---
title: 'Read, query and create Notion pages and data-source rows — a common knowledge-base source for RAG, and an output sink for AI workflows.'
provider: notion
label: 'Notion'
category: 'Productivity'
authType: bearer
serverUrlRequired: false
actionCount: 6
writeActionCount: 2
oneClickTestable: true
probeAction: get_me
liveVerified: false
---

<!-- Sections marked GENERATED come from packages/dsl/src/integrations.ts via
     `pnpm gen:integration-docs`. Edit the catalog (or
     packages/dsl/src/docs/integration-prose.ts for the prose), never this file —
     packages/dsl/test/integration-docs.spec.ts fails on drift. -->

# Notion

Read, query and create Notion pages and data-source rows — a common knowledge-base source for RAG, and an output sink for AI workflows.

## Before you start

- **You need:** an internal integration token (`secret_…` / `ntn_…`).
- **How the token is sent:** A standard `Authorization: Bearer <token>` header. Paste only the token.
- **Server URL:** not needed — Naary always calls `https://api.notion.com/v1`.

## Get your credentials

1. Create an integration at **notion.so/my-integrations** — only a **workspace owner** can — then use the **•••** next to it to reveal the internal integration token.
2. In Notion, open each page or database the workflow touches and **share it with the integration** — via the `…` menu → Connections.

## Connect it in Naary

1. Go to **Integrations → Connect a server**.
2. Pick the **Notion** tile (or *Custom* if you are configuring it by hand).
3. Leave **Server URL** as the default — this provider has a fixed API base.
4. Paste the credential into the token field and save.
5. Connections are **per environment** — a sandbox connection and a prod connection are separate rows, so test credentials can never be used by a production run.

## Verify it works

**One-click:** this provider has an argument-free read (`get_me` → `GET /users/me`), so a connection test can confirm the credential without touching your data.

Either way, the definitive check is **single-node Test** on the canvas: drop a **Notion** node, pick this connection and the *Get current bot user* action, and run just that node. It executes the real activity with the real credential and shows you the provider's actual response.

A concrete first run:

1. Create a scratch page in Notion and share it with the integration (`…` → Connections).
2. Add a **Get page** node with that page's id and run it.
3. A 404 here almost always means the sharing step was missed, not that the id is wrong — Notion returns 404 rather than 403 for pages the integration cannot see.

> **Not yet proven against the real API.** This provider's request shape is typed and unit-tested, but no automated test has ever called the live service. If your first call fails with a 4xx, the fault may be ours — check `docs/integrations/VERIFICATION.md` and open an issue rather than assuming your token is wrong.

## Actions

| Action | Method | Endpoint | Required fields | Optional fields |
| --- | --- | --- | --- | --- |
| Get page | `GET` | `/pages/{pageId}` | `pageId` | — |
| Get database (and its data source ids) | `GET` | `/databases/{databaseId}` | `databaseId` | — |
| Query data source | `POST` | `/data_sources/{dataSourceId}/query` | `dataSourceId` | `filter`, `pageSize` |
| **Create page** (write) | `POST` | `/pages` | `parent`, `properties` | — |
| **Append blocks** (write) | `PATCH` | `/blocks/{blockId}/children` | `blockId`, `children` | — |
| Get current bot user | `GET` | `/users/me` | — | — |

Fields can be typed in statically or **bound** to an upstream step's output (`{ from: <nodeId>, path: <dotted.path> }`) — ids and generated text are usually bound.

The 2 write actions run **at-most-once**: a transient failure fails the node instead of retrying, so a lost response cannot double-post. Re-run deliberately if you need to.

### Flat fields → nested payload

You fill in flat fields; the node assembles the nested body the API expects.

- **Query data source**: `pageSize` → `page_size`

## Output

`{ status, ok, body }` — `status` is the HTTP status code, `ok` is whether it was 2xx, and `body` is the provider's parsed response. Branch on `<nodeId>.status` with an `if` or `switch` node.

## Gotchas

- **Sharing is the step everyone misses.** A valid token returns **404 `object_not_found`** for a page the integration has not been added to — Notion's own docs say that error "can also indicate that the resource has not been shared with owner of the bearer token". A 404 here usually means unshared, not a wrong id.
- Page and database ids are the UUIDs in the Notion URL (with or without dashes). **A data source id is not** — it appears in no URL, and *Query data source* needs one.
- **Querying takes a data source id, not a database id.** Since Notion's 2025-09-03 API a database's rows live behind one or more *data sources*, so a query is two nodes: **Get database (and its data source ids)** with the database id from the URL, then **Query data source** bound to that node's `body.data_sources.0.id`. There is no way to convert one id into the other locally — a database can hold several data sources, so only Notion can tell you which.
- Creating a page requires a `parent` and `properties` matching the target data source's schema exactly. `parent` still accepts `{ "database_id": … }` as well as `{ "data_source_id": … }` and `{ "page_id": … }`.
- Naary pins `Notion-Version: 2026-03-11`. If a hand-authored `children` blob uses pre-2026 shapes it will be rejected — that version renamed the `transcription` block type to `meeting_notes`, replaced `archived` with `in_trash`, and replaced the flat `after` on Append blocks with a `position` object.

## Troubleshooting

| Symptom | Most likely cause |
| --- | --- |
| **401 / 403 on every call** | The credential is wrong, expired, or missing a scope. Paste only the token, with no `Bearer ` prefix of your own. |
| **`host is not allowed` / egress error** | The target resolves to a private or loopback address. Naary's SSRF guard blocks those, so self-hosted instances must be reachable at a public hostname. |
| **Works in sandbox, fails in prod (or vice versa)** | Connections are per-environment. Each environment needs its own connection row with its own credential. |
| **Node output shows `status: 200` but nothing happened** | Some providers report failures in the body with a 200. Check `<nodeId>.body` before trusting the status. |

---

Adding a node to a canvas, binding fields and reading output are the same for every provider — see [the integrations overview](./README.md). For how any of this is verified, see [VERIFICATION.md](./VERIFICATION.md).
