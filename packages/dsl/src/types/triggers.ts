import type { ArgBinding } from "./core";

/** Start node: an optional sample trigger input used for manual/test runs. */
export interface StartNodeConfig {
  sampleInput?: Record<string, unknown>;
}

/**
 * Schedule Trigger — an ENTRY node that makes the graph run on a cron schedule (n8n's
 * Schedule Trigger). The control plane syncs a Temporal cron Schedule when a graph with this
 * start node is saved (like pollTrigger's interval sync). In the interpreter it's a passthrough
 * of the run input (the scheduled run carries no external event). `cron` is a standard 5/6-field
 * expression, e.g. "0 9 * * 1-5" (weekdays 9am).
 */
export interface ScheduleTriggerNodeConfig {
  /** Cron expression (Temporal/standard). */
  cron: string;
}

/** One field on a form-trigger's hosted form. */
export interface FormFieldDef {
  /** Key in the submitted data object (and the trigger node's output). */
  key: string;
  /** Human label shown above the input. */
  label: string;
  type: "text" | "textarea" | "number" | "email" | "select";
  required?: boolean;
  placeholder?: string;
  /** Choices for `type: "select"`. */
  options?: string[];
}

/**
 * Form trigger — the run starts from a hosted public form (design docs/design/FORM-TRIGGER.md).
 * The submitted `{ key: value }` becomes the trigger node's output (like `webhookTrigger`'s
 * output IS the event). The public form-serving + submit endpoint is a later slice; this is
 * just the node + its field schema.
 */
/**
 * How the hosted form presents itself. All optional — an omitted branding block renders exactly the
 * page that shipped before it existed, so no saved graph changes appearance on upgrade.
 *
 * Every value here is served to an ANONYMOUS browser and re-projected on read
 * (`extractFormDefinition`), and the constrained ones are ALSO validated at save time in
 * `CONFIG_SCHEMAS.formTrigger` — `accentColor` because it lands in a CSS custom property (where
 * `var()` substitution can reach inside `url()`), `redirectUrl` because it navigates the visitor.
 * Validating at both ends means a graph written directly to the DB still can't inject.
 */
export interface FormBrandingConfig {
  /** Heading on the success card (default "Request received"). */
  successTitle?: string;
  /** Body copy on the success card. Plain text — never HTML, it's rendered as a text node. */
  successMessage?: string;
  /**
   * Where to send the visitor after a successful submit, INSTEAD of the success card. `https:` only
   * (see the save-time check): a `javascript:` or `data:` URL here would be stored XSS on our origin,
   * runnable by anyone with the form link.
   *
   * Takes precedence over successTitle/successMessage — the card never renders, so the canvas says so
   * rather than letting an author write copy nobody sees.
   */
  redirectUrl?: string;
  /** Brand accent as `#rrggbb`. Replaces the default ember on the submit button + top strip. */
  accentColor?: string;
  /** Force a light/dark page instead of following the visitor's `prefers-color-scheme`. */
  theme?: "light" | "dark" | "auto";
  /**
   * Desktop field layout. `2` flows fields into two columns ABOVE the mobile breakpoint and collapses
   * to one below it — the desktop/mobile difference, expressed as the only thing that actually
   * differs (available width) rather than as two separately-authored layouts to keep in sync.
   */
  desktopColumns?: 1 | 2;
  /** Card width on desktop: `narrow` is the 460px default, `wide` (640px) suits 2-column forms. */
  width?: "narrow" | "wide";
}

export interface FormTriggerNodeConfig {
  title?: string;
  description?: string;
  /** Submit-button label (default "Submit"). */
  submitLabel?: string;
  fields: FormFieldDef[];
  /** Presentation of the hosted page — see FormBrandingConfig. Omitted ⇒ the stock page. */
  branding?: FormBrandingConfig;
  /**
   * Optional reference to a `kind: "form"` content template (Settings › Content templates). When
   * set, the hosted form's inputs come from the template's `field` blocks instead of the inline
   * `fields` above — the form analog of `sendEmail`'s `templateId`. A deleted/missing template
   * falls back to the inline `fields` (mirrors the email path). title/description/submitLabel stay
   * on the node. Env-scoped like the email template reference.
   */
  templateId?: string;
}

