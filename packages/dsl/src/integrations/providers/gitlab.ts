// ── GitLab (cloud, gitlab.com/api/v4; auth = a personal access token with the `api`
//    scope as a Bearer. `projectId` is a numeric id OR a raw 'group/project' path — path fields are URL-encoded by buildIntegrationRequest, so pass it un-encoded) ──
import type { IntegrationProvider } from "../types";

export const GITLAB: IntegrationProvider = {
  key: "gitlab",
  label: "GitLab",
  baseUrl: "https://gitlab.com/api/v4",
  authScheme: "bearer",
  description: "Act on GitLab issues — read, list, create, and comment.",
  auth: "A custom connection whose token is a GitLab personal access token (api scope).",
  actions: [
    {
      key: "get_issue",
      label: "Get issue",
      description: "Fetch a single issue by its project-scoped iid.",
      method: "GET",
      pathTemplate: "/projects/{projectId}/issues/{issueIid}",
      write: false,
      fields: [
        {
          key: "projectId",
          label: "Project id",
          in: "path",
          required: true,
          hint: "numeric id or the raw 'group/project' path (it's URL-encoded automatically — don't pre-encode)",
        },
        {
          key: "issueIid",
          label: "Issue iid",
          in: "path",
          required: true,
          type: "number",
        },
      ],
    },
    {
      key: "list_issues",
      label: "List issues",
      description:
        "List a project's issues, optionally filtered by state/labels.",
      method: "GET",
      pathTemplate: "/projects/{projectId}/issues",
      write: false,
      fields: [
        {
          key: "projectId",
          label: "Project id",
          in: "path",
          required: true,
          hint: "numeric id or the raw 'group/project' path (it's URL-encoded automatically — don't pre-encode)",
        },
        {
          key: "state",
          label: "State",
          in: "query",
          required: false,
          hint: "opened|closed",
        },
        {
          key: "labels",
          label: "Labels",
          in: "query",
          required: false,
        },
      ],
    },
    {
      key: "create_issue",
      label: "Create issue",
      description: "Open a new issue in a project.",
      method: "POST",
      pathTemplate: "/projects/{projectId}/issues",
      write: true,
      fields: [
        {
          key: "projectId",
          label: "Project id",
          in: "path",
          required: true,
          hint: "numeric id or the raw 'group/project' path (it's URL-encoded automatically — don't pre-encode)",
        },
        { key: "title", label: "Title", in: "body", required: true },
        {
          key: "description",
          label: "Description",
          in: "body",
          required: false,
        },
        {
          key: "labels",
          label: "Labels",
          in: "body",
          required: false,
          hint: "comma-separated",
        },
      ],
    },
    {
      key: "comment_issue",
      label: "Comment on issue",
      description: "Add a note (comment) to an existing issue.",
      method: "POST",
      pathTemplate: "/projects/{projectId}/issues/{issueIid}/notes",
      write: true,
      fields: [
        {
          key: "projectId",
          label: "Project id",
          in: "path",
          required: true,
          hint: "numeric id or the raw 'group/project' path (it's URL-encoded automatically — don't pre-encode)",
        },
        {
          key: "issueIid",
          label: "Issue iid",
          in: "path",
          required: true,
          type: "number",
        },
        { key: "body", label: "Comment", in: "body", required: true },
      ],
    },
    {
      key: "get_me",
      label: "Get current user",
      description:
        "Return the user this token belongs to. Needs no arguments, so it is the connection check.",
      method: "GET",
      pathTemplate: "/user",
      write: false,
      probe: true,
      fields: [],
    },
  ],
};
