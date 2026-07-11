# Notion integration

Read and write Notion — query a database, fetch a page, create pages, and append blocks. A common
knowledge-base source (for RAG) and output sink for AI workflows.

## Setup

1. **Create an internal integration + token.** At <https://www.notion.so/my-integrations>, create an
   internal integration and copy its token (`secret_…` / `ntn_…`).
2. **Share the target pages/databases with it.** In Notion, open each database/page → **⋯ → Add
   connections →** your integration. (Notion returns 404 for anything not shared with the token.)
3. **Add the connection.** In **Integrations → Connect a server**:
   - **Type:** Custom
   - **Server URL:** `https://api.notion.com` (unused — the node targets `api.notion.com/v1`)
   - **Auth (token):** the integration token (sent as a Bearer token; the node also sends the
     required `Notion-Version` header).
4. **Add the Notion node**, pick this connection, choose an action, and fill the fields.

> Cloud only (`api.notion.com`).

## Actions

| Action | Method | Endpoint | Fields (\* required) |
| --- | --- | --- | --- |
| **Get page** | GET | `/pages/{pageId}` | pageId\* |
| **Query database** | POST | `/databases/{databaseId}/query` | databaseId\*, filter (JSON), pageSize |
| **Create page** (write) | POST | `/pages` | parent (JSON)\*, properties (JSON)\* |
| **Append blocks** (write) | PATCH | `/blocks/{blockId}/children` | blockId\*, children (JSON)\* |

**JSON fields.** Notion's payloads are schema-driven, so a few fields take a raw JSON value (edited
in the panel, or **bound** from an upstream step — e.g. an agent that emits Notion property JSON):

- **parent** — `{ "database_id": "…" }` or `{ "page_id": "…" }`.
- **properties** — property values keyed by property name, e.g.
  `{ "Name": { "title": [{ "text": { "content": "Weekly report" } }] } }`.
- **children** — an array of Notion block objects.
- **filter** — a Notion filter object (optional) for *Query database*.

Write actions run **at-most-once** (no auto-retry).

## Output

`{ status, ok, body }` — `status` is the HTTP code, `body` is Notion's JSON (the created page, or
query results in `body.results`). Branch on `<nodeId>.status`.

## Verify it works (live smoke test)

1. Create a test database in Notion and share it with the integration.
2. Add **Notion → Create page**, set `parent` to `{ "database_id": "<your db id>" }` and `properties`
   to a title for your DB's title property; run the workflow.
3. Confirm the page appears in the database and the node output shows `status: 200` with the new
   page id in `body.id`. Then try **Query database** with that `databaseId`.