/**
 * Chat trigger — the run starts from a hosted chat message (docs/design/CHAT-TRIGGER-RAG.md).
 * The inbound `{ message, sessionId }` becomes the trigger node's output (like `formTrigger`'s output
 * IS the submitted fields). The public chat page + durable per-session workflow are later slices;
 * this is just the node + its widget presentation.
 */
export interface ChatTriggerNodeConfig {
  /** Widget heading. */
  title?: string;
  /** Sub-heading shown under the title. */
  description?: string;
  /** Placeholder text in the message input. */
  placeholder?: string;
  /** The assistant's opening message shown before the first user turn. */
  greeting?: string;
  /** Opt in to the durable per-session workflow (design §2.1b, option A): a long-lived,
   *  turn-serialized session workflow holds the live conversation in Temporal and enables durable
   *  mid-turn waits (e.g. an approval inside a chat turn). When false/omitted, each message is an
   *  independent run threaded with the ChatMessage-table history (option B — the default). */
  durableSession?: boolean;
}

/**
 * MCP Server Trigger — an ENTRY node that OPTS this workflow IN to being hosted as a callable
 * tool on naary's MCP server (design docs/design/MCP-SERVER.md §5, "flavor B"). naary is already
 * an MCP *client* (the `mcpTool` node); this is the inverse — an external MCP client (Claude
 * Desktop, Cursor, an SDK agent) connecting to naary's `/mcp` endpoint sees this workflow as its
 * own tool (`toolName`) and invoking it starts a durable run. The invocation's JSON arguments
 * become this node's output (like `webhookTrigger`'s output IS the event). Presence of this node
 * as the graph's entry is the opt-in: without it, a workflow is NOT advertised as a per-workflow
 * MCP tool (it is still runnable via the generic `run_workflow` operator tool).
 */
export interface McpServerTriggerNodeConfig {
  /**
   * The MCP tool name external agents call (sanitized to [A-Za-z0-9_-] and de-collided on the
   * server). Omitted ⇒ the server derives `run_<workflowKey>` — the same default flavor B used
   * before this node existed.
   */
  toolName?: string;
  /** Tool description shown to the calling agent (what this workflow does / when to call it). */
  description?: string;
}

/**
 * Poll Trigger — an ENTRY node that fetches a URL and only signals downstream when
 * the source has CHANGED since the last poll. The change is detected against a
 * per-(tenant, workflow, node) cursor persisted across runs (side-effecting, so the
 * compare + fetch happen in an activity). The graph is run on `intervalSeconds` by a
 * Temporal interval Schedule the control plane syncs when a poll graph is saved.
 * Output: `{ changed: boolean, body: unknown }` — branch on `<id>.changed`.
 */
export interface PollTriggerNodeConfig {
  /** URL to poll (https). */
  url: string;
  /** How often to run the workflow, in seconds (the Schedule interval). */
  intervalSeconds: number;
  /** Dotted path into the fetched JSON whose value is the change key (e.g.
   *  "items.0.id"). Omitted = the whole response body is the key (hashed). */
  changeKey?: string;
}

/**
 * Respond to Webhook node — set the HTTP response the webhook ingress should return
 * synchronously (for graphs triggered by a webhook). PURE: it records the response
 * into run state; the run then CONTINUES (respond fast, keep working). `body` is
 * static; `bodyBinding` overrides it from an upstream output. If the run never
 * reaches this node in time, the ingress falls back to a 202.
 */
export interface RespondToWebhookNodeConfig {
  /** HTTP status to return (default 200). */
  statusCode?: number;
  /** Static response body (JSON). */
  body?: unknown;
  /** Upstream binding whose value replaces `body`. */
  bodyBinding?: ArgBinding;
  /** Static, non-secret response headers. */
  headers?: Record<string, string>;
}
