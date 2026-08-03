// ── Airtable (cloud, api.airtable.com/v0; auth = a personal access token, with the base's
//    data scopes, as a Bearer. `whoami` is the credential probe) ───────────────────────
import type { IntegrationProvider } from "../types";

export const AIRTABLE: IntegrationProvider = {
  key: "airtable",
  label: "Airtable",
  baseUrl: "https://api.airtable.com/v0",
  description: "Read and write Airtable records — list, get, create, update.",
  auth: "A custom connection whose token is an Airtable personal access token (with data scopes for the base).",
  credentialSetup: {
    tokenUrl: "https://airtable.com/create/tokens",
    scopes: ["data.records:read", "data.records:write"],
    steps: [
      "At airtable.com/create/tokens click Create token and grant the scopes above.",
      "Add the specific base(s) the workflow may touch — a token with no base added returns 403 on every call, scopes or not.",
      "Copy the token immediately; Airtable shows it once.",
    ],
  },
  actions: [
    {
      key: "list_records",
      label: "List records",
      description: "List records in a table, optionally filtered by view.",
      method: "GET",
      pathTemplate: "/{baseId}/{tableId}",
      write: false,
      fields: [
        {
          key: "baseId",
          label: "Base id",
          in: "path",
          required: true,
          hint: "e.g. appXXXXXXXXXXXXXX",
        },
        {
          key: "tableId",
          label: "Table id or name",
          in: "path",
          required: true,
          hint: "e.g. tblXXXXXXXXXXXXXX or the table name",
        },
        {
          key: "maxRecords",
          label: "Max records",
          in: "query",
          required: false,
          type: "number",
        },
        { key: "view", label: "View", in: "query", required: false },
      ],
    },
    {
      key: "get_record",
      label: "Get record",
      description: "Fetch a single record by id.",
      method: "GET",
      pathTemplate: "/{baseId}/{tableId}/{recordId}",
      write: false,
      fields: [
        { key: "baseId", label: "Base id", in: "path", required: true },
        {
          key: "tableId",
          label: "Table id or name",
          in: "path",
          required: true,
        },
        {
          key: "recordId",
          label: "Record id",
          in: "path",
          required: true,
          hint: "e.g. recXXXXXXXXXXXXXX",
        },
      ],
    },
    {
      key: "create_record",
      label: "Create record",
      description: "Create a record in a table.",
      method: "POST",
      pathTemplate: "/{baseId}/{tableId}",
      write: true,
      fields: [
        { key: "baseId", label: "Base id", in: "path", required: true },
        {
          key: "tableId",
          label: "Table id or name",
          in: "path",
          required: true,
        },
        {
          key: "fields",
          label: "Fields (JSON)",
          in: "body",
          required: true,
          type: "json",
          bodyPath: "fields",
          hint: "record field values keyed by field name",
        },
      ],
    },
    {
      key: "update_record",
      label: "Update record",
      description: "Update fields on an existing record.",
      method: "PATCH",
      pathTemplate: "/{baseId}/{tableId}/{recordId}",
      write: true,
      fields: [
        { key: "baseId", label: "Base id", in: "path", required: true },
        {
          key: "tableId",
          label: "Table id or name",
          in: "path",
          required: true,
        },
        {
          key: "recordId",
          label: "Record id",
          in: "path",
          required: true,
        },
        {
          key: "fields",
          label: "Fields (JSON)",
          in: "body",
          required: true,
          type: "json",
          bodyPath: "fields",
          hint: "record field values keyed by field name",
        },
      ],
    },
    {
      key: "whoami",
      label: "Who am I",
      description:
        "Return the user id this token belongs to. Needs no arguments, so it is the connection check.",
      method: "GET",
      pathTemplate: "/meta/whoami",
      write: false,
      probe: true,
      fields: [],
    },
  ],
};
