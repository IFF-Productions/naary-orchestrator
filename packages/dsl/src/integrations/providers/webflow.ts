// ── Webflow (cloud, api.webflow.com/v2; auth = a site or app API token as a Bearer.
//    `list_sites` is the credential probe) ────────────────────────────────────────────
import type { IntegrationProvider } from "../types";

export const WEBFLOW: IntegrationProvider = {
  key: "webflow",
  label: "Webflow",
  baseUrl: "https://api.webflow.com/v2",
  description:
    "Read and write Webflow CMS — list sites/collections/items, get an item, create an item.",
  auth: "A custom connection whose token is a Webflow API token (site or app token).",
  actions: [
    {
      key: "list_sites",
      label: "List sites",
      description:
        "List the sites this token can reach. Needs no arguments, so it is the connection check.",
      method: "GET",
      pathTemplate: "/sites",
      write: false,
      probe: true,
      fields: [],
    },
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
        "Return the user this token was authorized by. OAuth connections only — a Site Token cannot call Webflow's authorization endpoints.",
      method: "GET",
      pathTemplate: "/token/authorized_by",
      write: false,
      // NOT the probe any more (#1111). It asks "which OAuth app authorized this?", a question a
      // Site Token has no answer to: Webflow's own site-token page says site tokens "don't grant
      // access to the following endpoints: Authorization endpoints, Custom code endpoints,
      // Workspace Activity log endpoints", and this operation is Webflow's `token` group. So a
      // working Site Token connection failed its own "Test connection" while every Webflow action
      // we ship ran fine — the exact inversion of what a credential check is for.
      //
      // The action stays, because for an OAuth connection it is a legitimate read; only the probe
      // moved, to `list_sites`. That one is demonstrated WITH a site token by the same Webflow
      // page: `curl --request GET --url https://api.webflow.com/v2/sites --header 'authorization:
      // Bearer YOUR_API_TOKEN'` … "Replace YOUR_API_TOKEN with the site token you generated."
      //
      // Note the pinned spec cannot adjudicate this and must not be read as if it could: Webflow
      // declares `security: [{OAuth2: […]}]` on 112 of its 117 operations, including the CMS reads
      // a Site Token demonstrably performs. The evidence here is the vendor's prose (VERIFICATION.md
      // §2.5 rule 2), not the document.
      fields: [],
    },
  ],
};
