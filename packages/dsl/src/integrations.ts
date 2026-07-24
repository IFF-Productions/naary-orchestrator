/**
 * Declarative integration catalog (design docs/design/INTEGRATION-NODES.md).
 *
 * A single `integration` node type is parameterized by { provider, action } that index
 * into this catalog: provider → action → { method, pathTemplate, write, fields }. The
 * catalog is the ONE source of truth for the config-panel UI, the activity's request
 * construction, the save-gate validator, the per-node docs, and the tests — so nothing
 * can drift. Adding an integration is a catalog entry, not a new node type (Tier-1:
 * interpreter, not codegen).
 *
 * Pure + dependency-free (no zod, no I/O) so it stays in the worker bundle cheaply and
 * both the interpreter and the web app can import it.
 */
import type { ArgBinding, IntegrationNodeConfig } from "./types";
import { getByPath } from "./mcp-args";

export type FieldLocation = "path" | "query" | "body";
/** `json` = a raw JSON value (object/array) for schema-driven payloads that a flat field can't
 *  express, e.g. Notion's `properties` or an Airtable record's `fields`. */
export type FieldType = "string" | "number" | "boolean" | "string[]" | "json";

export interface IntegrationField {
  key: string;
  label: string;
  /** Where the value goes: a `{placeholder}` in the path, a query param, or the JSON body. */
  in: FieldLocation;
  required: boolean;
  type?: FieldType;
  /** For `in: "body"` only — the dotted path where this value lands in the JSON body
   *  (default: the field key at the top level). Lets a flat field feed a NESTED payload,
   *  e.g. Jira's `fields.project.key`. */
  bodyPath?: string;
  /** Short help shown under the field in the config panel + docs. */
  hint?: string;
  /** Body fields only: keep the value in the payload even when it's an empty string — for APIs where
   *  `""` is meaningful (e.g. Dropbox's root folder `path: ""`). Off by default, so an empty optional
   *  field is dropped as usual. */
  keepEmpty?: boolean;
}

export interface IntegrationAction {
  key: string;
  label: string;
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** e.g. "/repos/{owner}/{repo}/issues" — every `{placeholder}` MUST be an `in:"path"` field. */
  pathTemplate: string;
  /** A side-effecting write: routed AT-MOST-ONCE (no retry) so a lost response can't
   *  duplicate the create/update (design §4). Reads are retryable. */
  write: boolean;
  fields: IntegrationField[];
  /** Per-action request headers (non-secret), merged OVER the provider's static headers —
   *  e.g. GitHub's `Accept: application/vnd.github.diff` to fetch a PR as a unified diff
   *  instead of JSON. Never carries auth (that's resolved in-activity). */
  headers?: Record<string, string>;
  /** One-line description for the config panel + docs. */
  description: string;
}

export interface IntegrationProvider {
  key: string;
  label: string;
  /** Static API base, e.g. "https://api.github.com". */
  baseUrl?: string;
  /** When true, the base URL is the CONNECTION's serverUrl (e.g. an Atlassian site). */
  baseUrlFromConnection?: boolean;
  /**
   * How the connection token becomes the Authorization header (default "bearer").
   * "basic" = HTTP Basic — the stored token is `email:api_token` and is sent as
   * `Basic base64(email:api_token)`. Jira Cloud + an Atlassian API token needs this
   * (Bearer is only for its OAuth access tokens); GitHub is genuinely "bearer".
   */
  authScheme?: "bearer" | "basic";
  /** Provider-required static headers (non-secret), e.g. GitHub's Accept/version. */
  headers?: Record<string, string>;
  /** One-line description + setup note surfaced in the palette + docs. */
  description: string;
  /** How a user authenticates (shown in docs). */
  auth: string;
  actions: IntegrationAction[];
}

// ── GitHub (cloud, api.github.com; auth = a PAT or GitHub App token as a Bearer) ──────
const GITHUB: IntegrationProvider = {
  key: "github",
  label: "GitHub",
  baseUrl: "https://api.github.com",
  headers: {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  },
  description: "Act on GitHub issues — read, create, comment, and label.",
  auth: "A GitHub connection with a Personal Access Token (repo scope) or a GitHub App token, stored as the connection's Bearer token.",
  actions: [
    {
      key: "get_issue",
      label: "Get issue",
      description: "Fetch a single issue by number.",
      method: "GET",
      pathTemplate: "/repos/{owner}/{repo}/issues/{issueNumber}",
      write: false,
      fields: [
        {
          key: "owner",
          label: "Owner",
          in: "path",
          required: true,
          hint: "org or user, e.g. octocat",
        },
        { key: "repo", label: "Repository", in: "path", required: true },
        {
          key: "issueNumber",
          label: "Issue number",
          in: "path",
          required: true,
          type: "number",
        },
      ],
    },
    {
      key: "get_pull_request",
      label: "Get pull request (as diff)",
      description:
        "Fetch a PR's unified DIFF text (not JSON) — feed it to an agent to review the code changes.",
      method: "GET",
      pathTemplate: "/repos/{owner}/{repo}/pulls/{pullNumber}",
      write: false,
      // The `diff` media type makes GitHub return the raw unified diff as the body
      // (text) instead of the PR's JSON — exactly what a code-review agent needs.
      headers: { Accept: "application/vnd.github.diff" },
      fields: [
        {
          key: "owner",
          label: "Owner",
          in: "path",
          required: true,
          hint: "org or user, e.g. octocat",
        },
        { key: "repo", label: "Repository", in: "path", required: true },
        {
          key: "pullNumber",
          label: "PR number",
          in: "path",
          required: true,
          type: "number",
        },
      ],
    },
    {
      key: "create_issue",
      label: "Create issue",
      description: "Open a new issue in a repository.",
      method: "POST",
      pathTemplate: "/repos/{owner}/{repo}/issues",
      write: true,
      fields: [
        { key: "owner", label: "Owner", in: "path", required: true },
        { key: "repo", label: "Repository", in: "path", required: true },
        { key: "title", label: "Title", in: "body", required: true },
        { key: "body", label: "Body", in: "body", required: false },
        {
          key: "labels",
          label: "Labels",
          in: "body",
          required: false,
          type: "string[]",
        },
      ],
    },
    {
      key: "comment_issue",
      label: "Comment on issue",
      description: "Add a comment to an existing issue.",
      method: "POST",
      pathTemplate: "/repos/{owner}/{repo}/issues/{issueNumber}/comments",
      write: true,
      fields: [
        { key: "owner", label: "Owner", in: "path", required: true },
        { key: "repo", label: "Repository", in: "path", required: true },
        {
          key: "issueNumber",
          label: "Issue number",
          in: "path",
          required: true,
          type: "number",
        },
        { key: "body", label: "Comment", in: "body", required: true },
      ],
    },
    {
      key: "add_labels",
      label: "Add labels",
      description: "Apply labels to an issue.",
      method: "POST",
      pathTemplate: "/repos/{owner}/{repo}/issues/{issueNumber}/labels",
      write: true,
      fields: [
        { key: "owner", label: "Owner", in: "path", required: true },
        { key: "repo", label: "Repository", in: "path", required: true },
        {
          key: "issueNumber",
          label: "Issue number",
          in: "path",
          required: true,
          type: "number",
        },
        {
          key: "labels",
          label: "Labels",
          in: "body",
          required: true,
          type: "string[]",
        },
      ],
    },
  ],
};

