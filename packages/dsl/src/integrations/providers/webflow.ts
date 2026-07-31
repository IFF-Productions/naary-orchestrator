// ── Webflow (cloud, api.webflow.com/v2; auth = a site or app API token as a Bearer.
//    `get_authorized_by` is the credential probe) ──────────────────────────────────────
import type { IntegrationProvider } from "../types";

export const WEBFLOW: IntegrationProvider = {
  key: "webflow",
  label: "Webflow",
  baseUrl: "https://api.webflow.com/v2",
  description:
    "Read and write Webflow CMS — list collections/items, get an item, create an item.",
  auth: "A custom connection whose token is a Webflow API token (site or app token).",
  actions: [
    {
      key: "list_collections",
      label: "List collections",
      description: "List the CMS collections for a site.",
      method: "GET",
      pathTemplate: "/sites/{siteId}/collections",
      write: false,
      fields: [{ key: "siteId", label: "Site id", in: "path", required: true }],
    },
    {
      key: "list_items",
      label: "List items",
      description: "List items in a collection, with optional paging.",
      method: "GET",
      pathTemplate: "/collections/{collectionId}/items",
      write: false,
      fields: [
        {
          key: "collectionId",
          label: "Collection id",
          in: "path",
          required: true,
        },
        {
          key: "limit",
          label: "Limit",
          in: "query",
          required: false,
          type: "number",
        },
        {
          key: "offset",
          label: "Offset",
          in: "query",
          required: false,
          type: "number",
        },
      ],
    },
    {
      key: "get_item",
      label: "Get item",
      description: "Fetch a single collection item by id.",
      method: "GET",
      pathTemplate: "/collections/{collectionId}/items/{itemId}",
      write: false,
      fields: [
        {
          key: "collectionId",
          label: "Collection id",
          in: "path",
          required: true,
        },
        { key: "itemId", label: "Item id", in: "path", required: true },
      ],
    },
    {
      key: "create_item",
      label: "Create item",
      description: "Create a new item in a collection.",
      method: "POST",
      pathTemplate: "/collections/{collectionId}/items",
      write: true,
      fields: [
        {
          key: "collectionId",
          label: "Collection id",
          in: "path",
          required: true,
        },
        {
          key: "fieldData",
          label: "Field data (JSON)",
          in: "body",
          required: true,
          type: "json",
          bodyPath: "fieldData",
          hint: "item field values keyed by slug",
        },
        {
          key: "isDraft",
          label: "Is draft",
          in: "body",
          required: false,
          type: "boolean",
          bodyPath: "isDraft",
        },
      ],
    },
    {
      key: "get_authorized_by",
      label: "Get token owner",
      description:
        "Return the user this token was authorized by. Needs no arguments and no site scope, so it is the connection check.",
      method: "GET",
      pathTemplate: "/token/authorized_by",
      write: false,
      probe: true,
      fields: [],
    },
  ],
};
