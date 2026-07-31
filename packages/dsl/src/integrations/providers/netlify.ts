// ── Netlify (cloud, api.netlify.com/api/v1; auth = a personal access token as a Bearer.
//    Reads only — no write action ──────────────────────────────────────────────────────
import type { IntegrationProvider } from "../types";

export const NETLIFY: IntegrationProvider = {
  key: "netlify",
  label: "Netlify",
  baseUrl: "https://api.netlify.com/api/v1",
  authScheme: "bearer",
  description:
    "Read Netlify sites and deploys — list sites, get a site, list/get deploys.",
  auth: "A custom connection whose token is a Netlify personal access token — sent as a Bearer token.",
  actions: [
    {
      key: "list_sites",
      label: "List sites",
      description: "List the sites in your Netlify account.",
      method: "GET",
      pathTemplate: "/sites",
      write: false,
      fields: [],
    },
    {
      key: "get_site",
      label: "Get site",
      description: "Fetch a single site by id.",
      method: "GET",
      pathTemplate: "/sites/{siteId}",
      write: false,
      fields: [{ key: "siteId", label: "Site id", in: "path", required: true }],
    },
    {
      key: "list_deploys",
      label: "List deploys",
      description: "List the deploys for a site.",
      method: "GET",
      pathTemplate: "/sites/{siteId}/deploys",
      write: false,
      fields: [{ key: "siteId", label: "Site id", in: "path", required: true }],
    },
    {
      key: "get_deploy",
      label: "Get deploy",
      description: "Fetch a single deploy for a site by id.",
      method: "GET",
      pathTemplate: "/sites/{siteId}/deploys/{deployId}",
      write: false,
      fields: [
        { key: "siteId", label: "Site id", in: "path", required: true },
        { key: "deployId", label: "Deploy id", in: "path", required: true },
      ],
    },
  ],
};