// ── Jira (Atlassian Cloud; base = the connection's site URL; REST v2 for plain-string
//    descriptions. Auth: an Atlassian API token via HTTP Basic (authScheme "basic",
//    connection token = `email:api_token`), or an OAuth access token via Bearer) ───────
const JIRA: IntegrationProvider = {
  key: "jira",
  label: "Jira",
  baseUrlFromConnection: true,
  authScheme: "basic",
  description: "Manage Jira tickets — read, create, comment, and transition.",
  auth: "A Jira connection whose Server URL is your Atlassian site (https://you.atlassian.net) and whose token is `your-email@company.com:your-api-token` (sent as HTTP Basic).",
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
  ],
};

// ── Slack (Web API; static base slack.com/api; auth = a bot token `xoxb-…` as Bearer,
//    stored on a "custom" connection) ────────────────────────────────────────────────
const SLACK: IntegrationProvider = {
  key: "slack",
  label: "Slack",
  baseUrl: "https://slack.com/api",
  description: "Post to Slack — send a message, reply in a thread, or react.",
  auth: "A custom connection whose token is a Slack bot token (`xoxb-…`) with the needed scopes (e.g. chat:write, reactions:write). The Server URL is unused (base is slack.com).",
  actions: [
    {
      key: "post_message",
      label: "Post message",
      description: "Send a message to a channel (or reply in a thread).",
      method: "POST",
      pathTemplate: "/chat.postMessage",
      write: true,
      fields: [
        {
          key: "channel",
          label: "Channel",
          in: "body",
          required: true,
          hint: "#channel or a channel ID",
        },
        { key: "text", label: "Text", in: "body", required: true },
        {
          key: "threadTs",
          label: "Thread ts",
          in: "body",
          required: false,
          bodyPath: "thread_ts",
          hint: "reply under this message ts",
        },
      ],
    },
    {
      key: "update_message",
      label: "Update message",
      description: "Edit a message you posted.",
      method: "POST",
      pathTemplate: "/chat.update",
      write: true,
      fields: [
        { key: "channel", label: "Channel", in: "body", required: true },
        {
          key: "ts",
          label: "Message ts",
          in: "body",
          required: true,
          hint: "timestamp of the message to edit",
        },
        { key: "text", label: "Text", in: "body", required: true },
      ],
    },
    {
      key: "add_reaction",
      label: "Add reaction",
      description: "React to a message with an emoji.",
      method: "POST",
      pathTemplate: "/reactions.add",
      write: true,
      fields: [
        { key: "channel", label: "Channel", in: "body", required: true },
        { key: "timestamp", label: "Message ts", in: "body", required: true },
        {
          key: "name",
          label: "Emoji",
          in: "body",
          required: true,
          hint: "emoji name without colons, e.g. white_check_mark",
        },
      ],
    },
  ],
};

// ── Notion (REST v1; static base api.notion.com; auth = an internal integration token as
//    Bearer; requires the Notion-Version header. Schema-driven payloads use `json` fields) ──
const NOTION: IntegrationProvider = {
  key: "notion",
  label: "Notion",
  baseUrl: "https://api.notion.com/v1",
  headers: { "Notion-Version": "2022-06-28" },
  description:
    "Read and write Notion — get/query, create pages, append blocks.",
  auth: "A custom connection whose token is a Notion internal integration token (`secret_…` / `ntn_…`); share the target pages/databases with the integration.",
  actions: [
    {
      key: "get_page",
      label: "Get page",
      description: "Fetch a page's properties by id.",
      method: "GET",
      pathTemplate: "/pages/{pageId}",
      write: false,
      fields: [{ key: "pageId", label: "Page id", in: "path", required: true }],
    },
    {
      key: "query_database",
      label: "Query database",
      description: "Query a database, optionally with a filter/sort.",
      method: "POST",
      pathTemplate: "/databases/{databaseId}/query",
      write: false,
      fields: [
        { key: "databaseId", label: "Database id", in: "path", required: true },
        {
          key: "filter",
          label: "Filter (JSON)",
          in: "body",
          required: false,
          type: "json",
          hint: "Notion filter object",
        },
        {
          key: "pageSize",
          label: "Page size",
          in: "body",
          required: false,
          type: "number",
          bodyPath: "page_size",
        },
      ],
    },
    {
      key: "create_page",
      label: "Create page",
      description: "Create a page in a database or under a parent page.",
      method: "POST",
      pathTemplate: "/pages",
      write: true,
      fields: [
        {
          key: "parent",
          label: "Parent (JSON)",
          in: "body",
          required: true,
          type: "json",
          hint: '{ "database_id": "…" } or { "page_id": "…" }',
        },
        {
          key: "properties",
          label: "Properties (JSON)",
          in: "body",
          required: true,
          type: "json",
          hint: "Notion property values keyed by property name",
        },
      ],
    },
    {
      key: "append_block",
      label: "Append blocks",
      description: "Append child blocks to a page or block.",
      method: "PATCH",
      pathTemplate: "/blocks/{blockId}/children",
      write: true,
      fields: [
        { key: "blockId", label: "Block/Page id", in: "path", required: true },
        {
          key: "children",
          label: "Children (JSON)",
          in: "body",
          required: true,
          type: "json",
          hint: "array of Notion block objects",
        },
      ],
    },
  ],
};

