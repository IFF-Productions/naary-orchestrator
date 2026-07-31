// ── DigitalOcean (cloud, api.digitalocean.com/v2; auth = a personal access token as a
//    Bearer) ───────────────────────────────────────────────────────────────────────────
import type { IntegrationProvider } from "../types";

export const DIGITALOCEAN: IntegrationProvider = {
  key: "digitalocean",
  label: "DigitalOcean",
  baseUrl: "https://api.digitalocean.com/v2",
  authScheme: "bearer",
  description: "Manage DigitalOcean Droplets — list, get, create, and delete.",
  auth: "A custom connection whose token is a DigitalOcean personal access token — sent as a Bearer token.",
  actions: [
    {
      key: "list_droplets",
      label: "List droplets",
      description: "List Droplets, optionally filtered by tag.",
      method: "GET",
      pathTemplate: "/droplets",
      write: false,
      fields: [
        {
          key: "tag_name",
          label: "Tag name",
          in: "query",
          required: false,
          hint: "filter by tag",
        },
      ],
    },
    {
      key: "get_droplet",
      label: "Get droplet",
      description: "Fetch a single Droplet by id.",
      method: "GET",
      pathTemplate: "/droplets/{dropletId}",
      write: false,
      fields: [
        { key: "dropletId", label: "Droplet id", in: "path", required: true },
      ],
    },
    {
      key: "create_droplet",
      label: "Create droplet",
      description: "Create a new Droplet.",
      method: "POST",
      pathTemplate: "/droplets",
      write: true,
      fields: [
        { key: "name", label: "Name", in: "body", required: true },
        {
          key: "region",
          label: "Region",
          in: "body",
          required: true,
          hint: "e.g. nyc3",
        },
        {
          key: "size",
          label: "Size",
          in: "body",
          required: true,
          hint: "e.g. s-1vcpu-1gb",
        },
        {
          key: "image",
          label: "Image",
          in: "body",
          required: true,
          hint: "slug or id, e.g. ubuntu-22-04-x64",
        },
      ],
    },
    {
      key: "delete_droplet",
      label: "Delete droplet",
      description: "Delete a Droplet by id.",
      method: "DELETE",
      pathTemplate: "/droplets/{dropletId}",
      write: true,
      fields: [
        { key: "dropletId", label: "Droplet id", in: "path", required: true },
      ],
    },
  ],
};
