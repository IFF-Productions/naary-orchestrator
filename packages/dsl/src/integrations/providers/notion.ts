// ── Notion (REST v1; static base api.notion.com; auth = an internal integration token as
//    Bearer; requires the Notion-Version header. Schema-driven payloads use `json` fields) ──
//
//    The version header is PROVIDER-WIDE and it is a real API contract, not a formality: Notion
//    only cuts a version for a backwards-INCOMPATIBLE change, so the pin decides which shapes the
//    catalog must send. We pin `2026-03-11`, the latest at the time of writing (#944) — its own
//    spec declares `Notion-Version` as `enum: ["2026-03-11"]` and its docs call it "the latest
//    version". Bumping it is never a header edit on its own; each action has to be re-read against
//    that version's document, which is what the pinned fixture + the drift spec now enforce.
//
//    What 2026-03-11 changes for us, action by action, per Notion's two upgrade guides:
//      · 2025-09-03 "Data Source Edition" — a database's ROWS moved behind a data source, and
//        `POST /databases/{id}/query` became `POST /data_sources/{id}/query`. That is a different
//        RESOURCE, not a renamed path, so `query_database`'s path field moved with it.
//      · 2026-03-11 — append-children took `position` in place of the flat `after`; `archived`
//        became `in_trash`; the `transcription` block type became `meeting_notes`. We send none of
//        those three keys, so no catalog field changes — but a hand-authored `children` blob that
//        still says `"type": "transcription"` is now the author's to fix.
import type { IntegrationProvider } from "../types";

export const NOTION: IntegrationProvider = {
  key: "notion",
  label: "Notion",
  baseUrl: "https://api.notion.com/v1",
  headers: { "Notion-Version": "2026-03-11" },
  description:
    "Read and write Notion — get pages/databases, query a data source, create pages, append blocks.",
  auth: "A custom connection whose token is a Notion internal integration token (`secret_…` / `ntn_…`); share the target pages/databases with the integration.",
  actions: [
    {
      key: "get_page",
      label: "Get page",
      description: "Fetch a page's properties by id.",
      method: "GET",
      pathTemplate: "/pages/{pageId}",
      write: false,
      fields: [{ key: "pageId", label: "Page id", in: "path", required: true }],
    },
    {
      key: "get_database",
      label: "Get database (and its data source ids)",
      description:
        "Fetch a database by id. Its `data_sources[]` is where a data source id comes from — bind `data_sources.0.id` into Query data source.",
      method: "GET",
      pathTemplate: "/databases/{databaseId}",
      write: false,
      fields: [
        {
          key: "databaseId",
          label: "Database id",
          in: "path",
          required: true,
          hint: "The UUID in the database's Notion URL, with or without dashes.",
        },
      ],
    },
    {
      // The action KEY stays `query_database` on purpose. Renaming it would give every saved node
      // `unknown action 'query_database'` — a worse error, on a code path that can say nothing
      // useful — while the label and description are what the canvas actually shows. The FIELD key
      // had to move, because a data source id is not a database id.
      key: "query_database",
      label: "Query data source",
      description:
        "Query a data source's pages (a database's rows), optionally with a filter/sort.",
      method: "POST",
      pathTemplate: "/data_sources/{dataSourceId}/query",
      write: false,
      // Every body field here is optional (filter/sorts/pageSize), so "query everything" built a
      // POST with NO body — and this endpoint's `requestBody` is `required: true` in Notion's own
      // pinned spec. The commonest use of the action was the one that could 400.
      alwaysSendBody: true,
      retiredFields: [
        {
          key: "databaseId",
          replacedBy: "dataSourceId",
          note: "Notion's 2025-09-03 API moved a database's rows behind a DATA SOURCE, and one database can hold several — so the query takes a data source id, which a database id cannot be converted into locally. Add a 'Get database (and its data source ids)' node with the same database id and bind this field to its `body.data_sources.0.id`.",
        },
      ],
      fields: [
        {
          key: "dataSourceId",
          label: "Data source id",
          in: "path",
          required: true,
          hint: "NOT the database id — get it from `data_sources[].id` on a Get database node (a database can have several).",
        },
        {
          key: "filter",
          label: "Filter (JSON)",
          in: "body",
          required: false,
          type: "json",
          hint: "Notion filter object",
        },
        {
          key: "pageSize",
          label: "Page size",
          in: "body",
          required: false,
          type: "number",
          bodyPath: "page_size",
        },
      ],
    },
    {
      key: "create_page",
      label: "Create page",
      description:
        "Create a page under a data source (a database row), a database, or a parent page.",
      method: "POST",
      pathTemplate: "/pages",
      write: true,
      fields: [
        {
          key: "parent",
          // Unchanged by the version bump, and that is a FINDING rather than an omission: #944
          // predicted this action had to move to `data_source_id` too, but 2026-03-11's own
          // `parent` schema still carries a `database_id` variant alongside the new
          // `data_source_id` one, so an existing config keeps working. Only the hint gains the
          // third form. Spec-declared, not live-verified — we hold no Notion token.
          label: "Parent (JSON)",
          in: "body",
          required: true,
          type: "json",
          hint: '{ "data_source_id": "…" }, { "database_id": "…" } or { "page_id": "…" }',
        },
        {
          key: "properties",
          label: "Properties (JSON)",
          in: "body",
          required: true,
          type: "json",
          hint: "Notion property values keyed by property name",
        },
      ],
    },
    {
      key: "append_block",
      label: "Append blocks",
      description: "Append child blocks to a page or block.",
      method: "PATCH",
      pathTemplate: "/blocks/{blockId}/children",
      write: true,
      fields: [
        { key: "blockId", label: "Block/Page id", in: "path", required: true },
        {
          key: "children",
          label: "Children (JSON)",
          in: "body",
          required: true,
          type: "json",
          hint: "array of Notion block objects",
        },
      ],
    },
    {
      key: "get_me",
      label: "Get current bot user",
      description:
        "Return the bot user this integration token belongs to. Needs no arguments, so it is the connection check.",
      method: "GET",
      pathTemplate: "/users/me",
      write: false,
      probe: true,
      fields: [],
    },
  ],
};