// ── GitLab (cloud, gitlab.com/api/v4; auth = a personal access token with the `api`
//    scope as a Bearer. `projectId` is a numeric id OR a raw 'group/project' path — path fields are URL-encoded by buildIntegrationRequest, so pass it un-encoded) ──
const GITLAB: IntegrationProvider = {
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
  ],
};

const HUBSPOT: IntegrationProvider = {
  key: "hubspot",
  label: "HubSpot",
  baseUrl: "https://api.hubapi.com",
  description:
    "Act on HubSpot CRM — get, create, and update contacts; create deals.",
  auth: "A custom connection whose token is a HubSpot private-app access token.",
  actions: [
    {
      key: "get_contact",
      label: "Get contact",
      description: "Fetch a single contact by id.",
      method: "GET",
      pathTemplate: "/crm/v3/objects/contacts/{contactId}",
      write: false,
      fields: [
        { key: "contactId", label: "Contact id", in: "path", required: true },
      ],
    },
    {
      key: "create_contact",
      label: "Create contact",
      description: "Create a new contact.",
      method: "POST",
      pathTemplate: "/crm/v3/objects/contacts",
      write: true,
      fields: [
        {
          key: "properties",
          label: "Properties (JSON)",
          in: "body",
          required: true,
          type: "json",
          bodyPath: "properties",
          hint: "contact properties object, e.g. { email, firstname }",
        },
      ],
    },
    {
      key: "update_contact",
      label: "Update contact",
      description: "Update an existing contact by id.",
      method: "PATCH",
      pathTemplate: "/crm/v3/objects/contacts/{contactId}",
      write: true,
      fields: [
        { key: "contactId", label: "Contact id", in: "path", required: true },
        {
          key: "properties",
          label: "Properties (JSON)",
          in: "body",
          required: true,
          type: "json",
          bodyPath: "properties",
        },
      ],
    },
    {
      key: "create_deal",
      label: "Create deal",
      description: "Create a new deal.",
      method: "POST",
      pathTemplate: "/crm/v3/objects/deals",
      write: true,
      fields: [
        {
          key: "properties",
          label: "Properties (JSON)",
          in: "body",
          required: true,
          type: "json",
          bodyPath: "properties",
        },
      ],
    },
  ],
};

const SENDGRID: IntegrationProvider = {
  key: "sendgrid",
  label: "SendGrid",
  baseUrl: "https://api.sendgrid.com/v3",
  description:
    "Send email and manage marketing contacts via SendGrid — send mail, upsert contacts, list templates.",
  auth: "A custom connection whose token is a SendGrid API key.",
  actions: [
    {
      key: "send_mail",
      label: "Send mail",
      description: "Send a transactional email via the v3 Mail Send API.",
      method: "POST",
      pathTemplate: "/mail/send",
      write: true,
      fields: [
        {
          key: "personalizations",
          label: "Personalizations (JSON)",
          in: "body",
          required: true,
          type: "json",
          hint: "array of personalization objects",
        },
        {
          key: "from",
          label: "From (JSON)",
          in: "body",
          required: true,
          type: "json",
          hint: "{ email, name? }",
        },
        {
          key: "subject",
          label: "Subject",
          in: "body",
          required: true,
          type: "string",
        },
        {
          key: "content",
          label: "Content (JSON)",
          in: "body",
          required: true,
          type: "json",
          hint: "array of { type, value }",
        },
      ],
    },
    {
      key: "upsert_contacts",
      label: "Upsert contacts",
      description: "Add or update marketing contacts (async upsert).",
      method: "PUT",
      pathTemplate: "/marketing/contacts",
      write: true,
      fields: [
        {
          key: "contacts",
          label: "Contacts (JSON)",
          in: "body",
          required: true,
          type: "json",
          hint: "array of contact objects",
        },
      ],
    },
    {
      key: "list_templates",
      label: "List templates",
      description: "List transactional templates.",
      method: "GET",
      pathTemplate: "/templates",
      write: false,
      fields: [
        {
          key: "generations",
          label: "Generations",
          in: "query",
          required: false,
          hint: "legacy|dynamic",
        },
      ],
    },
  ],
};

const AIRTABLE: IntegrationProvider = {
  key: "airtable",
  label: "Airtable",
  baseUrl: "https://api.airtable.com/v0",
  description: "Read and write Airtable records — list, get, create, update.",
  auth: "A custom connection whose token is an Airtable personal access token (with data scopes for the base).",
  actions: [
    {
      key: "list_records",
      label: "List records",
      description: "List records in a table, optionally filtered by view.",
      method: "GET",
      pathTemplate: "/{baseId}/{tableId}",
      write: false,
      fields: [
        {
          key: "baseId",
          label: "Base id",
          in: "path",
          required: true,
          hint: "e.g. appXXXXXXXXXXXXXX",
        },
        {
          key: "tableId",
          label: "Table id or name",
          in: "path",
          required: true,
          hint: "e.g. tblXXXXXXXXXXXXXX or the table name",
        },
        {
          key: "maxRecords",
          label: "Max records",
          in: "query",
          required: false,
          type: "number",
        },
        { key: "view", label: "View", in: "query", required: false },
      ],
    },
    {
      key: "get_record",
      label: "Get record",
      description: "Fetch a single record by id.",
      method: "GET",
      pathTemplate: "/{baseId}/{tableId}/{recordId}",
      write: false,
      fields: [
        { key: "baseId", label: "Base id", in: "path", required: true },
        {
          key: "tableId",
          label: "Table id or name",
          in: "path",
          required: true,
        },
        {
          key: "recordId",
          label: "Record id",
          in: "path",
          required: true,
          hint: "e.g. recXXXXXXXXXXXXXX",
        },
      ],
    },
    {
      key: "create_record",
      label: "Create record",
      description: "Create a record in a table.",
      method: "POST",
      pathTemplate: "/{baseId}/{tableId}",
      write: true,
      fields: [
        { key: "baseId", label: "Base id", in: "path", required: true },
        {
          key: "tableId",
          label: "Table id or name",
          in: "path",
          required: true,
        },
        {
          key: "fields",
          label: "Fields (JSON)",
          in: "body",
          required: true,
          type: "json",
          bodyPath: "fields",
          hint: "record field values keyed by field name",
        },
      ],
    },
    {
      key: "update_record",
      label: "Update record",
      description: "Update fields on an existing record.",
      method: "PATCH",
      pathTemplate: "/{baseId}/{tableId}/{recordId}",
      write: true,
      fields: [
        { key: "baseId", label: "Base id", in: "path", required: true },
        {
          key: "tableId",
          label: "Table id or name",
          in: "path",
          required: true,
        },
        {
          key: "recordId",
          label: "Record id",
          in: "path",
          required: true,
        },
        {
          key: "fields",
          label: "Fields (JSON)",
          in: "body",
          required: true,
          type: "json",
          bodyPath: "fields",
          hint: "record field values keyed by field name",
        },
      ],
    },
  ],
};

