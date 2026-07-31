// ── Monday.com (cloud, api.monday.com — GraphQL, so every action is a POST carrying a
//    query; auth = an API token in a bare `Authorization` header, no `Bearer ` prefix
//    (#655)). Unprobeable: the credential check only ever issues an argument-free GET ──
import type { IntegrationProvider } from "../types";

export const MONDAY: IntegrationProvider = {
  key: "monday",
  label: "Monday.com",
  baseUrl: "https://api.monday.com",
  authScheme: { header: "Authorization" },
  description:
    "Act on Monday.com boards via GraphQL — create/read items, post updates, change columns.",
  auth: "A custom connection whose token is a Monday.com API token (Developers → My access tokens), sent in a bare `Authorization` header — no `Bearer ` prefix (#655).",
  unprobeableReason:
    "Monday.com is GraphQL: `query { me { id } }` would prove the token, but every call is a POST " +
    "carrying a query, and the credential check only ever issues an argument-free GET. Test a " +
    "Monday.com connection with an integration node on a canvas (single-node Test).",
  actions: [
    {
      key: "create_item",
      label: "Create item",
      description:
        "Create an item on a board (GraphQL mutation). variables: { boardId, itemName, columnValues }.",
      method: "POST",
      pathTemplate: "/v2",
      write: true,
      fields: [
        {
          key: "query",
          label: "GraphQL query",
          in: "body",
          required: true,
          type: "string",
          hint: "e.g. mutation ($boardId: ID!, $itemName: String!, $columnValues: JSON) { create_item(board_id: $boardId, item_name: $itemName, column_values: $columnValues) { id } }",
        },
        {
          key: "variables",
          label: "Variables (JSON)",
          in: "body",
          required: true,
          type: "json",
          hint: "{ boardId, itemName, columnValues }",
        },
      ],
    },
    {
      key: "get_item",
      label: "Get item",
      description:
        "Fetch an item (and its column values) by id (GraphQL query). variables: { itemId }.",
      method: "POST",
      pathTemplate: "/v2",
      write: false,
      fields: [
        {
          key: "query",
          label: "GraphQL query",
          in: "body",
          required: true,
          type: "string",
          hint: "e.g. query ($itemId: [ID!]) { items(ids: $itemId) { id name column_values { id text } } }",
        },
        {
          key: "variables",
          label: "Variables (JSON)",
          in: "body",
          required: true,
          type: "json",
          hint: "{ itemId }",
        },
      ],
    },
    {
      key: "list_items",
      label: "List items",
      description:
        "List the items on a board (GraphQL query). variables: { boardId }.",
      method: "POST",
      pathTemplate: "/v2",
      write: false,
      fields: [
        {
          key: "query",
          label: "GraphQL query",
          in: "body",
          required: true,
          type: "string",
          hint: "e.g. query ($boardId: [ID!]) { boards(ids: $boardId) { items_page { items { id name } } } }",
        },
        {
          key: "variables",
          label: "Variables (JSON)",
          in: "body",
          required: false,
          type: "json",
          hint: "{ boardId }",
        },
      ],
    },
    {
      key: "create_update",
      label: "Create update",
      description:
        "Post an update (comment) on an item (GraphQL mutation). variables: { itemId, body }.",
      method: "POST",
      pathTemplate: "/v2",
      write: true,
      fields: [
        {
          key: "query",
          label: "GraphQL query",
          in: "body",
          required: true,
          type: "string",
          hint: "e.g. mutation ($itemId: ID!, $body: String!) { create_update(item_id: $itemId, body: $body) { id } }",
        },
        {
          key: "variables",
          label: "Variables (JSON)",
          in: "body",
          required: true,
          type: "json",
          hint: "{ itemId, body }",
        },
      ],
    },
    {
      key: "change_column_value",
      label: "Change column value",
      description:
        "Change a column's value on an item (GraphQL mutation). variables: { boardId, itemId, columnId, value }.",
      method: "POST",
      pathTemplate: "/v2",
      write: true,
      fields: [
        {
          key: "query",
          label: "GraphQL query",
          in: "body",
          required: true,
          type: "string",
          hint: "e.g. mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: JSON!) { change_column_value(board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) { id } }",
        },
        {
          key: "variables",
          label: "Variables (JSON)",
          in: "body",
          required: true,
          type: "json",
          hint: "{ boardId, itemId, columnId, value }",
        },
      ],
    },
  ],
};
