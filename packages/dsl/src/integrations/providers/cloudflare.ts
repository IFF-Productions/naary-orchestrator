// ── Cloudflare (cloud, api.cloudflare.com/client/v4; auth = an API token as a Bearer) ─
import type { IntegrationProvider } from "../types";

export const CLOUDFLARE: IntegrationProvider = {
  key: "cloudflare",
  label: "Cloudflare",
  baseUrl: "https://api.cloudflare.com/client/v4",
  authScheme: "bearer",
  description:
    "Manage Cloudflare DNS — list zones, list/create/delete DNS records.",
  auth: "A custom connection whose token is a Cloudflare API token — sent as a Bearer token.",
  actions: [
    {
      key: "list_zones",
      label: "List zones",
      description: "List zones, optionally filtered by name.",
      method: "GET",
      pathTemplate: "/zones",
      write: false,
      fields: [
        {
          key: "name",
          label: "Name",
          in: "query",
          required: false,
          hint: "filter by zone name, e.g. example.com",
        },
      ],
    },
    {
      key: "list_dns_records",
      label: "List DNS records",
      description: "List a zone's DNS records, optionally filtered by type.",
      method: "GET",
      pathTemplate: "/zones/{zoneId}/dns_records",
      write: false,
      fields: [
        { key: "zoneId", label: "Zone id", in: "path", required: true },
        {
          key: "type",
          label: "Type",
          in: "query",
          required: false,
          hint: "A|CNAME|TXT|…",
        },
      ],
    },
    {
      key: "create_dns_record",
      label: "Create DNS record",
      description: "Create a DNS record in a zone.",
      method: "POST",
      pathTemplate: "/zones/{zoneId}/dns_records",
      write: true,
      fields: [
        { key: "zoneId", label: "Zone id", in: "path", required: true },
        {
          key: "type",
          label: "Type",
          in: "body",
          required: true,
          hint: "A|CNAME|TXT|…",
        },
        { key: "name", label: "Name", in: "body", required: true },
        { key: "content", label: "Content", in: "body", required: true },
        {
          key: "ttl",
          label: "TTL",
          in: "body",
          required: false,
          type: "number",
        },
      ],
    },
    {
      key: "delete_dns_record",
      label: "Delete DNS record",
      description: "Delete a DNS record from a zone.",
      method: "DELETE",
      pathTemplate: "/zones/{zoneId}/dns_records/{recordId}",
      write: true,
      fields: [
        { key: "zoneId", label: "Zone id", in: "path", required: true },
        { key: "recordId", label: "Record id", in: "path", required: true },
      ],
    },
  ],
};