const ASANA: IntegrationProvider = {
  key: "asana",
  label: "Asana",
  baseUrl: "https://app.asana.com/api/1.0",
  description: "Manage Asana tasks — read, create, update, and comment.",
  auth: "A custom connection whose token is an Asana personal access token.",
  actions: [
    {
      key: "get_task",
      label: "Get task",
      description: "Fetch a single task by gid.",
      method: "GET",
      pathTemplate: "/tasks/{taskGid}",
      write: false,
      fields: [
        { key: "taskGid", label: "Task gid", in: "path", required: true },
      ],
    },
    {
      key: "create_task",
      label: "Create task",
      description: "Create a new task.",
      method: "POST",
      pathTemplate: "/tasks",
      write: true,
      fields: [
        {
          key: "name",
          label: "Name",
          in: "body",
          required: true,
          bodyPath: "data.name",
        },
        {
          key: "notes",
          label: "Notes",
          in: "body",
          required: false,
          bodyPath: "data.notes",
        },
        {
          key: "projects",
          label: "Projects",
          in: "body",
          required: false,
          type: "string[]",
          bodyPath: "data.projects",
          hint: "array of project gids",
        },
      ],
    },
    {
      key: "add_comment",
      label: "Add comment",
      description: "Add a comment (story) to a task.",
      method: "POST",
      pathTemplate: "/tasks/{taskGid}/stories",
      write: true,
      fields: [
        { key: "taskGid", label: "Task gid", in: "path", required: true },
        {
          key: "text",
          label: "Comment",
          in: "body",
          required: true,
          bodyPath: "data.text",
        },
      ],
    },
    {
      key: "update_task",
      label: "Update task",
      description: "Update a task's fields (e.g. mark complete or rename).",
      method: "PUT",
      pathTemplate: "/tasks/{taskGid}",
      write: true,
      fields: [
        { key: "taskGid", label: "Task gid", in: "path", required: true },
        {
          key: "completed",
          label: "Completed",
          in: "body",
          required: false,
          type: "boolean",
          bodyPath: "data.completed",
        },
        {
          key: "name",
          label: "Name",
          in: "body",
          required: false,
          bodyPath: "data.name",
        },
      ],
    },
  ],
};

const TODOIST: IntegrationProvider = {
  key: "todoist",
  label: "Todoist",
  baseUrl: "https://api.todoist.com/rest/v2",
  description: "Manage Todoist tasks — list, get, create, and close.",
  auth: "A custom connection whose token is a Todoist API token.",
  actions: [
    {
      key: "list_tasks",
      label: "List tasks",
      description:
        "List active tasks, optionally filtered by project or query.",
      method: "GET",
      pathTemplate: "/tasks",
      write: false,
      fields: [
        {
          // Query field KEY is the literal param name (query has no bodyPath remap), so it must be
          // Todoist's snake_case `project_id`, not `projectId` (#647 review).
          key: "project_id",
          label: "Project id",
          in: "query",
          required: false,
          hint: "filter by project",
        },
        { key: "filter", label: "Filter", in: "query", required: false },
      ],
    },
    {
      key: "get_task",
      label: "Get task",
      description: "Fetch a single task by id.",
      method: "GET",
      pathTemplate: "/tasks/{taskId}",
      write: false,
      fields: [{ key: "taskId", label: "Task id", in: "path", required: true }],
    },
    {
      key: "create_task",
      label: "Create task",
      description: "Create a new task.",
      method: "POST",
      pathTemplate: "/tasks",
      write: true,
      fields: [
        { key: "content", label: "Content", in: "body", required: true },
        {
          key: "description",
          label: "Description",
          in: "body",
          required: false,
        },
        {
          key: "projectId",
          label: "Project id",
          in: "body",
          required: false,
          bodyPath: "project_id",
        },
        {
          key: "dueString",
          label: "Due (natural language)",
          in: "body",
          required: false,
          bodyPath: "due_string",
        },
        {
          key: "priority",
          label: "Priority",
          in: "body",
          required: false,
          type: "number",
        },
      ],
    },
    {
      key: "close_task",
      label: "Close task",
      description: "Close (complete) a task by id.",
      method: "POST",
      pathTemplate: "/tasks/{taskId}/close",
      write: true,
      fields: [{ key: "taskId", label: "Task id", in: "path", required: true }],
    },
  ],
};

