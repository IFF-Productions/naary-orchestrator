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
export type FieldType = "string" | "number" | "boolean" | "string[]";

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
//    descriptions. Auth = an Atlassian API token as a Bearer, or OAuth) ────────────────
const JIRA: IntegrationProvider = {
  key: "jira",
  label: "Jira",
  baseUrlFromConnection: true,
  description: "Manage Jira tickets — read, create, comment, and transition.",
  auth: "A Jira connection whose Server URL is your Atlassian site (https://you.atlassian.net) and whose token is an Atlassian API token (Bearer) or OAuth.",
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

export const INTEGRATION_CATALOG: Record<string, IntegrationProvider> = {
  github: GITHUB,
  jira: JIRA,
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
    const missing = value === undefined || value === null || value === "";
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
  const supplied = (key: string): boolean =>
    (config.fields != null && key in config.fields) ||
    (config.fieldBindings != null && key in config.fieldBindings);

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
