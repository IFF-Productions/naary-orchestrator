// ── Vercel (cloud, api.vercel.com; auth = a Vercel access token as a Bearer) ──────────
import type { IntegrationProvider } from "../types";

export const VERCEL: IntegrationProvider = {
  key: "vercel",
  label: "Vercel",
  baseUrl: "https://api.vercel.com",
  authScheme: "bearer",
  description:
    "Act on Vercel deployments and projects — list deployments, get a deployment, list projects, delete a deployment.",
  auth: "A custom connection whose token is a Vercel access token — sent as a Bearer token.",
  actions: [
    {
      key: "list_deployments",
      label: "List deployments",
      description: "List deployments, optionally scoped to a project.",
      method: "GET",
      pathTemplate: "/v6/deployments",
      write: false,
      fields: [
        {
          key: "projectId",
          label: "Project id",
          in: "query",
          required: false,
          hint: "filter to a single project",
        },
        {
          key: "limit",
          label: "Limit",
          in: "query",
          required: false,
          type: "number",
        },
      ],
    },
    {
      key: "get_deployment",
      label: "Get deployment",
      description: "Fetch a single deployment by id.",
      method: "GET",
      pathTemplate: "/v13/deployments/{deploymentId}",
      write: false,
      fields: [
        {
          key: "deploymentId",
          label: "Deployment id",
          in: "path",
          required: true,
        },
      ],
    },
    {
      key: "list_projects",
      label: "List projects",
      description: "List the projects for the account.",
      method: "GET",
      pathTemplate: "/v9/projects",
      write: false,
      fields: [],
    },
    {
      key: "delete_deployment",
      label: "Delete deployment",
      description: "Delete a deployment by id.",
      method: "DELETE",
      pathTemplate: "/v13/deployments/{deploymentId}",
      write: true,
      fields: [
        {
          key: "deploymentId",
          label: "Deployment id",
          in: "path",
          required: true,
        },
      ],
    },
  ],
};
