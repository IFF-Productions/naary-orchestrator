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

// ── Calendly (REST v2; static base api.calendly.com; auth = a personal access token as
//    Bearer, stored on a "custom" connection). Scheduled events are addressed by UUID. ──
const CALENDLY: IntegrationProvider = {
  key: "calendly",
  label: "Calendly",
  baseUrl: "https://api.calendly.com",
  description:
    "Read your Calendly account — who am I, list/get scheduled events, cancel an event.",
  auth: "A custom connection whose token is a Calendly personal access token.",
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

export const INTEGRATION_CATALOG: Record<string, IntegrationProvider> = {
  github: GITHUB,
  jira: JIRA,
  slack: SLACK,
  notion: NOTION,
  calendly: CALENDLY,
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
      if (missing) continue;
      body ??= {};
      setPath(body, field.bodyPath ?? field.key, value);
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
