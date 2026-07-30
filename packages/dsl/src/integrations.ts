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
 * Pure + dependency-free (no zod, no I/O), but NOT small: 38 providers with every action,
 * field and UI hint string is ~161KB. It must therefore stay OUT of the deterministic Temporal
 * workflow bundle (#910) — the config panel, the activity's request construction, the save gate
 * and the docs generator all load it happily; the interpreter must not. The two helpers the
 * interpreter genuinely needs live in ./integration-fields and ./integration-write, which are
 * catalog-free. Nothing in this file may be imported from `apps/worker/src/temporal/workflow/**`;
 * `apps/worker/test/workflow-bundle.spec.ts` fails the build if it is.
 */
import type { IntegrationNodeConfig } from "./types";
import { bindingNamesSource, hasForbiddenPathSegment } from "./mcp-args";
// `resolveIntegrationFields` + `isEmptyFieldValue` moved to a catalog-free module (#910) so the
// interpreter can reach them without loading this file. Re-exported here (and from the barrel via
// ./integration-fields) so every existing import site keeps working unchanged.
import { isEmptyFieldValue } from "./integration-fields";

export {
  resolveIntegrationFields,
  isEmptyFieldValue,
} from "./integration-fields";

/** `header` = a per-REQUEST header whose wire name IS the field key (mirroring how `query`
 *  uses the key as the param name) — for APIs that require a caller-supplied header on a
 *  write, e.g. PagerDuty's `From: user@company.com`. It NEVER carries auth: auth is resolved
 *  in-activity and is merged AFTER built headers, so a header field can't clobber it. */
export type FieldLocation = "path" | "query" | "body" | "header";
/** `json` = a raw JSON value (object/array) for schema-driven payloads that a flat field can't
 *  express, e.g. Notion's `properties` or an Airtable record's `fields`. */
export type FieldType = "string" | "number" | "boolean" | "string[]" | "json";

export interface IntegrationField {
  key: string;
  label: string;
  /** Where the value goes: a `{placeholder}` in the path, a query param, a request header,
   *  or the JSON body. */
  in: FieldLocation;
  required: boolean;
  type?: FieldType;
  /**
   * A FIXED value the catalog supplies — the user never sees or sets it, and any configured
   * value is ignored. For APIs whose payload carries constant type discriminators, e.g.
   * PagerDuty's `incident.type: "incident"` / `service.type: "service_reference"`. A const
   * field is always "supplied", so the save-gate never asks for it.
   */
  const?: string | number | boolean;
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
  /**
   * How the body is serialized. Default `"json"`, which is what every provider added before #707
   * assumed — so an existing entry without this field is unchanged.
   *
   * `"form"` sends `application/x-www-form-urlencoded`. Required, not cosmetic, for APIs that
   * accept ONLY that: Twilio and Stripe both reject a JSON body outright, so their write actions
   * failed 100% of the time until this existed (#707). The catalog previously had no way to say
   * this, which is why they shipped broken.
   *
   * A form body is FLAT by nature. `bodyPath` nesting can't be expressed, so the planner throws
   * rather than guessing — see formEncodeBody.
   */
  bodyEncoding?: "json" | "form";
  /** Per-action request headers (non-secret), merged OVER the provider's static headers —
   *  e.g. GitHub's `Accept: application/vnd.github.diff` to fetch a PR as a unified diff
   *  instead of JSON. Never carries auth (that's resolved in-activity). */
  headers?: Record<string, string>;
  /**
   * Declares this action as the provider's CREDENTIAL PROBE — the call "Test connection" and the
   * dry run make to ask "is this token alive?" (#835).
   *
   * It NARROWS the choice, never widens it: `pickConnectionTestAction` still applies the same hard
   * gate to a declared probe as to any other candidate (`write: false`, `GET`, no user-supplied
   * required field), so declaring `probe` on a write is inert, not dangerous. What it buys is
   *
   *   1. PINNING — without it the pick is "fewest fields, catalog order wins", so adding an
   *      unrelated zero-argument list action later would silently move the probe.
   *   2. AUTH-MODE VARIANTS — `authModes` restricts a probe to connections of that kind. GitHub is
   *      the reason this exists and it is not hypothetical: verified live, `GET /user` answers 200
   *      to a PAT and **403** to a GitHub App installation token, while `GET
   *      /installation/repositories` answers 200 to the App token and 403 to the PAT. One probe for
   *      both would report a perfectly good connection as broken — worse than not probing at all.
   *
   * A probe with `authModes` is preferred for a matching connection; `probe: true` is the fallback
   * for every other (and for a caller that doesn't know the auth mode, e.g. the UI asking "is this
   * provider testable at all?").
   */
  probe?: true | { authModes: string[] };
  /**
   * Field keys this action USED to take (#944). Purely for the save gate's error message.
   *
   * A field key is what a workflow author binds to, so renaming one breaks every saved node that
   * configured it — and the generic `missing required field 'dataSourceId'` is the worst possible
   * way to say so: it names a field the author has never seen and stays silent about the value
   * they did fill in. An entry here turns that into a sentence explaining what moved and what to
   * do, which is the whole reason a rename is allowed to happen at all.
   *
   * Reported only while the replacement is still unsupplied, so a node someone has already
   * migrated does not keep failing over a leftover key that the request builder ignores anyway.
   */
  retiredFields?: RetiredField[];
  /** One-line description for the config panel + docs. */
  description: string;
}

/** One renamed-or-removed field key, and the sentence the save gate hands the author. */
export interface RetiredField {
  /** The old key, exactly as it appears in an existing node's `fields`/`fieldBindings`. */
  key: string;
  /** The key that took over, when one did. */
  replacedBy?: string;
  /** What changed and what to do about it — reaches the user verbatim, so write it for them. */
  note: string;
}

export interface IntegrationProvider {
  key: string;
  label: string;
  /** Static API base, e.g. "https://api.github.com". */
  baseUrl?: string;
  /** When true, the base URL is the CONNECTION's serverUrl (e.g. an Atlassian site). */
  baseUrlFromConnection?: boolean;
  /**
   * How the connection token becomes the auth header (default "bearer").
   * - "bearer" — `Authorization: Bearer <token>` (GitHub etc.).
   * - "basic"  — HTTP Basic; the stored token is `email:api_token`, sent as
   *   `Basic base64(email:api_token)` (Jira Cloud + an Atlassian API token; Bearer is
   *   only for its OAuth access tokens).
   * - `{ header, prefix? }` — a CUSTOM header form (#655). The raw token is placed in
   *   `header` with an optional literal `prefix`, e.g. Shopify
   *   `{ header: "X-Shopify-Access-Token" }`, Discord `{ header: "Authorization", prefix: "Bot " }`,
   *   Monday/ClickUp `{ header: "Authorization" }` (no `Bearer ` prefix). Only applies to
   *   api_token/pat connections; an OAuth access token stays a normal Bearer.
   */
  authScheme?: "bearer" | "basic" | { header: string; prefix?: string };
  /** Provider-required static headers (non-secret), e.g. GitHub's Accept/version. */
  headers?: Record<string, string>;
  /** One-line description + setup note surfaced in the palette + docs. */
  description: string;
  /** How a user authenticates (shown in docs). */
  auth: string;
  /**
   * Why this provider has NO credential probe — shown verbatim instead of the generated
   * "no zero-argument read" reason when `pickConnectionTestAction` finds nothing (#835).
   *
   * For the handful where the generated sentence would be true but unhelpful, or actively
   * misleading: Slack HAS a zero-argument identity call (`auth.test`), but it answers **HTTP 200
   * with `{"ok":false}`** for a dead token, and the probe verdicts on the HTTP status — so probing
   * it would report every dead Slack token as working. Saying that is the honest answer; silently
   * reporting "no zero-argument read" is not.
   *
   * Only ever read on the `unknown` path. It cannot suppress a probe that the rule would otherwise
   * select — a provider that gains a safe read starts being probed and this string goes unused.
   */
  unprobeableReason?: string;
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
    // The two credential probes (#835). GitHub is the provider that forced `probe.authModes` to
    // exist: verified live against api.github.com, a PAT gets 200 from /user and 403 from
    // /installation/repositories, and a GitHub App installation token gets exactly the reverse.
    {
      key: "get_authenticated_user",
      label: "Get authenticated user",
      description:
        "Return the user this token belongs to. Needs no arguments, so it is the connection check for a PAT or OAuth token.",
      method: "GET",
      pathTemplate: "/user",
      write: false,
      probe: true,
      fields: [],
    },
    {
      key: "list_installation_repositories",
      label: "List installation repositories",
      description:
        "List the repositories a GitHub App installation can reach — the connection check for a GitHub App connection, which cannot call /user.",
      method: "GET",
      pathTemplate: "/installation/repositories",
      write: false,
      probe: { authModes: ["github_app"] },
      fields: [],
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

// ── Slack (Web API; static base slack.com/api; auth = a bot token `xoxb-…` as Bearer,
//    stored on a "custom" connection) ────────────────────────────────────────────────
const SLACK: IntegrationProvider = {
  key: "slack",
  label: "Slack",
  baseUrl: "https://slack.com/api",
  description: "Post to Slack — send a message, reply in a thread, or react.",
  auth: "A custom connection whose token is a Slack bot token (`xoxb-…`) with the needed scopes (e.g. chat:write, reactions:write). The Server URL is unused (base is slack.com).",
  unprobeableReason:
    "Slack can't be checked from here, and not because it lacks an endpoint: `auth.test` needs no " +
    'arguments, but the Slack Web API answers HTTP 200 with `{"ok": false}` for a dead token. ' +
    "The check reads the HTTP status, so probing it would call every expired Slack token healthy — " +
    "worse than saying nothing. Test a Slack connection with an integration node on a canvas " +
    "(single-node Test), which reads the response body.",
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
//
//    The version header is PROVIDER-WIDE and it is a real API contract, not a formality: Notion
//    only cuts a version for a backwards-INCOMPATIBLE change, so the pin decides which shapes the
//    catalog must send. We pin `2026-03-11`, the latest at the time of writing (#944) — its own
//    spec declares `Notion-Version` as `enum: ["2026-03-11"]` and its docs call it "the latest
//    version". Bumping it is never a header edit on its own; each action has to be re-read against
//    that version's document, which is what the pinned fixture + the drift spec now enforce.
//
//    What 2026-03-11 changes for us, action by action, per Notion's two upgrade guides:
//      · 2025-09-03 "Data Source Edition" — a database's ROWS moved behind a data source, and
//        `POST /databases/{id}/query` became `POST /data_sources/{id}/query`. That is a different
//        RESOURCE, not a renamed path, so `query_database`'s path field moved with it.
//      · 2026-03-11 — append-children took `position` in place of the flat `after`; `archived`
//        became `in_trash`; the `transcription` block type became `meeting_notes`. We send none of
//        those three keys, so no catalog field changes — but a hand-authored `children` blob that
//        still says `"type": "transcription"` is now the author's to fix.
const NOTION: IntegrationProvider = {
  key: "notion",
  label: "Notion",
  baseUrl: "https://api.notion.com/v1",
  headers: { "Notion-Version": "2026-03-11" },
  description:
    "Read and write Notion — get pages/databases, query a data source, create pages, append blocks.",
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
      key: "get_database",
      label: "Get database (and its data source ids)",
      description:
        "Fetch a database by id. Its `data_sources[]` is where a data source id comes from — bind `data_sources.0.id` into Query data source.",
      method: "GET",
      pathTemplate: "/databases/{databaseId}",
      write: false,
      fields: [
        {
          key: "databaseId",
          label: "Database id",
          in: "path",
          required: true,
          hint: "The UUID in the database's Notion URL, with or without dashes.",
        },
      ],
    },
    {
      // The action KEY stays `query_database` on purpose. Renaming it would give every saved node
      // `unknown action 'query_database'` — a worse error, on a code path that can say nothing
      // useful — while the label and description are what the canvas actually shows. The FIELD key
      // had to move, because a data source id is not a database id.
      key: "query_database",
      label: "Query data source",
      description:
        "Query a data source's pages (a database's rows), optionally with a filter/sort.",
      method: "POST",
      pathTemplate: "/data_sources/{dataSourceId}/query",
      write: false,
      retiredFields: [
        {
          key: "databaseId",
          replacedBy: "dataSourceId",
          note: "Notion's 2025-09-03 API moved a database's rows behind a DATA SOURCE, and one database can hold several — so the query takes a data source id, which a database id cannot be converted into locally. Add a 'Get database (and its data source ids)' node with the same database id and bind this field to its `body.data_sources.0.id`.",
        },
      ],
      fields: [
        {
          key: "dataSourceId",
          label: "Data source id",
          in: "path",
          required: true,
          hint: "NOT the database id — get it from `data_sources[].id` on a Get database node (a database can have several).",
        },
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
      description:
        "Create a page under a data source (a database row), a database, or a parent page.",
      method: "POST",
      pathTemplate: "/pages",
      write: true,
      fields: [
        {
          key: "parent",
          // Unchanged by the version bump, and that is a FINDING rather than an omission: #944
          // predicted this action had to move to `data_source_id` too, but 2026-03-11's own
          // `parent` schema still carries a `database_id` variant alongside the new
          // `data_source_id` one, so an existing config keeps working. Only the hint gains the
          // third form. Spec-declared, not live-verified — we hold no Notion token.
          label: "Parent (JSON)",
          in: "body",
          required: true,
          type: "json",
          hint: '{ "data_source_id": "…" }, { "database_id": "…" } or { "page_id": "…" }',
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
    {
      key: "get_me",
      label: "Get current bot user",
      description:
        "Return the bot user this integration token belongs to. Needs no arguments, so it is the connection check.",
      method: "GET",
      pathTemplate: "/users/me",
      write: false,
      probe: true,
      fields: [],
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

const HUBSPOT: IntegrationProvider = {
  key: "hubspot",
  label: "HubSpot",
  baseUrl: "https://api.hubapi.com",
  description:
    "Act on HubSpot CRM — get, create, and update contacts; create deals.",
  auth: "A custom connection whose token is a HubSpot private-app access token.",
  unprobeableReason:
    "HubSpot has no identity endpoint a private-app token can call without a scope. The obvious " +
    "candidate — listing contacts — is gated on `crm.objects.contacts.read`, so a token scoped for " +
    "deals only would answer 403 and this check would report a perfectly good connection as a dead " +
    "credential. Test a HubSpot connection with an integration node on a canvas (single-node Test).",
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
        // SendGrid REQUIRES page_size on this endpoint (1–200) — without it the call is a 400,
        // every time, which is what the catalog shipped (#813). Supplied as a `const` rather than
        // asked of the author for two reasons: nothing else about "list my templates" needs an
        // argument, and this is the action `pickConnectionTestAction` uses to prove a SendGrid
        // token — a required field the user must fill would take SendGrid out of one-click
        // "Test connection" (VERIFICATION.md §2.4) to model an API quirk. 200 is the maximum the
        // spec allows, so one call returns as much as the endpoint can give.
        {
          key: "page_size",
          label: "Page size",
          in: "query",
          required: true,
          type: "number",
          const: 200,
          hint: "fixed at SendGrid's maximum — the API rejects the call without it",
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
    {
      key: "whoami",
      label: "Who am I",
      description:
        "Return the user id this token belongs to. Needs no arguments, so it is the connection check.",
      method: "GET",
      pathTemplate: "/meta/whoami",
      write: false,
      probe: true,
      fields: [],
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
    {
      key: "get_me",
      label: "Get current user",
      description:
        "Return the user this token belongs to. Needs no arguments, so it is the connection check.",
      method: "GET",
      pathTemplate: "/users/me",
      write: false,
      probe: true,
      fields: [],
    },
  ],
};

const TODOIST: IntegrationProvider = {
  key: "todoist",
  label: "Todoist",
  // Was `https://api.todoist.com/rest/v2`, which Todoist has REMOVED — not deprecated. Measured
  // 2026-07-29: `GET /rest/v2/tasks` → **410 Gone** (with or without a token), `GET /api/v1/tasks`
  // → 401. A 410 is the server saying the resource is permanently gone, so every Todoist action in
  // this catalog failed for every user, and no credential could have made it work. The unified v1
  // API takes the same task paths and the same create-task body keys, so this is a base-URL move;
  // the one casualty is `list_tasks`' `filter`, which v1 serves from a separate endpoint.
  baseUrl: "https://api.todoist.com/api/v1",
  description: "Manage Todoist tasks — list, get, create, and close.",
  auth: "A custom connection whose token is a Todoist API token.",
  actions: [
    {
      key: "list_tasks",
      label: "List tasks",
      description: "List active tasks, optionally filtered by project.",
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
        // `filter` is GONE with `/rest/v2`: v1 declares only project_id/section_id/parent_id/label/
        // ids/cursor/limit here and serves filter queries from `GET /api/v1/tasks/filter?query=…`,
        // a different operation. Kept out rather than left in place as a parameter the API ignores.
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
    {
      key: "get_me",
      label: "Get current admin",
      description:
        "Return the admin this access token belongs to. Needs no arguments, so it is the connection check.",
      method: "GET",
      pathTemplate: "/me",
      write: false,
      probe: true,
      fields: [],
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
    {
      key: "get_authorized_by",
      label: "Get token owner",
      description:
        "Return the user this token was authorized by. Needs no arguments and no site scope, so it is the connection check.",
      method: "GET",
      pathTemplate: "/token/authorized_by",
      write: false,
      probe: true,
      fields: [],
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
    {
      key: "get_me",
      label: "Get current user",
      description:
        "Return the user this token belongs to. Needs no arguments, so it is the connection check.",
      method: "GET",
      pathTemplate: "/users/me",
      write: false,
      probe: true,
      fields: [],
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
    {
      key: "list_organizations",
      label: "List organizations",
      description:
        "List the organizations this token can see. Needs no arguments, so it is the connection check.",
      method: "GET",
      pathTemplate: "/organizations/",
      write: false,
      probe: true,
      fields: [],
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
    {
      key: "get_me",
      label: "Get current user",
      description:
        "Return the user this personal API key belongs to. Needs no arguments, so it is the connection check.",
      method: "GET",
      pathTemplate: "/api/users/@me/",
      write: false,
      probe: true,
      fields: [],
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
  unprobeableReason:
    "Dropbox has an argument-free identity call (`/users/get_current_account`) but it is an RPC " +
    "POST, and the credential check only ever issues a GET — a POST probe is one catalog slip away " +
    "from being a write. Test a Dropbox connection with an integration node on a canvas " +
    "(single-node Test).",
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
  unprobeableReason:
    "Microsoft Graph's `/me` answers only for a DELEGATED token; an application (client-credentials) " +
    "token — which is what the `/users/{id}/…` actions here are built for — is rejected by it in a " +
    "way indistinguishable from a bad credential. Reporting that as a dead token would be a lie, so " +
    "Graph is left unchecked: test it with an integration node on a canvas (single-node Test).",
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
    {
      key: "get_me",
      label: "Get current user",
      description:
        "Return the user this token belongs to. Needs no arguments, so it is the connection check.",
      method: "GET",
      pathTemplate: "/users/me",
      write: false,
      probe: true,
      fields: [],
    },
  ],
};

const STRIPE: IntegrationProvider = {
  key: "stripe",
  label: "Stripe",
  baseUrl: "https://api.stripe.com/v1",
  authScheme: "bearer",
  description:
    "Act on Stripe — create/get customers, create payment intents, list charges, refund.",
  auth: "A custom connection whose token is a Stripe secret key (`sk_live_…` / `sk_test_…`), sent as a Bearer token.",
  actions: [
    {
      key: "create_customer",
      label: "Create customer",
      description: "Create a new customer.",
      method: "POST",
      pathTemplate: "/customers",
      // Rejects JSON outright — form-encoded only (#707).
      bodyEncoding: "form",
      write: true,
      fields: [
        { key: "email", label: "Email", in: "body", required: false },
        { key: "name", label: "Name", in: "body", required: false },
        {
          key: "description",
          label: "Description",
          in: "body",
          required: false,
        },
      ],
    },
    {
      key: "get_customer",
      label: "Get customer",
      description: "Fetch a single customer by id.",
      method: "GET",
      pathTemplate: "/customers/{customerId}",
      write: false,
      fields: [
        {
          key: "customerId",
          label: "Customer id",
          in: "path",
          required: true,
          hint: "e.g. cus_XXXXXXXXXXXXXX",
        },
      ],
    },
    {
      key: "create_payment_intent",
      label: "Create payment intent",
      description: "Create a payment intent to collect a payment.",
      method: "POST",
      pathTemplate: "/payment_intents",
      // Rejects JSON outright — form-encoded only (#707).
      bodyEncoding: "form",
      write: true,
      fields: [
        {
          key: "amount",
          label: "Amount",
          in: "body",
          required: true,
          type: "number",
          hint: "in the smallest currency unit, e.g. 1999 = $19.99",
        },
        {
          key: "currency",
          label: "Currency",
          in: "body",
          required: true,
          hint: "ISO code, e.g. usd",
        },
        {
          key: "customer",
          label: "Customer",
          in: "body",
          required: false,
          hint: "customer id, e.g. cus_…",
        },
        {
          key: "description",
          label: "Description",
          in: "body",
          required: false,
        },
      ],
    },
    {
      key: "list_charges",
      label: "List charges",
      description: "List charges, optionally filtered by customer.",
      method: "GET",
      pathTemplate: "/charges",
      write: false,
      fields: [
        {
          key: "customer",
          label: "Customer",
          in: "query",
          required: false,
          hint: "filter by customer id",
        },
        {
          key: "limit",
          label: "Limit",
          in: "query",
          required: false,
          type: "number",
          hint: "1–100 (default 10)",
        },
      ],
    },
    {
      key: "create_refund",
      label: "Create refund",
      description: "Refund a charge, fully or partially.",
      method: "POST",
      pathTemplate: "/refunds",
      // Rejects JSON outright — form-encoded only (#707).
      bodyEncoding: "form",
      write: true,
      fields: [
        {
          key: "charge",
          label: "Charge",
          in: "body",
          required: true,
          hint: "charge id, e.g. ch_…",
        },
        {
          key: "amount",
          label: "Amount",
          in: "body",
          required: false,
          type: "number",
          hint: "in the smallest currency unit; omit for a full refund",
        },
      ],
    },
  ],
};

const SHOPIFY: IntegrationProvider = {
  key: "shopify",
  label: "Shopify",
  baseUrlFromConnection: true,
  authScheme: { header: "X-Shopify-Access-Token" },
  description:
    "Manage a Shopify store's Admin API — read/create/update products and create orders.",
  auth: "A custom connection whose Server URL is your store's Admin API base (https://{shop}.myshopify.com/admin/api/2024-01) and whose token is a Shopify Admin API access token — sent as the `X-Shopify-Access-Token` header (#655).",
  actions: [
    {
      key: "get_product",
      label: "Get product",
      description: "Fetch a single product by id.",
      method: "GET",
      pathTemplate: "/products/{productId}.json",
      write: false,
      fields: [
        { key: "productId", label: "Product id", in: "path", required: true },
      ],
    },
    {
      key: "list_products",
      label: "List products",
      description: "List products, optionally filtered by vendor or limited.",
      method: "GET",
      pathTemplate: "/products.json",
      write: false,
      fields: [
        {
          key: "limit",
          label: "Limit",
          in: "query",
          required: false,
          type: "number",
          hint: "max products to return (default 50, max 250)",
        },
        { key: "vendor", label: "Vendor", in: "query", required: false },
      ],
    },
    {
      key: "create_product",
      label: "Create product",
      description: "Create a new product (wrapped in the product envelope).",
      method: "POST",
      pathTemplate: "/products.json",
      write: true,
      fields: [
        {
          key: "title",
          label: "Title",
          in: "body",
          required: true,
          bodyPath: "product.title",
        },
        {
          key: "bodyHtml",
          label: "Description (HTML)",
          in: "body",
          required: false,
          bodyPath: "product.body_html",
        },
        {
          key: "vendor",
          label: "Vendor",
          in: "body",
          required: false,
          bodyPath: "product.vendor",
        },
        {
          key: "productType",
          label: "Product type",
          in: "body",
          required: false,
          bodyPath: "product.product_type",
        },
      ],
    },
    {
      key: "update_product",
      label: "Update product",
      description: "Update an existing product by id (product envelope).",
      method: "PUT",
      pathTemplate: "/products/{productId}.json",
      write: true,
      fields: [
        { key: "productId", label: "Product id", in: "path", required: true },
        {
          key: "title",
          label: "Title",
          in: "body",
          required: false,
          bodyPath: "product.title",
        },
        {
          key: "bodyHtml",
          label: "Description (HTML)",
          in: "body",
          required: false,
          bodyPath: "product.body_html",
        },
        {
          key: "vendor",
          label: "Vendor",
          in: "body",
          required: false,
          bodyPath: "product.vendor",
        },
        {
          key: "productType",
          label: "Product type",
          in: "body",
          required: false,
          bodyPath: "product.product_type",
        },
      ],
    },
    {
      key: "create_order",
      label: "Create order",
      description: "Create a new order (wrapped in the order envelope).",
      method: "POST",
      pathTemplate: "/orders.json",
      write: true,
      fields: [
        {
          key: "lineItems",
          label: "Line items (JSON)",
          in: "body",
          required: true,
          type: "json",
          bodyPath: "order.line_items",
          hint: "array of { variant_id, quantity } or { title, price, quantity }",
        },
        {
          key: "email",
          label: "Customer email",
          in: "body",
          required: false,
          bodyPath: "order.email",
        },
        {
          key: "financialStatus",
          label: "Financial status",
          in: "body",
          required: false,
          bodyPath: "order.financial_status",
          hint: "e.g. paid | pending",
        },
      ],
    },
  ],
};

const TWILIO: IntegrationProvider = {
  key: "twilio",
  label: "Twilio",
  baseUrl: "https://api.twilio.com/2010-04-01",
  authScheme: "basic",
  description:
    "Send SMS and place calls with Twilio — send/read messages, list messages, make a call.",
  auth: "A custom connection whose token is `AccountSid:AuthToken` (sent as HTTP Basic). Set the same Account SID as the node's `accountSid` field — the request builder needs it explicitly for the {accountSid} path segment (it is not derived from the connection token).",
  actions: [
    {
      key: "send_sms",
      label: "Send SMS",
      description: "Send an SMS message.",
      method: "POST",
      pathTemplate: "/Accounts/{accountSid}/Messages.json",
      // Rejects JSON outright — form-encoded only (#707).
      bodyEncoding: "form",
      write: true,
      fields: [
        {
          key: "accountSid",
          label: "Account SID",
          in: "path",
          required: true,
          hint: "e.g. ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        },
        {
          key: "To",
          label: "To",
          in: "body",
          required: true,
          hint: "destination number in E.164, e.g. +15558675310",
        },
        {
          key: "From",
          label: "From",
          in: "body",
          required: true,
          hint: "your Twilio number in E.164",
        },
        { key: "Body", label: "Body", in: "body", required: true },
      ],
    },
    {
      key: "get_message",
      label: "Get message",
      description: "Fetch a single message by its SID.",
      method: "GET",
      pathTemplate: "/Accounts/{accountSid}/Messages/{messageSid}.json",
      write: false,
      fields: [
        {
          key: "accountSid",
          label: "Account SID",
          in: "path",
          required: true,
        },
        {
          key: "messageSid",
          label: "Message SID",
          in: "path",
          required: true,
          hint: "e.g. SMxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        },
      ],
    },
    {
      key: "list_messages",
      label: "List messages",
      description: "List messages, optionally filtered by To/From.",
      method: "GET",
      pathTemplate: "/Accounts/{accountSid}/Messages.json",
      write: false,
      fields: [
        {
          key: "accountSid",
          label: "Account SID",
          in: "path",
          required: true,
        },
        { key: "To", label: "To", in: "query", required: false },
        { key: "From", label: "From", in: "query", required: false },
        {
          key: "PageSize",
          label: "Page size",
          in: "query",
          required: false,
          type: "number",
        },
      ],
    },
    {
      key: "make_call",
      label: "Make call",
      description: "Place an outbound phone call.",
      method: "POST",
      pathTemplate: "/Accounts/{accountSid}/Calls.json",
      // Rejects JSON outright — form-encoded only (#707).
      bodyEncoding: "form",
      write: true,
      fields: [
        {
          key: "accountSid",
          label: "Account SID",
          in: "path",
          required: true,
        },
        {
          key: "To",
          label: "To",
          in: "body",
          required: true,
          hint: "destination number in E.164",
        },
        {
          key: "From",
          label: "From",
          in: "body",
          required: true,
          hint: "your Twilio number in E.164",
        },
        {
          key: "Url",
          label: "TwiML URL",
          in: "body",
          required: true,
          hint: "URL returning TwiML that controls the call",
        },
      ],
    },
    {
      key: "list_accounts",
      label: "List accounts",
      description:
        "List the accounts these credentials can see. Needs no arguments (not even the Account SID), so it is the connection check.",
      method: "GET",
      pathTemplate: "/Accounts.json",
      write: false,
      probe: true,
      fields: [],
    },
  ],
};

const MAILCHIMP: IntegrationProvider = {
  key: "mailchimp",
  label: "Mailchimp",
  baseUrlFromConnection: true,
  authScheme: "bearer",
  description:
    "Manage Mailchimp audiences — add/get/update list members, list members, create a campaign.",
  auth: "A custom connection whose Server URL is https://{dc}.api.mailchimp.com/3.0 (dc = the datacenter suffix of your API key, e.g. us19) and whose token is your Mailchimp API key (sent as a Bearer token).",
  actions: [
    {
      key: "add_member",
      label: "Add member",
      description: "Add a member to a list (audience).",
      method: "POST",
      pathTemplate: "/lists/{listId}/members",
      write: true,
      fields: [
        {
          key: "listId",
          label: "List id",
          in: "path",
          required: true,
          hint: "the audience/list id",
        },
        {
          key: "email_address",
          label: "Email address",
          in: "body",
          required: true,
        },
        {
          key: "status",
          label: "Status",
          in: "body",
          required: true,
          hint: "subscribed | pending | unsubscribed | cleaned",
        },
        {
          key: "merge_fields",
          label: "Merge fields (JSON)",
          in: "body",
          required: false,
          type: "json",
          hint: "merge tag values, e.g. { FNAME, LNAME }",
        },
      ],
    },
    {
      key: "get_member",
      label: "Get member",
      description: "Fetch a single list member by subscriber hash.",
      method: "GET",
      pathTemplate: "/lists/{listId}/members/{subscriberHash}",
      write: false,
      fields: [
        { key: "listId", label: "List id", in: "path", required: true },
        {
          key: "subscriberHash",
          label: "Subscriber hash",
          in: "path",
          required: true,
          hint: "MD5 hash of the lowercase email address",
        },
      ],
    },
    {
      key: "update_member",
      label: "Update member",
      description: "Update a list member's status or merge fields.",
      method: "PATCH",
      pathTemplate: "/lists/{listId}/members/{subscriberHash}",
      write: true,
      fields: [
        { key: "listId", label: "List id", in: "path", required: true },
        {
          key: "subscriberHash",
          label: "Subscriber hash",
          in: "path",
          required: true,
        },
        {
          key: "status",
          label: "Status",
          in: "body",
          required: false,
          hint: "subscribed | pending | unsubscribed | cleaned",
        },
        {
          key: "merge_fields",
          label: "Merge fields (JSON)",
          in: "body",
          required: false,
          type: "json",
        },
      ],
    },
    {
      key: "list_members",
      label: "List members",
      description: "List members of a list, optionally filtered by status.",
      method: "GET",
      pathTemplate: "/lists/{listId}/members",
      write: false,
      fields: [
        { key: "listId", label: "List id", in: "path", required: true },
        {
          key: "status",
          label: "Status",
          in: "query",
          required: false,
          hint: "subscribed | pending | unsubscribed | cleaned",
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
      key: "create_campaign",
      label: "Create campaign",
      description: "Create a new campaign.",
      method: "POST",
      pathTemplate: "/campaigns",
      write: true,
      fields: [
        {
          key: "type",
          label: "Type",
          in: "body",
          required: true,
          hint: "regular | plaintext | rss | variate",
        },
        {
          key: "recipients",
          label: "Recipients (JSON)",
          in: "body",
          required: false,
          type: "json",
          hint: '{ "list_id": "…" }',
        },
        {
          key: "settings",
          label: "Settings (JSON)",
          in: "body",
          required: false,
          type: "json",
          hint: "{ subject_line, from_name, reply_to, … }",
        },
      ],
    },
    {
      key: "ping",
      label: "Ping (health check)",
      description:
        "Mailchimp's own API health check. Needs no arguments, so it is the connection check — and it also proves the data-centre Server URL is the right one.",
      method: "GET",
      pathTemplate: "/ping",
      write: false,
      probe: true,
      fields: [],
    },
  ],
};

const DISCORD: IntegrationProvider = {
  key: "discord",
  label: "Discord",
  baseUrl: "https://discord.com/api/v10",
  authScheme: { header: "Authorization", prefix: "Bot " },
  description:
    "Act on Discord — send channel messages, read channels/messages, open DMs, and react.",
  auth: "A custom connection whose token is a Discord bot token — sent as `Authorization: Bot <token>` (#655).",
  actions: [
    {
      key: "send_message",
      label: "Send message",
      description: "Send a message to a channel.",
      method: "POST",
      pathTemplate: "/channels/{channelId}/messages",
      write: true,
      fields: [
        {
          key: "channelId",
          label: "Channel id",
          in: "path",
          required: true,
        },
        { key: "content", label: "Content", in: "body", required: true },
        {
          key: "tts",
          label: "Text-to-speech",
          in: "body",
          required: false,
          type: "boolean",
        },
        {
          key: "embeds",
          label: "Embeds (JSON)",
          in: "body",
          required: false,
          type: "json",
          hint: "array of Discord embed objects",
        },
      ],
    },
    {
      key: "get_channel",
      label: "Get channel",
      description: "Fetch a channel by id.",
      method: "GET",
      pathTemplate: "/channels/{channelId}",
      write: false,
      fields: [
        { key: "channelId", label: "Channel id", in: "path", required: true },
      ],
    },
    {
      key: "list_messages",
      label: "List messages",
      description: "List messages in a channel, with optional paging.",
      method: "GET",
      pathTemplate: "/channels/{channelId}/messages",
      write: false,
      fields: [
        { key: "channelId", label: "Channel id", in: "path", required: true },
        {
          key: "limit",
          label: "Limit",
          in: "query",
          required: false,
          type: "number",
          hint: "1–100 (default 50)",
        },
        {
          key: "before",
          label: "Before",
          in: "query",
          required: false,
          hint: "message id — get messages before this id",
        },
        {
          key: "after",
          label: "After",
          in: "query",
          required: false,
          hint: "message id — get messages after this id",
        },
      ],
    },
    {
      key: "create_dm",
      label: "Create DM",
      description: "Open (or fetch) a DM channel with a user.",
      method: "POST",
      pathTemplate: "/users/@me/channels",
      write: true,
      fields: [
        {
          key: "recipient_id",
          label: "Recipient id",
          in: "body",
          required: true,
          hint: "the user id to DM",
        },
      ],
    },
    {
      key: "add_reaction",
      label: "Add reaction",
      description: "React to a message with an emoji (as the bot).",
      method: "PUT",
      pathTemplate:
        "/channels/{channelId}/messages/{messageId}/reactions/{emoji}/@me",
      // A mutation: it adds a visible reaction to someone's message. Was mismarked `write: false`,
      // which (a) made the interpreter RETRY it — Discord's PUT is idempotent so no duplicate
      // reaction, but a failed call read as a branchable result instead of failing the node — and
      // (b) put it in the pool "Test connection" (#701) selects a safe read from, where the only
      // thing keeping it out was its required fields. Slack's identical `add_reaction` is `true`.
      write: true,
      fields: [
        { key: "channelId", label: "Channel id", in: "path", required: true },
        { key: "messageId", label: "Message id", in: "path", required: true },
        {
          key: "emoji",
          label: "Emoji",
          in: "path",
          required: true,
          hint: "a unicode emoji (e.g. 👍) or `name:id` for a custom emoji — it's URL-encoded automatically",
        },
      ],
    },
    {
      key: "get_me",
      label: "Get current bot user",
      description:
        "Return the bot user this token belongs to. Needs no arguments, so it is the connection check.",
      method: "GET",
      pathTemplate: "/users/@me",
      write: false,
      probe: true,
      fields: [],
    },
  ],
};

const LINEAR: IntegrationProvider = {
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

const CLICKUP: IntegrationProvider = {
  key: "clickup",
  label: "ClickUp",
  baseUrl: "https://api.clickup.com/api/v2",
  authScheme: { header: "Authorization" },
  description:
    "Manage ClickUp tasks — create, read, update, list, and comment.",
  auth: "A custom connection whose token is a ClickUp personal API token (`pk_…`), sent as a bare `Authorization` header — no `Bearer ` prefix (#655).",
  actions: [
    {
      key: "create_task",
      label: "Create task",
      description: "Create a new task in a list.",
      method: "POST",
      pathTemplate: "/list/{listId}/task",
      write: true,
      fields: [
        { key: "listId", label: "List id", in: "path", required: true },
        { key: "name", label: "Name", in: "body", required: true },
        {
          key: "description",
          label: "Description",
          in: "body",
          required: false,
        },
        {
          key: "assignees",
          label: "Assignees",
          in: "body",
          required: false,
          type: "string[]",
          hint: "array of assignee user ids",
        },
        {
          key: "priority",
          label: "Priority",
          in: "body",
          required: false,
          type: "number",
          hint: "1 urgent, 2 high, 3 normal, 4 low",
        },
        {
          key: "due_date",
          label: "Due date",
          in: "body",
          required: false,
          type: "number",
          hint: "Unix time in milliseconds",
        },
      ],
    },
    {
      key: "get_task",
      label: "Get task",
      description: "Fetch a single task by id.",
      method: "GET",
      pathTemplate: "/task/{taskId}",
      write: false,
      fields: [{ key: "taskId", label: "Task id", in: "path", required: true }],
    },
    {
      key: "update_task",
      label: "Update task",
      description:
        "Update a task's fields (e.g. rename, set status or priority).",
      method: "PUT",
      pathTemplate: "/task/{taskId}",
      write: true,
      fields: [
        { key: "taskId", label: "Task id", in: "path", required: true },
        { key: "name", label: "Name", in: "body", required: false },
        { key: "status", label: "Status", in: "body", required: false },
        {
          key: "priority",
          label: "Priority",
          in: "body",
          required: false,
          type: "number",
          hint: "1 urgent, 2 high, 3 normal, 4 low",
        },
      ],
    },
    {
      key: "list_tasks",
      label: "List tasks",
      description: "List tasks in a list, with optional paging.",
      method: "GET",
      pathTemplate: "/list/{listId}/task",
      write: false,
      fields: [
        { key: "listId", label: "List id", in: "path", required: true },
        {
          key: "archived",
          label: "Archived",
          in: "query",
          required: false,
          hint: "true|false",
        },
        {
          key: "page",
          label: "Page",
          in: "query",
          required: false,
          type: "number",
          hint: "0-based page number",
        },
      ],
    },
    {
      key: "create_comment",
      label: "Create comment",
      description: "Add a comment to a task.",
      method: "POST",
      pathTemplate: "/task/{taskId}/comment",
      write: true,
      fields: [
        { key: "taskId", label: "Task id", in: "path", required: true },
        {
          key: "comment_text",
          label: "Comment",
          in: "body",
          required: true,
        },
        {
          // ClickUp's own OpenAPI puts `notify_all` in `required` for this operation, and we were
          // not sending it (#813 follow-up). Supplied as a `const` rather than a field, because
          // the flag only decides whether the comment's OWN AUTHOR is also notified — ClickUp's
          // description: "Other assignees and watchers on the task are always notified regardless
          // of this setting." `false` is therefore both the no-op value and the sane default for
          // an automated comment, so this cannot change behaviour where ClickUp treats the key as
          // optional, and fixes the call where it does not.
          key: "notify_all",
          label: "Notify all",
          in: "body",
          required: false,
          type: "boolean",
          const: false,
        },
      ],
    },
    {
      key: "get_me",
      label: "Get authorized user",
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

const MONDAY: IntegrationProvider = {
  key: "monday",
  label: "Monday.com",
  baseUrl: "https://api.monday.com",
  authScheme: { header: "Authorization" },
  description:
    "Act on Monday.com boards via GraphQL — create/read items, post updates, change columns.",
  auth: "A custom connection whose token is a Monday.com API token (Developers → My access tokens), sent in a bare `Authorization` header — no `Bearer ` prefix (#655).",
  unprobeableReason:
    "Monday.com is GraphQL: `query { me { id } }` would prove the token, but every call is a POST " +
    "carrying a query, and the credential check only ever issues an argument-free GET. Test a " +
    "Monday.com connection with an integration node on a canvas (single-node Test).",
  actions: [
    {
      key: "create_item",
      label: "Create item",
      description:
        "Create an item on a board (GraphQL mutation). variables: { boardId, itemName, columnValues }.",
      method: "POST",
      pathTemplate: "/v2",
      write: true,
      fields: [
        {
          key: "query",
          label: "GraphQL query",
          in: "body",
          required: true,
          type: "string",
          hint: "e.g. mutation ($boardId: ID!, $itemName: String!, $columnValues: JSON) { create_item(board_id: $boardId, item_name: $itemName, column_values: $columnValues) { id } }",
        },
        {
          key: "variables",
          label: "Variables (JSON)",
          in: "body",
          required: true,
          type: "json",
          hint: "{ boardId, itemName, columnValues }",
        },
      ],
    },
    {
      key: "get_item",
      label: "Get item",
      description:
        "Fetch an item (and its column values) by id (GraphQL query). variables: { itemId }.",
      method: "POST",
      pathTemplate: "/v2",
      write: false,
      fields: [
        {
          key: "query",
          label: "GraphQL query",
          in: "body",
          required: true,
          type: "string",
          hint: "e.g. query ($itemId: [ID!]) { items(ids: $itemId) { id name column_values { id text } } }",
        },
        {
          key: "variables",
          label: "Variables (JSON)",
          in: "body",
          required: true,
          type: "json",
          hint: "{ itemId }",
        },
      ],
    },
    {
      key: "list_items",
      label: "List items",
      description:
        "List the items on a board (GraphQL query). variables: { boardId }.",
      method: "POST",
      pathTemplate: "/v2",
      write: false,
      fields: [
        {
          key: "query",
          label: "GraphQL query",
          in: "body",
          required: true,
          type: "string",
          hint: "e.g. query ($boardId: [ID!]) { boards(ids: $boardId) { items_page { items { id name } } } }",
        },
        {
          key: "variables",
          label: "Variables (JSON)",
          in: "body",
          required: false,
          type: "json",
          hint: "{ boardId }",
        },
      ],
    },
    {
      key: "create_update",
      label: "Create update",
      description:
        "Post an update (comment) on an item (GraphQL mutation). variables: { itemId, body }.",
      method: "POST",
      pathTemplate: "/v2",
      write: true,
      fields: [
        {
          key: "query",
          label: "GraphQL query",
          in: "body",
          required: true,
          type: "string",
          hint: "e.g. mutation ($itemId: ID!, $body: String!) { create_update(item_id: $itemId, body: $body) { id } }",
        },
        {
          key: "variables",
          label: "Variables (JSON)",
          in: "body",
          required: true,
          type: "json",
          hint: "{ itemId, body }",
        },
      ],
    },
    {
      key: "change_column_value",
      label: "Change column value",
      description:
        "Change a column's value on an item (GraphQL mutation). variables: { boardId, itemId, columnId, value }.",
      method: "POST",
      pathTemplate: "/v2",
      write: true,
      fields: [
        {
          key: "query",
          label: "GraphQL query",
          in: "body",
          required: true,
          type: "string",
          hint: "e.g. mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: JSON!) { change_column_value(board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) { id } }",
        },
        {
          key: "variables",
          label: "Variables (JSON)",
          in: "body",
          required: true,
          type: "json",
          hint: "{ boardId, itemId, columnId, value }",
        },
      ],
    },
  ],
};

const PIPEDRIVE: IntegrationProvider = {
  key: "pipedrive",
  label: "Pipedrive",
  baseUrl: "https://api.pipedrive.com/v1",
  authScheme: "bearer",
  description:
    "Act on Pipedrive CRM — create/get/update deals, create persons, list deals.",
  auth: "A custom connection whose token is a Pipedrive API token, sent as a Bearer token.",
  actions: [
    {
      key: "create_deal",
      label: "Create deal",
      description: "Create a new deal.",
      method: "POST",
      pathTemplate: "/deals",
      write: true,
      fields: [
        { key: "title", label: "Title", in: "body", required: true },
        {
          key: "value",
          label: "Value",
          in: "body",
          required: false,
          type: "number",
        },
        { key: "currency", label: "Currency", in: "body", required: false },
        {
          key: "person_id",
          label: "Person id",
          in: "body",
          required: false,
          type: "number",
        },
        {
          key: "org_id",
          label: "Organization id",
          in: "body",
          required: false,
          type: "number",
        },
      ],
    },
    {
      key: "get_deal",
      label: "Get deal",
      description: "Fetch a single deal by id.",
      method: "GET",
      pathTemplate: "/deals/{dealId}",
      write: false,
      fields: [{ key: "dealId", label: "Deal id", in: "path", required: true }],
    },
    {
      key: "update_deal",
      label: "Update deal",
      description: "Update an existing deal by id.",
      method: "PUT",
      pathTemplate: "/deals/{dealId}",
      write: true,
      fields: [
        { key: "dealId", label: "Deal id", in: "path", required: true },
        { key: "title", label: "Title", in: "body", required: false },
        {
          key: "value",
          label: "Value",
          in: "body",
          required: false,
          type: "number",
        },
        {
          key: "status",
          label: "Status",
          in: "body",
          required: false,
          hint: "open|won|lost|deleted",
        },
      ],
    },
    {
      key: "create_person",
      label: "Create person",
      description: "Create a new person (contact).",
      method: "POST",
      pathTemplate: "/persons",
      write: true,
      fields: [
        { key: "name", label: "Name", in: "body", required: true },
        {
          key: "email",
          label: "Email",
          in: "body",
          required: false,
          type: "string[]",
          hint: "array of email addresses",
        },
        { key: "phone", label: "Phone", in: "body", required: false },
      ],
    },
    {
      key: "list_deals",
      label: "List deals",
      description: "List deals, optionally filtered by status.",
      method: "GET",
      pathTemplate: "/deals",
      write: false,
      fields: [
        {
          key: "status",
          label: "Status",
          in: "query",
          required: false,
          hint: "open|won|lost|deleted|all_not_deleted",
        },
        {
          key: "limit",
          label: "Limit",
          in: "query",
          required: false,
          type: "number",
        },
        {
          key: "start",
          label: "Start",
          in: "query",
          required: false,
          type: "number",
        },
      ],
    },
  ],
};

const ZENDESK: IntegrationProvider = {
  key: "zendesk",
  label: "Zendesk",
  baseUrlFromConnection: true,
  authScheme: "basic",
  description:
    "Manage Zendesk Support — read, create, and update tickets; create users.",
  auth: "A Zendesk connection whose Server URL is your account API base (https://your-subdomain.zendesk.com/api/v2) and whose token is `your-email@company.com/token:your-api-token` (sent as HTTP Basic).",
  actions: [
    {
      key: "get_ticket",
      label: "Get ticket",
      description: "Fetch a single ticket by id.",
      method: "GET",
      pathTemplate: "/tickets/{ticketId}.json",
      write: false,
      fields: [
        {
          key: "ticketId",
          label: "Ticket id",
          in: "path",
          required: true,
          type: "number",
        },
      ],
    },
    {
      key: "list_tickets",
      label: "List tickets",
      description: "List tickets, with optional paging.",
      method: "GET",
      pathTemplate: "/tickets.json",
      write: false,
      fields: [
        {
          key: "page",
          label: "Page",
          in: "query",
          required: false,
          type: "number",
        },
        {
          key: "per_page",
          label: "Per page",
          in: "query",
          required: false,
          type: "number",
        },
      ],
    },
    {
      key: "create_ticket",
      label: "Create ticket",
      description: "Open a new ticket.",
      method: "POST",
      pathTemplate: "/tickets.json",
      write: true,
      fields: [
        {
          key: "subject",
          label: "Subject",
          in: "body",
          required: true,
          bodyPath: "ticket.subject",
        },
        {
          key: "comment",
          label: "Comment (JSON)",
          in: "body",
          required: false,
          type: "json",
          bodyPath: "ticket.comment",
          hint: "e.g. { body: 'first message' }",
        },
        {
          key: "priority",
          label: "Priority",
          in: "body",
          required: false,
          bodyPath: "ticket.priority",
          hint: "urgent | high | normal | low",
        },
        {
          key: "type",
          label: "Type",
          in: "body",
          required: false,
          bodyPath: "ticket.type",
          hint: "problem | incident | question | task",
        },
      ],
    },
    {
      key: "update_ticket",
      label: "Update ticket",
      description: "Update a ticket's status, priority, or add a comment.",
      method: "PUT",
      pathTemplate: "/tickets/{ticketId}.json",
      write: true,
      fields: [
        {
          key: "ticketId",
          label: "Ticket id",
          in: "path",
          required: true,
          type: "number",
        },
        {
          key: "status",
          label: "Status",
          in: "body",
          required: false,
          bodyPath: "ticket.status",
          hint: "new | open | pending | hold | solved | closed",
        },
        {
          key: "priority",
          label: "Priority",
          in: "body",
          required: false,
          bodyPath: "ticket.priority",
          hint: "urgent | high | normal | low",
        },
        {
          key: "comment",
          label: "Comment (JSON)",
          in: "body",
          required: false,
          type: "json",
          bodyPath: "ticket.comment",
          hint: "e.g. { body: 'update', public: false }",
        },
      ],
    },
    {
      key: "create_user",
      label: "Create user",
      description: "Create a new end user or agent.",
      method: "POST",
      pathTemplate: "/users.json",
      write: true,
      fields: [
        {
          key: "name",
          label: "Name",
          in: "body",
          required: true,
          bodyPath: "user.name",
        },
        {
          key: "email",
          label: "Email",
          in: "body",
          required: true,
          bodyPath: "user.email",
        },
      ],
    },
  ],
};
// ── Mattermost (self-hosted or Cloud; base = the connection's server URL, e.g.
//    https://chat.acme.com. Auth: a personal access token or bot token as a Bearer —
//    exactly what the API v4 expects, so the default "bearer" scheme is correct) ─────────
const MATTERMOST: IntegrationProvider = {
  key: "mattermost",
  label: "Mattermost",
  baseUrlFromConnection: true,
  authScheme: "bearer",
  description:
    "Post to Mattermost — send a message, reply in a thread, react, or read channel history.",
  auth: "A custom connection whose Server URL is your Mattermost base URL (e.g. https://chat.your-company.com) and whose token is a personal access token or bot token, sent as `Authorization: Bearer <token>` (Mattermost API v4).",
  actions: [
    {
      key: "send_message",
      label: "Send message",
      description:
        "Create a post in a channel — or reply in a thread by setting the root post id.",
      method: "POST",
      pathTemplate: "/api/v4/posts",
      write: true,
      fields: [
        {
          key: "channel_id",
          label: "Channel id",
          in: "body",
          required: true,
          hint: "26-char channel id — resolve a name with 'Get channel by name'",
        },
        { key: "message", label: "Message", in: "body", required: true },
        {
          key: "root_id",
          label: "Thread root post id",
          in: "body",
          required: false,
          hint: "reply inside that post's thread",
        },
      ],
    },
    {
      key: "get_channel_by_name",
      label: "Get channel by name",
      description:
        "Resolve a team + channel name to the channel (and its id) — feed it to Send message.",
      method: "GET",
      pathTemplate: "/api/v4/teams/name/{teamName}/channels/name/{channelName}",
      write: false,
      fields: [
        {
          key: "teamName",
          label: "Team name",
          in: "path",
          required: true,
          hint: "the team's URL slug, e.g. acme",
        },
        {
          key: "channelName",
          label: "Channel name",
          in: "path",
          required: true,
          hint: "the channel's URL slug, e.g. town-square",
        },
      ],
    },
    {
      key: "list_channel_posts",
      label: "List channel posts",
      description: "Read a channel's recent posts (newest first).",
      method: "GET",
      pathTemplate: "/api/v4/channels/{channelId}/posts",
      write: false,
      fields: [
        { key: "channelId", label: "Channel id", in: "path", required: true },
        {
          key: "per_page",
          label: "Per page",
          in: "query",
          required: false,
          type: "number",
        },
        {
          key: "page",
          label: "Page",
          in: "query",
          required: false,
          type: "number",
        },
      ],
    },
    {
      key: "add_reaction",
      label: "Add reaction",
      description: "React to a post with an emoji.",
      method: "POST",
      pathTemplate: "/api/v4/reactions",
      write: true,
      fields: [
        {
          key: "user_id",
          label: "User id",
          in: "body",
          required: true,
          hint: "the reacting user — the token's own user id",
        },
        { key: "post_id", label: "Post id", in: "body", required: true },
        {
          key: "emoji_name",
          label: "Emoji name",
          in: "body",
          required: true,
          hint: "without colons, e.g. white_check_mark",
        },
      ],
    },
    {
      key: "get_user_by_username",
      label: "Get user by username",
      description: "Look a user up by username (for their id / email).",
      method: "GET",
      pathTemplate: "/api/v4/users/username/{username}",
      write: false,
      fields: [
        { key: "username", label: "Username", in: "path", required: true },
      ],
    },
    {
      key: "get_me",
      label: "Get current user",
      description:
        "Return the user this token belongs to. Needs no arguments, so it is the connection check — and it also proves the Server URL points at a real Mattermost.",
      method: "GET",
      pathTemplate: "/api/v4/users/me",
      write: false,
      probe: true,
      fields: [],
    },
  ],
};

// ── PagerDuty (REST API v2, api.pagerduty.com). Auth is PD's OWN scheme —
//    `Authorization: Token token=<key>` — expressed with the custom-header form (#655),
//    NOT a Bearer. Mutating calls also need a `From:` header (the login email of a PD user)
//    unless the key is user-scoped, so writes expose it as an `in: "header"` field. The
//    payload's constant type discriminators (incident / service_reference) are `const`
//    fields the catalog injects, so a user can't get them wrong. ─────────────────────────
const PAGERDUTY: IntegrationProvider = {
  key: "pagerduty",
  label: "PagerDuty",
  baseUrl: "https://api.pagerduty.com",
  authScheme: { header: "Authorization", prefix: "Token token=" },
  headers: { Accept: "application/vnd.pagerduty+json;version=2" },
  description:
    "Manage PagerDuty incidents — create, list, read, acknowledge, resolve, and annotate.",
  auth: "A custom connection whose token is a PagerDuty REST API key, sent as `Authorization: Token token=<key>` (REST API v2's own scheme — not a Bearer). For write actions set the `From` field to the login email of a PagerDuty user, unless the key is user-scoped.",
  actions: [
    {
      key: "create_incident",
      label: "Create incident",
      description: "Open (trigger) a new incident on a service.",
      method: "POST",
      pathTemplate: "/incidents",
      write: true,
      fields: [
        {
          key: "From",
          label: "From (user email)",
          in: "header",
          required: false,
          hint: "login email of a PagerDuty user — required for an account-level (General Access) key; omit for a user-scoped key",
        },
        // PD's payload type discriminators — catalog-supplied, never user-editable.
        {
          key: "type",
          label: "Type",
          in: "body",
          required: true,
          const: "incident",
          bodyPath: "incident.type",
        },
        {
          key: "title",
          label: "Title",
          in: "body",
          required: true,
          bodyPath: "incident.title",
        },
        {
          key: "serviceId",
          label: "Service id",
          in: "body",
          required: true,
          bodyPath: "incident.service.id",
          hint: "the PD service's id, e.g. PW7YESS",
        },
        {
          key: "serviceType",
          label: "Service type",
          in: "body",
          required: true,
          const: "service_reference",
          bodyPath: "incident.service.type",
        },
        {
          key: "urgency",
          label: "Urgency",
          in: "body",
          required: false,
          bodyPath: "incident.urgency",
          hint: "high | low",
        },
        {
          key: "incident_key",
          label: "Incident key",
          in: "body",
          required: false,
          bodyPath: "incident.incident_key",
          hint: "dedupe key — a second create with the same key + service is rejected while the incident is open",
        },
        // `incident.body` is an IncidentBody, whose own `type` is constant. Being a const
        // nested BELOW the envelope, it is injected only when `details` is actually given —
        // never as a lone `body: { type: "incident_body" }` (see buildIntegrationRequest).
        {
          key: "bodyType",
          label: "Body type",
          in: "body",
          required: true,
          const: "incident_body",
          bodyPath: "incident.body.type",
        },
        {
          key: "details",
          label: "Details",
          in: "body",
          required: false,
          bodyPath: "incident.body.details",
          hint: "free-text description shown on the incident",
        },
      ],
    },
    {
      key: "list_incidents",
      label: "List incidents",
      description:
        "List incidents, optionally filtered by status, service, or time window.",
      method: "GET",
      pathTemplate: "/incidents",
      write: false,
      fields: [
        {
          key: "statuses[]",
          label: "Status",
          in: "query",
          required: false,
          hint: "triggered | acknowledged | resolved (one value)",
        },
        {
          key: "service_ids[]",
          label: "Service id",
          in: "query",
          required: false,
          hint: "restrict to one service id",
        },
        {
          key: "since",
          label: "Since",
          in: "query",
          required: false,
          hint: "ISO 8601 timestamp",
        },
        {
          key: "until",
          label: "Until",
          in: "query",
          required: false,
          hint: "ISO 8601 timestamp",
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
        {
          key: "sort_by",
          label: "Sort by",
          in: "query",
          required: false,
          hint: "e.g. created_at:desc",
        },
      ],
    },
    {
      key: "get_incident",
      label: "Get incident",
      description: "Fetch a single incident by id.",
      method: "GET",
      pathTemplate: "/incidents/{id}",
      write: false,
      fields: [
        {
          key: "id",
          label: "Incident id",
          in: "path",
          required: true,
          hint: "e.g. PT4KHLK",
        },
      ],
    },
    {
      key: "acknowledge_incident",
      label: "Acknowledge incident",
      description: "Mark an incident acknowledged (stops escalation).",
      method: "PUT",
      pathTemplate: "/incidents/{id}",
      write: true,
      fields: [
        {
          key: "From",
          label: "From (user email)",
          in: "header",
          required: false,
          hint: "login email of a PagerDuty user — required unless the key is user-scoped",
        },
        { key: "id", label: "Incident id", in: "path", required: true },
        {
          key: "type",
          label: "Type",
          in: "body",
          required: true,
          const: "incident_reference",
          bodyPath: "incident.type",
        },
        {
          key: "status",
          label: "Status",
          in: "body",
          required: true,
          const: "acknowledged",
          bodyPath: "incident.status",
        },
      ],
    },
    {
      key: "resolve_incident",
      label: "Resolve incident",
      description: "Resolve an incident, optionally with a resolution note.",
      method: "PUT",
      pathTemplate: "/incidents/{id}",
      write: true,
      fields: [
        {
          key: "From",
          label: "From (user email)",
          in: "header",
          required: false,
          hint: "login email of a PagerDuty user — required unless the key is user-scoped",
        },
        { key: "id", label: "Incident id", in: "path", required: true },
        {
          key: "type",
          label: "Type",
          in: "body",
          required: true,
          const: "incident_reference",
          bodyPath: "incident.type",
        },
        {
          key: "status",
          label: "Status",
          in: "body",
          required: true,
          const: "resolved",
          bodyPath: "incident.status",
        },
        {
          key: "resolution",
          label: "Resolution",
          in: "body",
          required: false,
          bodyPath: "incident.resolution",
          hint: "note recorded on the incident when it resolves",
        },
      ],
    },
    {
      key: "add_note",
      label: "Add note",
      description: "Append a note to an incident's timeline.",
      method: "POST",
      pathTemplate: "/incidents/{id}/notes",
      write: true,
      fields: [
        {
          key: "From",
          label: "From (user email)",
          in: "header",
          required: false,
          hint: "login email of a PagerDuty user — required unless the key is user-scoped",
        },
        { key: "id", label: "Incident id", in: "path", required: true },
        {
          key: "content",
          label: "Note",
          in: "body",
          required: true,
          bodyPath: "note.content",
        },
      ],
    },
  ],
};

// ── Google Sheets (Sheets API v4, sheets.googleapis.com). Auth: an OAuth access token as a
//    Bearer — a Google API KEY is deliberately NOT supported, since an API key travels in a
//    `?key=` query param and the catalog only sends credentials as headers. ──────────────
const GOOGLESHEETS: IntegrationProvider = {
  key: "googlesheets",
  label: "Google Sheets",
  baseUrl: "https://sheets.googleapis.com",
  authScheme: "bearer",
  description:
    "Read and write a Google Sheet — append rows, read a range, update or clear values.",
  auth: "A connection holding a Google OAuth access token for the `https://www.googleapis.com/auth/spreadsheets` scope, sent as `Authorization: Bearer <token>`. A Google API key will NOT work (API keys go in a `?key=` query param, which this node never sends).",
  unprobeableReason:
    "The Sheets API has no identity endpoint — every call names a spreadsheet. Google's token and " +
    "userinfo endpoints live on a DIFFERENT host, and the check may only call this provider's own " +
    "`baseUrl`, so there is nothing here to call blind. Test a Google Sheets connection with an " +
    "integration node on a canvas (single-node Test), where you can supply a spreadsheet id.",
  actions: [
    {
      key: "get_values",
      label: "Get values",
      description: "Read a range of cells in A1 notation.",
      method: "GET",
      pathTemplate: "/v4/spreadsheets/{spreadsheetId}/values/{range}",
      write: false,
      fields: [
        {
          key: "spreadsheetId",
          label: "Spreadsheet id",
          in: "path",
          required: true,
          hint: "the id in the sheet's URL",
        },
        {
          key: "range",
          label: "Range",
          in: "path",
          required: true,
          hint: "A1 notation, e.g. Sheet1!A1:D20",
        },
        {
          key: "majorDimension",
          label: "Major dimension",
          in: "query",
          required: false,
          hint: "ROWS (default) | COLUMNS",
        },
        {
          key: "valueRenderOption",
          label: "Value render option",
          in: "query",
          required: false,
          hint: "FORMATTED_VALUE | UNFORMATTED_VALUE | FORMULA",
        },
      ],
    },
    {
      key: "append_row",
      label: "Append rows",
      description:
        "Append one or more rows after the last row of a range's table.",
      method: "POST",
      pathTemplate: "/v4/spreadsheets/{spreadsheetId}/values/{range}:append",
      write: true,
      fields: [
        {
          key: "spreadsheetId",
          label: "Spreadsheet id",
          in: "path",
          required: true,
        },
        {
          key: "range",
          label: "Range",
          in: "path",
          required: true,
          hint: "the table to append to, e.g. Sheet1!A1",
        },
        {
          key: "valueInputOption",
          label: "Value input option",
          in: "query",
          required: true,
          hint: "USER_ENTERED (parse like typing) | RAW",
        },
        {
          key: "insertDataOption",
          label: "Insert data option",
          in: "query",
          required: false,
          hint: "INSERT_ROWS | OVERWRITE",
        },
        {
          key: "values",
          label: "Values",
          in: "body",
          required: true,
          type: "json",
          hint: '[["Ada", "ada@acme.com"]] — an array of rows',
        },
      ],
    },
    {
      key: "update_values",
      label: "Update values",
      description: "Overwrite the cells of a range.",
      method: "PUT",
      pathTemplate: "/v4/spreadsheets/{spreadsheetId}/values/{range}",
      write: true,
      fields: [
        {
          key: "spreadsheetId",
          label: "Spreadsheet id",
          in: "path",
          required: true,
        },
        {
          key: "range",
          label: "Range",
          in: "path",
          required: true,
          hint: "A1 notation, e.g. Sheet1!A2:B2",
        },
        {
          key: "valueInputOption",
          label: "Value input option",
          in: "query",
          required: true,
          hint: "USER_ENTERED | RAW",
        },
        {
          key: "values",
          label: "Values",
          in: "body",
          required: true,
          type: "json",
          hint: '[["done", 42]] — rows matching the range',
        },
      ],
    },
    {
      key: "clear_values",
      label: "Clear values",
      description: "Clear the values of a range (formatting is kept).",
      method: "POST",
      pathTemplate: "/v4/spreadsheets/{spreadsheetId}/values/{range}:clear",
      write: true,
      fields: [
        {
          key: "spreadsheetId",
          label: "Spreadsheet id",
          in: "path",
          required: true,
        },
        { key: "range", label: "Range", in: "path", required: true },
      ],
    },
    {
      key: "get_spreadsheet",
      label: "Get spreadsheet",
      description:
        "Fetch the spreadsheet's metadata (its sheets, titles, ids).",
      method: "GET",
      pathTemplate: "/v4/spreadsheets/{spreadsheetId}",
      write: false,
      fields: [
        {
          key: "spreadsheetId",
          label: "Spreadsheet id",
          in: "path",
          required: true,
        },
        {
          key: "includeGridData",
          label: "Include grid data",
          in: "query",
          required: false,
          type: "boolean",
        },
      ],
    },
  ],
};

// ── DeepL (base = the connection's API host: api-free.deepl.com for a Free key,
//    api.deepl.com for Pro — a Free key only authenticates on the free host). Auth is
//    DeepL's own `Authorization: DeepL-Auth-Key <key>`, i.e. the custom-header form. ─────
const DEEPL: IntegrationProvider = {
  key: "deepl",
  label: "DeepL",
  baseUrlFromConnection: true,
  authScheme: { header: "Authorization", prefix: "DeepL-Auth-Key " },
  description:
    "Translate text with DeepL — translate, check quota usage, list supported languages.",
  auth: "A custom connection whose Server URL is your DeepL API host (https://api-free.deepl.com for a Free key, https://api.deepl.com for Pro) and whose token is the DeepL auth key, sent as `Authorization: DeepL-Auth-Key <key>` — DeepL's own scheme, not a Bearer.",
  actions: [
    {
      key: "translate_text",
      label: "Translate text",
      description:
        "Translate one or more strings into a target language (not a mutation — safe to retry).",
      method: "POST",
      pathTemplate: "/v2/translate",
      write: false,
      fields: [
        {
          key: "text",
          label: "Text",
          in: "body",
          required: true,
          type: "json",
          hint: '["Hello world!"] — an array of strings',
        },
        {
          key: "target_lang",
          label: "Target language",
          in: "body",
          required: true,
          hint: "e.g. DE, FR, EN-GB (uppercase)",
        },
        {
          key: "source_lang",
          label: "Source language",
          in: "body",
          required: false,
          hint: "omit to auto-detect",
        },
        {
          key: "formality",
          label: "Formality",
          in: "body",
          required: false,
          hint: "default | more | less | prefer_more | prefer_less",
        },
        {
          key: "context",
          label: "Context",
          in: "body",
          required: false,
          hint: "surrounding text that is NOT translated, to disambiguate",
        },
        {
          key: "glossary_id",
          label: "Glossary id",
          in: "body",
          required: false,
        },
      ],
    },
    {
      key: "get_usage",
      label: "Get usage",
      description: "Read the key's character usage and quota for the period.",
      method: "GET",
      pathTemplate: "/v2/usage",
      write: false,
      fields: [],
    },
    {
      key: "list_languages",
      label: "List languages",
      description: "List the supported source or target languages.",
      method: "GET",
      pathTemplate: "/v2/languages",
      write: false,
      fields: [
        {
          key: "type",
          label: "Type",
          in: "query",
          required: false,
          hint: "source (default) | target",
        },
      ],
    },
  ],
};

export const INTEGRATION_CATALOG: Record<string, IntegrationProvider> = {
  mattermost: MATTERMOST,
  pagerduty: PAGERDUTY,
  googlesheets: GOOGLESHEETS,
  deepl: DEEPL,
  stripe: STRIPE,
  shopify: SHOPIFY,
  twilio: TWILIO,
  mailchimp: MAILCHIMP,
  discord: DISCORD,
  linear: LINEAR,
  clickup: CLICKUP,
  monday: MONDAY,
  pipedrive: PIPEDRIVE,
  zendesk: ZENDESK,
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

/** Set a dotted path on an object, creating intermediate objects. Pure. */
function setPath(
  target: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  if (hasForbiddenPathSegment(path)) return; // #591: prototype-chain keys must never be walked/assigned
  const keys = path.split(".");
  let obj = target;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (obj[k] == null || typeof obj[k] !== "object") obj[k] = {};
    obj = obj[k] as Record<string, unknown>;
  }
  obj[keys[keys.length - 1]] = value;
}

/** True when `path` already resolves to an object on `target` — i.e. some field has already
 *  put data in that sub-object. Used to decide whether a nested `const` discriminator has a
 *  payload to describe. Pure; never walks prototype-chain keys (#591). */
function hasObjectAtPath(
  target: Record<string, unknown> | undefined,
  path: string,
): boolean {
  if (!target || hasForbiddenPathSegment(path)) return false;
  let obj: unknown = target;
  for (const key of path.split(".")) {
    if (obj == null || typeof obj !== "object") return false;
    // OWN properties only — an inherited member must never read as "this sub-object already
    // carries data" (#591); the forbidden-segment check above is belt, this is braces.
    // (`hasOwnProperty.call`, not `Object.hasOwn` — the es2021 lib, as in registry.ts.)
    if (!Object.prototype.hasOwnProperty.call(obj, key)) return false;
    obj = (obj as Record<string, unknown>)[key];
  }
  return obj != null && typeof obj === "object";
}

export interface BuiltIntegrationRequest {
  method: IntegrationAction["method"];
  /** Path portion with `{placeholders}` filled + the query string appended (no base URL). */
  path: string;
  /** Assembled JSON body for write verbs (undefined when there are no body fields / for GETs). */
  body?: Record<string, unknown>;
  /** Headers built from `in: "header"` fields (undefined when the action declares none).
   *  The activity merges these UNDER the resolved auth headers — never over them. */
  headers?: Record<string, string>;
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
  let headers: Record<string, string> | undefined;

  const applyField = (field: IntegrationField, value: unknown): void => {
    const missing = isEmptyFieldValue(value);
    if (field.in === "header") {
      if (missing) return;
      // Trailing whitespace/newlines are common on a value bound from upstream text — trim
      // rather than fail. An INTERIOR CR/LF would let run data inject extra headers into the
      // request, so that still hard-fails in the pure builder (never echoing the value).
      const raw = String(value).trim();
      if (raw === "") return;
      if (/[\r\n]/.test(raw)) {
        throw new Error(
          `Integration ${provider}/${action}: header field '${field.key}' contains a newline`,
        );
      }
      headers ??= {};
      headers[field.key] = raw;
    } else if (field.in === "path") {
      // An empty path value is NEVER substitutable: it collapses the segment and sends a
      // malformed URL. `PUT /incidents/` reached PagerDuty and came back "400 Bad Request",
      // which names neither the field nor the node — the author is left guessing from a
      // provider error about a request we knew was broken before we sent it.
      //
      // Save-time validation can't catch this. It accepts a field as supplied when a BINDING
      // exists for it, and a binding's value isn't known until the run — so a binding pointing
      // at a path that yields nothing passes the gate and fails here. (Every path field in the
      // catalog is required, all 133 of them, so there is no optional-segment case to preserve.)
      if (missing) {
        throw new Error(
          `Integration ${provider}/${action}: path field '${field.key}' is empty — ` +
            `check the binding that supplies it (it resolved to nothing at run time).`,
        );
      }
      path = path.replace(`{${field.key}}`, encodeURIComponent(String(value)));
    } else if (field.in === "query") {
      if (!missing) {
        queryParts.push(
          `${encodeURIComponent(field.key)}=${encodeURIComponent(String(value))}`,
        );
      }
    } else {
      // Empty optional body fields are dropped — UNLESS keepEmpty (an empty string is meaningful,
      // e.g. Dropbox root path ""). A truly-absent value still coalesces to "" via the field default.
      if (missing && !field.keepEmpty) return;
      body ??= {};
      setPath(body, field.bodyPath ?? field.key, value ?? "");
    }
  };

  // Pass 1 — the user's fields.
  for (const field of act.fields) {
    if (field.const === undefined) applyField(field, fields[field.key]);
  }
  // Pass 2 — catalog `const` fields (API type discriminators). They run AFTER the user's
  // fields so a const inside a DEEPER sub-object can see whether that sub-object actually
  // carries data: PagerDuty's `incident.body.type` must not conjure an otherwise-empty
  // `body: { type: "incident_body" }` when no details were given. A const at the top of the
  // payload envelope (`incident.type`) or at the root is always sent.
  for (const field of act.fields) {
    if (field.const === undefined) continue;
    if (field.in === "body") {
      const target = field.bodyPath ?? field.key;
      const parent = target.slice(0, Math.max(0, target.lastIndexOf(".")));
      if (parent.includes(".") && !hasObjectAtPath(body, parent)) continue;
    }
    applyField(field, field.const);
  }

  const qs = queryParts.join("&");
  // A form-encoded action can't express nesting (#707). Reject it HERE, at build time, for the
  // same reason the header-CRLF check above is here: this is a data/config fault a retry can never
  // fix, and the activity's build-time catch already maps it to a non-retryable
  // INTEGRATION_INVALID_CONFIG. Raised in the planner too as a backstop, but by then auth has been
  // resolved and the failure would fall through to "transient" — losing this message.
  if (act.bodyEncoding === "form" && body !== undefined) {
    for (const [key, value] of Object.entries(body)) {
      // A list is fine — it becomes repeated keys (`MediaUrl=a&MediaUrl=b`). Its ELEMENTS are
      // not: `formEncodeBody` appends each one through the same `String(v)`-or-throw path, so an
      // object inside an array is exactly as unsendable as an object at the top. Checking only
      // the array itself let `{name: ["a", {x: 1}]}` past the builder and left the throw to the
      // planner — after auth resolution, where the activity's catch treats it as
      // INTEGRATION_TRANSIENT and sanitizes this message away (and retries a read three times).
      // Reachable from a `type: "string[]"` field bound to run data that yields objects.
      const values: unknown[] = Array.isArray(value) ? value : [value];
      for (const v of values) {
        if (v !== null && typeof v === "object") {
          throw new Error(
            `Integration ${provider}/${action}: form-encoded actions can't send a nested value for '${key}' — flatten it in the catalog (e.g. Stripe's metadata[key] as its own field).`,
          );
        }
      }
    }
  }

  return {
    method: act.method,
    path: qs ? `${path}?${qs}` : path,
    body,
    headers,
  };
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
  // Only a binding that NAMES A SOURCE counts as supplying the field. An unfinished row used
  // to satisfy this gate and then blank the value at run time — the save said fine, the run
  // said "empty". Now an unfinished row leaves the field to its static value, and if there
  // isn't one the save fails here, naming the field, instead of the run failing later.
  const hasBinding = (key: string): boolean =>
    config.fieldBindings != null &&
    key in config.fieldBindings &&
    bindingNamesSource(config.fieldBindings[key]);
  const hasStaticValue = (key: string): boolean =>
    config.fields != null &&
    key in config.fields &&
    !isEmptyFieldValue(config.fields[key]);
  const supplied = (key: string): boolean =>
    hasBinding(key) ||
    hasStaticValue(key) ||
    // A const field is supplied BY THE CATALOG (buildIntegrationRequest injects it), so
    // never ask the user for it.
    action.fields.some((f) => f.key === key && f.const !== undefined);

  // A key this action USED to take, still sitting in a saved config (#944). Checked BEFORE the
  // generic missing-field loop so the author reads what moved instead of the name of a field they
  // have never seen. Only while the replacement is unsupplied: once they have filled the new field
  // in, the stale key is inert (buildIntegrationRequest only ever reads declared fields), and
  // failing the save over inert data would strand a node that is already correct.
  for (const retired of action.retiredFields ?? []) {
    const stillConfigured =
      (config.fields != null && retired.key in config.fields) ||
      (config.fieldBindings != null && retired.key in config.fieldBindings);
    if (!stillConfigured) continue;
    if (retired.replacedBy && supplied(retired.replacedBy)) continue;
    return (
      `integration '${config.provider}.${config.action}' still configures '${retired.key}', which ` +
      `this action no longer takes${retired.replacedBy ? ` — it is now '${retired.replacedBy}'` : ""}. ` +
      retired.note
    );
  }
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