const CALENDLY: IntegrationProvider = {
  key: "calendly",
  label: "Calendly",
  baseUrl: "https://api.calendly.com",
  description:
    "Read your Calendly account — who am I, list/get scheduled events, cancel an event.",
  auth: "A custom connection whose token is a Calendly personal access token — sent as a Bearer token.",
  actions: [
    {
      key: "get_me",
      label: "Get current user",
      description: "Fetch the authenticated user (your user URI).",
      method: "GET",
      pathTemplate: "/users/me",
      write: false,
      fields: [],
    },
    {
      key: "list_events",
      label: "List scheduled events",
      description:
        "List scheduled events for a user, optionally filtered by status.",
      method: "GET",
      pathTemplate: "/scheduled_events",
      write: false,
      fields: [
        {
          key: "user",
          label: "User",
          in: "query",
          required: true,
          hint: "user URI",
        },
        {
          key: "status",
          label: "Status",
          in: "query",
          required: false,
          hint: "active|canceled",
        },
        {
          key: "count",
          label: "Count",
          in: "query",
          required: false,
          type: "number",
        },
      ],
    },
    {
      key: "get_event",
      label: "Get scheduled event",
      description: "Fetch a single scheduled event by UUID.",
      method: "GET",
      pathTemplate: "/scheduled_events/{eventUuid}",
      write: false,
      fields: [
        { key: "eventUuid", label: "Event UUID", in: "path", required: true },
      ],
    },
    {
      key: "cancel_event",
      label: "Cancel scheduled event",
      description: "Cancel a scheduled event, with an optional reason.",
      method: "POST",
      pathTemplate: "/scheduled_events/{eventUuid}/cancellation",
      write: true,
      fields: [
        { key: "eventUuid", label: "Event UUID", in: "path", required: true },
        { key: "reason", label: "Reason", in: "body", required: false },
      ],
    },
  ],
};

const INTERCOM: IntegrationProvider = {
  key: "intercom",
  label: "Intercom",
  baseUrl: "https://api.intercom.io",
  authScheme: "bearer",
  headers: { "Intercom-Version": "2.11" },
  description:
    "Work with Intercom — read/create contacts, add a note, send a message.",
  auth: "A custom connection whose token is an Intercom access token.",
  actions: [
    {
      key: "get_contact",
      label: "Get contact",
      description: "Fetch a single contact by id.",
      method: "GET",
      pathTemplate: "/contacts/{contactId}",
      write: false,
      fields: [
        { key: "contactId", label: "Contact id", in: "path", required: true },
      ],
    },
    {
      key: "create_contact",
      label: "Create contact",
      description: "Create a new contact (user or lead).",
      method: "POST",
      pathTemplate: "/contacts",
      write: true,
      fields: [
        {
          key: "role",
          label: "Role",
          in: "body",
          required: true,
          hint: "user|lead",
        },
        { key: "email", label: "Email", in: "body", required: false },
        { key: "name", label: "Name", in: "body", required: false },
      ],
    },
    {
      key: "create_note",
      label: "Create note",
      description: "Add a note to a contact.",
      method: "POST",
      pathTemplate: "/contacts/{contactId}/notes",
      write: true,
      fields: [
        { key: "contactId", label: "Contact id", in: "path", required: true },
        { key: "body", label: "Note", in: "body", required: true },
      ],
    },
    {
      key: "send_message",
      label: "Send message",
      description: "Send an in-app or email message.",
      method: "POST",
      pathTemplate: "/messages",
      write: true,
      fields: [
        {
          key: "messageType",
          label: "Message type",
          in: "body",
          required: true,
          bodyPath: "message_type",
          hint: "inapp|email",
        },
        { key: "subject", label: "Subject", in: "body", required: false },
        {
          key: "bodyText",
          label: "Body",
          in: "body",
          required: true,
          bodyPath: "body",
        },
        {
          key: "from",
          label: "From",
          in: "body",
          required: true,
          type: "json",
          hint: "{ type, id }",
        },
        {
          key: "to",
          label: "To",
          in: "body",
          required: true,
          type: "json",
          hint: "{ type, id }",
        },
      ],
    },
  ],
};

const WEBFLOW: IntegrationProvider = {
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
  ],
};

const ZOOM: IntegrationProvider = {
  key: "zoom",
  label: "Zoom",
  baseUrl: "https://api.zoom.us/v2",
  authScheme: "bearer",
  description: "Manage Zoom meetings — list, create, get, and delete.",
  auth: "A custom connection whose token is a Zoom server-to-server OAuth access token. NOTE: these tokens are short-lived (~1h) — refresh/rotate the stored token periodically or calls will start failing with 401.",
  actions: [
    {
      key: "list_meetings",
      label: "List meetings",
      description: "List a user's meetings.",
      method: "GET",
      pathTemplate: "/users/{userId}/meetings",
      write: false,
      fields: [
        {
          key: "userId",
          label: "User id",
          in: "path",
          required: true,
          hint: "usually 'me'",
        },
        {
          key: "type",
          label: "Type",
          in: "query",
          required: false,
          hint: "scheduled|live|upcoming",
        },
      ],
    },
    {
      key: "create_meeting",
      label: "Create meeting",
      description: "Schedule a new meeting for a user.",
      method: "POST",
      pathTemplate: "/users/{userId}/meetings",
      write: true,
      fields: [
        {
          key: "userId",
          label: "User id",
          in: "path",
          required: true,
          hint: "usually 'me'",
        },
        { key: "topic", label: "Topic", in: "body", required: true },
        {
          key: "type",
          label: "Type",
          in: "body",
          required: false,
          type: "number",
          hint: "1 instant, 2 scheduled",
        },
        {
          key: "startTime",
          label: "Start time",
          in: "body",
          required: false,
          bodyPath: "start_time",
        },
        {
          key: "duration",
          label: "Duration",
          in: "body",
          required: false,
          type: "number",
        },
      ],
    },
    {
      key: "get_meeting",
      label: "Get meeting",
      description: "Fetch a meeting by id.",
      method: "GET",
      pathTemplate: "/meetings/{meetingId}",
      write: false,
      fields: [
        { key: "meetingId", label: "Meeting id", in: "path", required: true },
      ],
    },
    {
      key: "delete_meeting",
      label: "Delete meeting",
      description: "Delete a meeting by id.",
      method: "DELETE",
      pathTemplate: "/meetings/{meetingId}",
      write: true,
      fields: [
        { key: "meetingId", label: "Meeting id", in: "path", required: true },
      ],
    },
  ],
};

