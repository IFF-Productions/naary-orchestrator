// ── Jira (Atlassian Cloud; base = the connection's site URL; REST v2 for plain-string
//    descriptions. Auth: an Atlassian API token via HTTP Basic (authScheme "basic",
//    connection token = `email:api_token`), or an OAuth access token via Bearer) ───────
import type { IntegrationProvider } from "../types";

export const JIRA: IntegrationProvider = {
  key: "jira",
  label: "Jira",
  baseUrlFromConnection: true,
  serverUrlExample: "https://your-site.atlassian.net",
  authScheme: "basic",
  description: "Manage Jira tickets — read, create, comment, and transition.",
  auth: "A Jira connection whose Server URL is your Atlassian site (https://you.atlassian.net) and whose token is `your-email@company.com:your-api-token` (sent as HTTP Basic).",
  // No `tokenUrl`: Atlassian's API-token page is not verified against a live console here, and a
  // confidently-wrong deep link costs the reader more than the area-level step below.
  credentialSetup: {
    steps: [
      "In your Atlassian account settings, open Security → API tokens and create a token.",
      "Join it to the account email as `email:token` — that pair is the credential, not the token alone.",
      "Or connect via Atlassian OAuth (3LO) from the Integrations screen and handle no token at all.",
    ],
    tokenFormat:
      "Paste `your-email@company.com:your-api-token` — the pair, colon-separated. Naary base64-encodes it as HTTP Basic; the token on its own returns 401.",
  },
  actions: [
    {
      key: "get_issue",
      label: "Get issue",
      description: "Fetch an issue by key (e.g. PROJ-123).",
      method: "GET",
      pathTemplate: "/rest/api/2/issue/{issueKey}",
      write: false,
      fields: [
        {
          key: "issueKey",
          label: "Issue key",
          in: "path",
          required: true,
          hint: "e.g. PROJ-123",
        },
      ],
    },
    {
      key: "create_issue",
      label: "Create issue",
      description: "Create a new ticket in a project.",
      method: "POST",
      pathTemplate: "/rest/api/2/issue",
      write: true,
      fields: [
        {
          key: "projectKey",
          label: "Project key",
          in: "body",
          required: true,
          bodyPath: "fields.project.key",
          hint: "e.g. PROJ",
        },
        {
          key: "summary",
          label: "Summary",
          in: "body",
          required: true,
          bodyPath: "fields.summary",
        },
        {
          key: "issueType",
          label: "Issue type",
          in: "body",
          required: true,
          bodyPath: "fields.issuetype.name",
          hint: "Bug | Task | Story",
        },
        {
          key: "description",
          label: "Description",
          in: "body",
          required: false,
          bodyPath: "fields.description",
        },
        {
          key: "priority",
          label: "Priority",
          in: "body",
          required: false,
          bodyPath: "fields.priority.name",
          hint: "Low | Medium | High",
        },
      ],
    },
    {
      key: "add_comment",
      label: "Add comment",
      description: "Comment on an existing ticket.",
      method: "POST",
      pathTemplate: "/rest/api/2/issue/{issueKey}/comment",
      write: true,
      fields: [
        { key: "issueKey", label: "Issue key", in: "path", required: true },
        {
          key: "body",
          label: "Comment",
          in: "body",
          required: true,
          bodyPath: "body",
        },
      ],
    },
    {
      key: "transition_issue",
      label: "Transition issue",
      description: "Move a ticket to another status by transition id.",
      method: "POST",
      pathTemplate: "/rest/api/2/issue/{issueKey}/transitions",
      write: true,
      fields: [
        { key: "issueKey", label: "Issue key", in: "path", required: true },
        {
          key: "transitionId",
          label: "Transition id",
          in: "body",
          required: true,
          bodyPath: "transition.id",
          hint: "numeric id from the workflow",
        },
      ],
    },
    {
      key: "get_myself",
      label: "Get current user",
      description:
        "Return the account this token belongs to. Needs no arguments, so it is the connection check.",
      method: "GET",
      // `/rest/api/2/` deliberately, matching every other Jira action here: v2 exists on Cloud AND
      // Server/DC, where the v3 API the issue suggested is Cloud-only.
      pathTemplate: "/rest/api/2/myself",
      write: false,
      probe: true,
      fields: [],
    },
  ],
};
