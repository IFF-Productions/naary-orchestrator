// ── Shopify (base = the CONNECTION's serverUrl, i.e. the store's Admin API base; auth =
//    the raw token in an `X-Shopify-Access-Token` header, not a Bearer (#655)) ─────────
//
// WHY THE EXAMPLE'S LAST SEGMENT IS `{api_version}` AND NOT A DATE (#1109)
//
// Shopify puts the API version in the REST path — its own notation for the shape is
// `/admin/api/{api_version}/{endpoint}.json` — and versions are dated: "Shopify releases a
// new API version every three months at the beginning of the quarter" and "Each stable
// version is supported for a minimum of 12 months, with at least nine months of overlap
// between consecutive versions" (https://shopify.dev/docs/api/usage/versioning). So any date
// hardcoded here stops being a supported version on a fixed schedule, roughly a year out.
//
// Going stale on a schedule would be a nag rather than a bug if it failed loudly. It does
// not: "if your app uses a stable version that is no longer supported, then Shopify falls
// forward and responds to your request with the same behaviour as the oldest supported
// stable version" (https://shopify.dev/docs/api/admin-rest/usage/versioning). Every call
// still returns 200. The user gets a DIFFERENT API's behaviour than the one they typed, and
// nothing anywhere says so.
//
// That is not hypothetical — it is this line's history. This example read `2024-01`, which
// went out of support on 1 January 2025, and it sat here for the next nineteen months
// because no request it produced ever failed.
//
// So the version is left as a substitution point, like `your-shop` beside it, and the value
// is sourced from the vendor instead of from us: the release-schedule table on the
// versioning page above is the only thing that is right on any given day. The prose that
// reaches the user (`auth` below, rendered in the connect dialog; `serverUrl` in
// `packages/dsl/src/docs/integration-prose.ts`, rendered in the guide) names a current version
// WITH THE DATE THAT WAS TRUE OF IT — a dated claim that states its own age can be checked;
// a bare `2024-01` cannot.
//
// Do not "just bump the number" when this looks old. Bumping restarts the same clock. If you
// want it to stop rotting for good, the fix is a check that reads Shopify's table, not a
// fresher constant.
import type { IntegrationProvider } from "../types";

export const SHOPIFY: IntegrationProvider = {
  key: "shopify",
  label: "Shopify",
  baseUrlFromConnection: true,
  // Display text only — the connect form's placeholder and the API's "set a Server URL"
  // error. It is never parsed and never used to build a request, so a `{…}` substitution
  // point is safe here (`mailchimp`'s `<dc>` is the same idea).
  serverUrlExample: "https://your-shop.myshopify.com/admin/api/{api_version}",
  authScheme: { header: "X-Shopify-Access-Token" },
  description:
    "Manage a Shopify store's Admin API — read/create/update products and create orders.",
  auth: "A custom connection whose Server URL is your store's Admin API base (https://{shop}.myshopify.com/admin/api/{api_version}) and whose token is a Shopify Admin API access token — sent as the `X-Shopify-Access-Token` header (#655). The version segment is a dated quarterly Shopify release — `2026-07` was the newest stable as of August 2026 — and each one is supported for about a year, so take the current value from Shopify's release-schedule table (https://shopify.dev/docs/api/usage/versioning) rather than copying a date from anywhere else. An out-of-support version does not fail: Shopify silently falls forward and answers as the oldest supported version instead.",
  actions: [
    {
      key: "get_product",
      label: "Get product",
      description: "Fetch a single product by id.",
      method: "GET",
      pathTemplate: "/products/{productId}.json",
      write: false,
      fields: [
        { key: "productId", label: "Product id", in: "path", required: true },
      ],
    },
    {
      key: "list_products",
      label: "List products",
      description: "List products, optionally filtered by vendor or limited.",
      method: "GET",
      pathTemplate: "/products.json",
      write: false,
      fields: [
        {
          key: "limit",
          label: "Limit",
          in: "query",
          required: false,
          type: "number",
          hint: "max products to return (default 50, max 250)",
        },
        { key: "vendor", label: "Vendor", in: "query", required: false },
      ],
    },
    {
      key: "create_product",
      label: "Create product",
      description: "Create a new product (wrapped in the product envelope).",
      method: "POST",
      pathTemplate: "/products.json",
      write: true,
      fields: [
        {
          key: "title",
          label: "Title",
          in: "body",
          required: true,
          bodyPath: "product.title",
        },
        {
          key: "bodyHtml",
          label: "Description (HTML)",
          in: "body",
          required: false,
          bodyPath: "product.body_html",
        },
        {
          key: "vendor",
          label: "Vendor",
          in: "body",
          required: false,
          bodyPath: "product.vendor",
        },
        {
          key: "productType",
          label: "Product type",
          in: "body",
          required: false,
          bodyPath: "product.product_type",
        },
      ],
    },
    {
      key: "update_product",
      label: "Update product",
      description: "Update an existing product by id (product envelope).",
      method: "PUT",
      pathTemplate: "/products/{productId}.json",
      write: true,
      fields: [
        { key: "productId", label: "Product id", in: "path", required: true },
        {
          key: "title",
          label: "Title",
          in: "body",
          required: false,
          bodyPath: "product.title",
        },
        {
          key: "bodyHtml",
          label: "Description (HTML)",
          in: "body",
          required: false,
          bodyPath: "product.body_html",
        },
        {
          key: "vendor",
          label: "Vendor",
          in: "body",
          required: false,
          bodyPath: "product.vendor",
        },
        {
          key: "productType",
          label: "Product type",
          in: "body",
          required: false,
          bodyPath: "product.product_type",
        },
      ],
    },
    {
      key: "create_order",
      label: "Create order",
      description: "Create a new order (wrapped in the order envelope).",
      method: "POST",
      pathTemplate: "/orders.json",
      write: true,
      fields: [
        {
          key: "lineItems",
          label: "Line items (JSON)",
          in: "body",
          required: true,
          type: "json",
          bodyPath: "order.line_items",
          hint: "array of { variant_id, quantity } or { title, price, quantity }",
        },
        {
          key: "email",
          label: "Customer email",
          in: "body",
          required: false,
          bodyPath: "order.email",
        },
        {
          key: "financialStatus",
          label: "Financial status",
          in: "body",
          required: false,
          bodyPath: "order.financial_status",
          hint: "e.g. paid | pending",
        },
      ],
    },
  ],
};