const FRONT: IntegrationProvider = {
  key: "front",
  label: "Front",
  baseUrl: "https://api2.frontapp.com",
  authScheme: "bearer",
  description:
    "Work with Front conversations — list/get conversations, comment, list inboxes.",
  auth: "A custom connection whose token is a Front API token — sent as a Bearer token.",
  actions: [
    {
      key: "list_conversations",
      label: "List conversations",
      description: "List conversations, optionally filtered by a search query.",
      method: "GET",
      pathTemplate: "/conversations",
      write: false,
      fields: [
        {
          key: "q",
          label: "Query",
          in: "query",
          required: false,
          hint: "search query",
        },
      ],
    },
    {
      key: "get_conversation",
      label: "Get conversation",
      description: "Fetch a single conversation by id.",
      method: "GET",
      pathTemplate: "/conversations/{conversationId}",
      write: false,
      fields: [
        {
          key: "conversationId",
          label: "Conversation id",
          in: "path",
          required: true,
        },
      ],
    },
    {
      key: "add_comment",
      label: "Add comment",
      description: "Add an internal comment to a conversation.",
      method: "POST",
      pathTemplate: "/conversations/{conversationId}/comments",
      write: true,
      fields: [
        {
          key: "conversationId",
          label: "Conversation id",
          in: "path",
          required: true,
        },
        { key: "body", label: "Comment", in: "body", required: true },
        {
          key: "author_id",
          label: "Author id",
          in: "body",
          required: false,
          hint: "teammate id authoring the comment",
        },
      ],
    },
    {
      key: "list_inboxes",
      label: "List inboxes",
      description: "List the inboxes in the account.",
      method: "GET",
      pathTemplate: "/inboxes",
      write: false,
      fields: [],
    },
  ],
};

const SENTRY: IntegrationProvider = {
  key: "sentry",
  label: "Sentry",
  baseUrl: "https://sentry.io/api/0",
  authScheme: "bearer",
  description:
    "Triage Sentry — list/get issues, resolve or ignore them, list projects.",
  auth: "A custom connection whose token is a Sentry auth token — sent as a Bearer token.",
  actions: [
    {
      key: "list_issues",
      label: "List issues",
      description:
        "List a project's issues, optionally filtered by a search query or time window.",
      method: "GET",
      pathTemplate: "/projects/{organizationSlug}/{projectSlug}/issues/",
      write: false,
      fields: [
        {
          key: "organizationSlug",
          label: "Organization slug",
          in: "path",
          required: true,
        },
        {
          key: "projectSlug",
          label: "Project slug",
          in: "path",
          required: true,
        },
        {
          key: "query",
          label: "Query",
          in: "query",
          required: false,
          hint: "Sentry search, e.g. is:unresolved",
        },
        {
          key: "statsPeriod",
          label: "Stats period",
          in: "query",
          required: false,
          hint: "e.g. 24h, 14d",
        },
      ],
    },
    {
      key: "get_issue",
      label: "Get issue",
      description: "Fetch a single issue by id.",
      method: "GET",
      pathTemplate: "/issues/{issueId}/",
      write: false,
      fields: [
        { key: "issueId", label: "Issue id", in: "path", required: true },
      ],
    },
    {
      key: "update_issue",
      label: "Update issue",
      description: "Update an issue's status (resolve, ignore, or reopen).",
      method: "PUT",
      pathTemplate: "/issues/{issueId}/",
      write: true,
      fields: [
        { key: "issueId", label: "Issue id", in: "path", required: true },
        {
          key: "status",
          label: "Status",
          in: "body",
          required: true,
          hint: "resolved|ignored|unresolved",
        },
      ],
    },
    {
      key: "list_projects",
      label: "List projects",
      description: "List the projects in an organization.",
      method: "GET",
      pathTemplate: "/organizations/{organizationSlug}/projects/",
      write: false,
      fields: [
        {
          key: "organizationSlug",
          label: "Organization slug",
          in: "path",
          required: true,
        },
      ],
    },
  ],
};

