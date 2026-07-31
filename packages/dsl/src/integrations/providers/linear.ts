// ── Linear (cloud, api.linear.app — GraphQL, so EVERY action is a POST to /graphql with a
//    query in the body; auth = a Linear API key as a Bearer). Unprobeable for that reason:
//    the credential check only ever issues an argument-free GET ────────────────────────
import type { IntegrationProvider } from "../types";

export const LINEAR: IntegrationProvider = {
  key: "linear",
  label: "Linear",
  baseUrl: "https://api.linear.app",
  authScheme: "bearer",
  description:
    "Act on Linear via its GraphQL API — read/create/update issues and comment.",
  auth: "A custom connection whose token is a Linear API key (Settings → API → Personal API keys).",
  unprobeableReason:
    "Linear is GraphQL: `query { viewer { id } }` would prove the key, but every call is a POST " +
    "carrying a query, and the credential check only ever issues an argument-free GET. Test a Linear " +
    "connection with an integration node on a canvas (single-node Test).",
  actions: [
    {
      key: "create_issue",
      label: "Create issue",
      description:
        "Create an issue (GraphQL issueCreate mutation). variables: { title, teamId, description? }.",
      method: "POST",
      pathTemplate: "/graphql",
      write: true,
      fields: [
        {
          key: "query",
          label: "GraphQL query",
          in: "body",
          required: true,
          hint: "mutation ($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }",
        },
        {
          key: "variables",
          label: "Variables (JSON)",
          in: "body",
          required: true,
          type: "json",
          hint: '{ "input": { "title": "…", "teamId": "…", "description": "…" } }',
        },
      ],
    },
    {
      key: "get_issue",
      label: "Get issue",
      description:
        "Fetch a single issue (GraphQL issue query). variables: { id }.",
      method: "POST",
      pathTemplate: "/graphql",
      write: false,
      fields: [
        {
          key: "query",
          label: "GraphQL query",
          in: "body",
          required: true,
          hint: "query ($id: String!) { issue(id: $id) { id identifier title description state { name } } }",
        },
        {
          key: "variables",
          label: "Variables (JSON)",
          in: "body",
          required: true,
          type: "json",
          hint: '{ "id": "…" }',
        },
      ],
    },
    {
      key: "list_issues",
      label: "List issues",
      description:
        "List issues (GraphQL issues query), optionally filtered/paged via variables.",
      method: "POST",
      pathTemplate: "/graphql",
      write: false,
      fields: [
        {
          key: "query",
          label: "GraphQL query",
          in: "body",
          required: true,
          hint: "query ($first: Int, $filter: IssueFilter) { issues(first: $first, filter: $filter) { nodes { id identifier title } } }",
        },
        {
          key: "variables",
          label: "Variables (JSON)",
          in: "body",
          required: false,
          type: "json",
          hint: '{ "first": 50, "filter": { … } }',
        },
      ],
    },
    {
      key: "create_comment",
      label: "Create comment",
      description:
        "Comment on an issue (GraphQL commentCreate mutation). variables: { input: { issueId, body } }.",
      method: "POST",
      pathTemplate: "/graphql",
      write: true,
      fields: [
        {
          key: "query",
          label: "GraphQL query",
          in: "body",
          required: true,
          hint: "mutation ($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id url } } }",
        },
        {
          key: "variables",
          label: "Variables (JSON)",
          in: "body",
          required: true,
          type: "json",
          hint: '{ "input": { "issueId": "…", "body": "…" } }',
        },
      ],
    },
    {
      key: "update_issue",
      label: "Update issue",
      description:
        "Update an issue (GraphQL issueUpdate mutation). variables: { id, input }.",
      method: "POST",
      pathTemplate: "/graphql",
      write: true,
      fields: [
        {
          key: "query",
          label: "GraphQL query",
          in: "body",
          required: true,
          hint: "mutation ($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { id identifier } } }",
        },
        {
          key: "variables",
          label: "Variables (JSON)",
          in: "body",
          required: true,
          type: "json",
          hint: '{ "id": "…", "input": { "stateId": "…", "title": "…" } }',
        },
      ],
    },
  ],
};