const VERCEL: IntegrationProvider = {
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

const NETLIFY: IntegrationProvider = {
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

const DIGITALOCEAN: IntegrationProvider = {
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

const CLOUDFLARE: IntegrationProvider = {
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

const POSTHOG: IntegrationProvider = {
  key: "posthog",
  label: "PostHog",
  baseUrl: "https://app.posthog.com",
  authScheme: "bearer",
  description:
    "Read PostHog analytics — list events and persons, get a person, add an annotation.",
  auth: "A custom connection whose token is a PostHog personal API key — sent as a Bearer token.",
  actions: [
    {
      key: "list_events",
      label: "List events",
      description: "List recent events for a project.",
      method: "GET",
      pathTemplate: "/api/projects/{projectId}/events/",
      write: false,
      fields: [
        { key: "projectId", label: "Project id", in: "path", required: true },
      ],
    },
    {
      key: "list_persons",
      label: "List persons",
      description: "List persons for a project, optionally filtered by search.",
      method: "GET",
      pathTemplate: "/api/projects/{projectId}/persons/",
      write: false,
      fields: [
        { key: "projectId", label: "Project id", in: "path", required: true },
        { key: "search", label: "Search", in: "query", required: false },
      ],
    },
    {
      key: "get_person",
      label: "Get person",
      description: "Fetch a single person by id.",
      method: "GET",
      pathTemplate: "/api/projects/{projectId}/persons/{personId}/",
      write: false,
      fields: [
        { key: "projectId", label: "Project id", in: "path", required: true },
        { key: "personId", label: "Person id", in: "path", required: true },
      ],
    },
    {
      key: "create_annotation",
      label: "Create annotation",
      description: "Add an annotation to a project.",
      method: "POST",
      pathTemplate: "/api/projects/{projectId}/annotations/",
      write: true,
      fields: [
        { key: "projectId", label: "Project id", in: "path", required: true },
        { key: "content", label: "Content", in: "body", required: true },
        {
          key: "date_marker",
          label: "Date marker",
          in: "body",
          required: false,
          hint: "ISO timestamp the annotation marks",
        },
      ],
    },
  ],
};

const DROPBOX: IntegrationProvider = {
  key: "dropbox",
  label: "Dropbox",
  baseUrl: "https://api.dropboxapi.com/2",
  authScheme: "bearer",
  description:
    "Work with Dropbox files and folders — list, get metadata, create folders, delete.",
  auth: "A custom connection whose token is a Dropbox access token — sent as a Bearer token.",
  actions: [
    {
      key: "list_folder",
      label: "List folder",
      description: "List the contents of a folder.",
      method: "POST",
      pathTemplate: "/files/list_folder",
      write: false,
      fields: [
        {
          key: "path",
          label: "Path",
          in: "body",
          required: true,
          keepEmpty: true,
          hint: 'folder path, e.g. "" for root or "/Docs"',
        },
      ],
    },
    {
      key: "get_metadata",
      label: "Get metadata",
      description: "Fetch metadata for a file or folder by path.",
      method: "POST",
      pathTemplate: "/files/get_metadata",
      write: false,
      fields: [{ key: "path", label: "Path", in: "body", required: true }],
    },
    {
      key: "create_folder",
      label: "Create folder",
      description: "Create a folder at a path.",
      method: "POST",
      pathTemplate: "/files/create_folder_v2",
      write: true,
      fields: [{ key: "path", label: "Path", in: "body", required: true }],
    },
    {
      key: "delete",
      label: "Delete",
      description: "Delete a file or folder at a path.",
      method: "POST",
      pathTemplate: "/files/delete_v2",
      write: true,
      fields: [{ key: "path", label: "Path", in: "body", required: true }],
    },
  ],
};

const MSGRAPH: IntegrationProvider = {
  key: "msgraph",
  label: "Microsoft Graph",
  baseUrl: "https://graph.microsoft.com/v1.0",
  authScheme: "bearer",
  description:
    "Work with Microsoft 365 via Graph — read mail, send mail, read and create calendar events.",
  auth: "A custom connection whose token is a Microsoft Graph OAuth access token — sent as a Bearer token.",
  actions: [
    {
      key: "list_messages",
      label: "List messages",
      description: "List a user's mail messages.",
      method: "GET",
      pathTemplate: "/users/{userId}/messages",
      write: false,
      fields: [
        {
          key: "userId",
          label: "User id",
          in: "path",
          required: true,
          hint: "'me' for the delegated user, or a user id / UPN",
        },
      ],
    },
    {
      key: "send_mail",
      label: "Send mail",
      description: "Send an email as a user.",
      method: "POST",
      pathTemplate: "/users/{userId}/sendMail",
      write: true,
      fields: [
        {
          key: "userId",
          label: "User id",
          in: "path",
          required: true,
          hint: "'me' for the delegated user, or a user id / UPN",
        },
        {
          key: "message",
          label: "Message (JSON)",
          in: "body",
          required: true,
          type: "json",
          bodyPath: "message",
          hint: "Graph message object: { subject, body, toRecipients }",
        },
        {
          key: "saveToSentItems",
          label: "Save to sent items",
          in: "body",
          required: false,
          type: "boolean",
          bodyPath: "saveToSentItems",
        },
      ],
    },
    {
      key: "list_events",
      label: "List events",
      description: "List a user's calendar events.",
      method: "GET",
      pathTemplate: "/users/{userId}/events",
      write: false,
      fields: [
        {
          key: "userId",
          label: "User id",
          in: "path",
          required: true,
          hint: "'me' for the delegated user, or a user id / UPN",
        },
      ],
    },
    {
      key: "create_event",
      label: "Create event",
      description: "Create a calendar event for a user.",
      method: "POST",
      pathTemplate: "/users/{userId}/events",
      write: true,
      fields: [
        {
          key: "userId",
          label: "User id",
          in: "path",
          required: true,
          hint: "'me' for the delegated user, or a user id / UPN",
        },
        { key: "subject", label: "Subject", in: "body", required: true },
        {
          key: "start",
          label: "Start (JSON)",
          in: "body",
          required: true,
          type: "json",
          hint: "{ dateTime, timeZone }",
        },
        {
          key: "end",
          label: "End (JSON)",
          in: "body",
          required: true,
          type: "json",
          hint: "{ dateTime, timeZone }",
        },
      ],
    },
  ],
};

const BOX: IntegrationProvider = {
  key: "box",
  label: "Box",
  baseUrl: "https://api.box.com/2.0",
  authScheme: "bearer",
  description: "Work with Box files and folders — list, get, create, delete.",
  auth: "A custom connection whose token is a Box access token — sent as a Bearer token.",
  actions: [
    {
      key: "list_folder_items",
      label: "List folder items",
      description: "List the items (files and folders) in a folder.",
      method: "GET",
      pathTemplate: "/folders/{folderId}/items",
      write: false,
      fields: [
        {
          key: "folderId",
          label: "Folder id",
          in: "path",
          required: true,
          hint: "the root folder id is '0'",
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
      key: "get_file",
      label: "Get file",
      description: "Fetch a file's information by id.",
      method: "GET",
      pathTemplate: "/files/{fileId}",
      write: false,
      fields: [{ key: "fileId", label: "File id", in: "path", required: true }],
    },
    {
      key: "create_folder",
      label: "Create folder",
      description: "Create a new folder under a parent folder.",
      method: "POST",
      pathTemplate: "/folders",
      write: true,
      fields: [
        { key: "name", label: "Name", in: "body", required: true },
        {
          key: "parent",
          label: "Parent (JSON)",
          in: "body",
          required: true,
          type: "json",
          hint: '{ "id": "0" } for root',
        },
      ],
    },
    {
      key: "delete_file",
      label: "Delete file",
      description: "Delete a file by id.",
      method: "DELETE",
      pathTemplate: "/files/{fileId}",
      write: true,
      fields: [{ key: "fileId", label: "File id", in: "path", required: true }],
    },
  ],
};

export const INTEGRATION_CATALOG: Record<string, IntegrationProvider> = {
  github: GITHUB,
  jira: JIRA,
  slack: SLACK,
  notion: NOTION,
  gitlab: GITLAB,
  hubspot: HUBSPOT,
  sendgrid: SENDGRID,
  airtable: AIRTABLE,
  asana: ASANA,
  todoist: TODOIST,
  calendly: CALENDLY,
  intercom: INTERCOM,
  webflow: WEBFLOW,
  zoom: ZOOM,
  front: FRONT,
  sentry: SENTRY,
  vercel: VERCEL,
  netlify: NETLIFY,
  digitalocean: DIGITALOCEAN,
  cloudflare: CLOUDFLARE,
  posthog: POSTHOG,
  dropbox: DROPBOX,
  msgraph: MSGRAPH,
  box: BOX,
};

/** The node type added to the palette per provider (the tile presets `provider`). */
export const INTEGRATION_PROVIDERS: IntegrationProvider[] =
  Object.values(INTEGRATION_CATALOG);

export function getIntegrationProvider(
  provider: string,
): IntegrationProvider | undefined {
  return INTEGRATION_CATALOG[provider];
}

export function getIntegrationAction(
  provider: string,
  action: string,
): IntegrationAction | undefined {
  return INTEGRATION_CATALOG[provider]?.actions.find((a) => a.key === action);
}

/** Resolve a node's concrete field values from the run context — static `fields` are the
 *  base, each `fieldBindings` entry overrides its key with `getByPath(ctx[from], path)`.
 *  Mirrors resolveMcpArguments; pure graph-traversal, runs in the interpreter. */
export function resolveIntegrationFields(
  config: IntegrationNodeConfig,
  ctx: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(config.fields ?? {}) };
  for (const [name, binding] of Object.entries(config.fieldBindings ?? {})) {
    const b = binding as ArgBinding;
    out[name] = getByPath(ctx[b.from], b.path);
  }
  return out;
}

/** Set a dotted path on an object, creating intermediate objects. Pure. */
function setPath(
  target: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const keys = path.split(".");
  let obj = target;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (obj[k] == null || typeof obj[k] !== "object") obj[k] = {};
    obj = obj[k] as Record<string, unknown>;
  }
  obj[keys[keys.length - 1]] = value;
}

/** A field value that carries nothing to send: unset, blank, empty array, or empty object.
 *  Shared by request construction (omit it) and validation (treat as missing) so they agree. */
export function isEmptyFieldValue(v: unknown): boolean {
  if (v === undefined || v === null || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  return false;
}

export interface BuiltIntegrationRequest {
  method: IntegrationAction["method"];
  /** Path portion with `{placeholders}` filled + the query string appended (no base URL). */
  path: string;
  /** Assembled JSON body for write verbs (undefined when there are no body fields / for GETs). */
  body?: Record<string, unknown>;
}

/**
 * Build the concrete request (path + query + body) for an action from resolved field
 * values, using ONLY the catalog. Pure + total: this is exactly what the unit tests
 * assert and what the activity sends. Fields with `undefined`/`""` values are omitted
 * (a missing optional stays out of the payload). Throws on unknown provider/action.
 */
export function buildIntegrationRequest(
  provider: string,
  action: string,
  fields: Record<string, unknown>,
): BuiltIntegrationRequest {
  const act = getIntegrationAction(provider, action);
  if (!act) throw new Error(`Unknown integration ${provider}/${action}`);

  let path = act.pathTemplate;
  const queryParts: string[] = [];
  let body: Record<string, unknown> | undefined;

  for (const field of act.fields) {
    const value = fields[field.key];
    const missing = isEmptyFieldValue(value);
    if (field.in === "path") {
      // A required path field is validated at save time; at runtime substitute what we have.
      path = path.replace(
        `{${field.key}}`,
        encodeURIComponent(missing ? "" : String(value)),
      );
    } else if (field.in === "query") {
      if (!missing) {
        queryParts.push(
          `${encodeURIComponent(field.key)}=${encodeURIComponent(String(value))}`,
        );
      }
    } else {
      // Empty optional body fields are dropped — UNLESS keepEmpty (an empty string is meaningful,
      // e.g. Dropbox root path ""). A truly-absent value still coalesces to "" via the field default.
      if (missing && !field.keepEmpty) continue;
      body ??= {};
      setPath(body, field.bodyPath ?? field.key, value ?? "");
    }
  }

  const qs = queryParts.join("&");
  return { method: act.method, path: qs ? `${path}?${qs}` : path, body };
}

/**
 * Catalog-aware save-gate validation (design §6). Returns an error string or null.
 * Checks the provider/action exist, every required field is supplied (statically or via a
 * binding), and every path `{placeholder}` is a supplied path field. A correctable 400.
 */
export function validateIntegrationConfig(
  config: IntegrationNodeConfig,
): string | null {
  const provider = getIntegrationProvider(config.provider);
  if (!provider) return `unknown integration provider '${config.provider}'`;
  const action = getIntegrationAction(config.provider, config.action);
  if (!action) {
    return `unknown action '${config.action}' for provider '${config.provider}'`;
  }
  if (!config.connectionId) {
    return `integration '${config.provider}.${config.action}' needs a connectionId`;
  }
  // A field is "supplied" only by a binding (resolved at runtime) or a NON-EMPTY static value.
  // A present-but-empty static value ("" / null / [] ) counts as MISSING — otherwise it would
  // pass the gate but be dropped by buildIntegrationRequest (which omits empties), sending a
  // malformed path/body instead of failing fast here.
  const hasBinding = (key: string): boolean =>
    config.fieldBindings != null && key in config.fieldBindings;
  const hasStaticValue = (key: string): boolean =>
    config.fields != null &&
    key in config.fields &&
    !isEmptyFieldValue(config.fields[key]);
  const supplied = (key: string): boolean =>
    hasBinding(key) || hasStaticValue(key);

  for (const field of action.fields) {
    if (field.required && !supplied(field.key)) {
      return `integration '${config.provider}.${config.action}' is missing required field '${field.key}'`;
    }
  }
  // Every path placeholder must be a declared path field that is supplied.
  const placeholders = [...action.pathTemplate.matchAll(/\{([^}]+)\}/g)].map(
    (m) => m[1],
  );
  for (const ph of placeholders) {
    const field = action.fields.find((f) => f.key === ph && f.in === "path");
    if (!field) {
      return `integration '${config.provider}.${config.action}' path placeholder '{${ph}}' has no matching path field (catalog bug)`;
    }
    if (!supplied(ph)) {
      return `integration '${config.provider}.${config.action}' is missing path field '${ph}'`;
    }
  }
  return null;
}
