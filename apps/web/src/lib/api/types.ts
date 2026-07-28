/**
 * Every shared type of the API client — the view models the SPA renders. All of
 * these remain importable from the ../api barrel (`import type { X } from "../lib/api"`).
 */
import type { FormBrandingConfig, GraphDef, TemplateBlock } from "@naary/dsl";

export type ExecutionStatus =
  | "running"
  | "awaiting_approval"
  | "awaiting_webhook"
  | "awaiting_budget" // paused on budget (policy "pause") — resumes on cap raise / month rollover
  | "completed"
  | "rejected"
  | "budget_exceeded"
  | "circuit_open";

export interface ExecutionState {
  /** Widened: a run can be Temporal-failed/terminated/unknown, not just an
   *  ExecutionStatus. Rendered via runStatusUi (which takes any string). */
  status: string;
  currentNodeId: string;
  ctx: Record<string, unknown>;
  /** Node ids known to have run, for a failed run whose ctx came back empty (#525) — the
   *  UI marks them done + the currentNodeId failed. Empty when ctx carries the outputs. */
  executedNodeIds?: string[];
  /** Per-node timing map (Slice 2): { [nodeId]: { s, f, n?, totalMs? } } — epoch-ms
   *  windows the interpreter stamped with deterministic workflow time. Kept as an
   *  unknown-record (matches the generated schema); shape-checked at read time via
   *  run-view-model's nodeTimeOf. Null/absent for pre-feature runs → render "—". */
  nodeTimes?: Record<string, unknown> | null;
  /** Live spend-so-far of this run in USD (Slice 3). Null/absent = unavailable — render "—". */
  spentUsd?: number | null;
  /** The per-run cap the run enforces; null/absent = no cap — never fabricate a meter. */
  perExecutionCapUsd?: number | null;
}

/** One entry in a run's execution log (mirrors the API's RunEvent). */
export interface RunEvent {
  id: number;
  kind:
    | "started"
    | "activity"
    | "signal"
    | "timer"
    | "completed"
    | "error"
    | "continued";
  label: string;
  at: string | null;
  detail?: string;
}

export interface GraphSummary {
  workflowKey: string;
  name: string;
  version: number;
  updatedAt: string;
  /** Whether the workflow's automatic triggers fire (n8n parity). Default true. */
  active: boolean;
  /** Node type of the graph's entry node (e.g. "formTrigger"); null when unresolvable.
   *  Lets a picker offer only the workflows a hosted endpoint can actually be registered for. */
  entryType: string | null;
  /** Organizational tags (tenant-wide per workflowKey — same chips in every environment). */
  tags: TagRef[];
}

/** A workspace tag + how many workflows carry it (manage/list UI). Tags are organizational
 *  metadata only — they never carry permissions. */
export interface Tag {
  id: string;
  name: string;
  color: string | null;
  workflowCount: number;
}

/** The tag identity a workflow row renders as a chip. */
export interface TagRef {
  id: string;
  name: string;
  color: string | null;
}
/** One widget's placement on the customizable Overview (order = array position). */
export interface DashboardItem {
  id: string;
  hidden: boolean;
  /** 12-col grid span: 4 (third), 6 (half), or 12 (full). */
  span: number;
}
/** One stored version of a workflow — for the re-run-at-version picker + version history. */
export interface GraphVersion {
  version: number;
  contentHash: string;
  createdAt: string;
  /** Who saved this version (email / "api-token"); null for promoted or pre-feature rows (#488). */
  savedBy?: string | null;
  /** Optional commit note recorded on save; null when none (#488). */
  saveMessage?: string | null;
}
export interface NamedGraph {
  workflowKey: string;
  name: string;
  version: number;
  graph: GraphDef;
}

export interface TemplateSummary {
  key: string;
  name: string;
  description: string;
  nodeCount: number;
  /** Server-owned taxonomy id (#574) — mirrors the api's TemplateCategory. OPTIONAL on
   *  purpose: an API predating the field returns nothing, and the gallery must still
   *  render (it falls back to deriving a category from the graph). Typed as a plain
   *  string, not a union, so a category the API adds first can't fail the build. */
  category?: string;
  /** Use-case tags (#574) — searched alongside name/description. Optional for the same reason. */
  tags?: string[];
}
export interface TemplateDetail extends TemplateSummary {
  graph: GraphDef;
}

/** A configured provider key (names + validity only — the key is never returned). */
export interface ProviderCredential {
  provider: string;
  isValid: boolean;
}

/** A per-workspace environment (sandbox/UAT/prod). */
export interface Environment {
  id: string;
  name: string;
  slug: string;
  isDefault: boolean;
}

/** One entry in a workflow's promotion lineage. */
export interface Promotion {
  fromEnvId: string;
  toEnvId: string;
  fromVersion: number;
  toVersion: number;
  actor: string;
  createdAt: string;
}

/** Result of a single-node test run. `durationMs`/`costUsd` are the run's own
 *  measurements (Slice 2: interpreter/server-measured, fail-safe-billed) — null
 *  when nothing real was recorded; never a client-side guess. */
export type TestNodeResult =
  | {
      pure: true;
      output: unknown;
      durationMs?: number | null;
      costUsd?: number | null;
    }
  /**
   * Not a pure-node result. `failed` distinguishes the two cases the canvas must render
   * differently: absent = this node type isn't testable in isolation (informational); true = the
   * test ran and FAILED, and the reason belongs on the node.
   */
  | { pure: false; message: string; failed?: boolean };

/**
 * DRY RUN (#832) — the result of checking a flow WITHOUT executing it.
 *
 * `probed` counts only connections we actually called out to. `unprobeable` counts the ones the
 * provider gives us no zero-argument read for (GitHub, Slack, Jira and others — #835): their
 * credentials were NOT verified, and the UI has to say so rather than let "0 problems" imply
 * "everything checked".
 */
export interface DryRunCheck {
  kind: "config" | "request" | "credential";
  ok: boolean;
  /** Nullable, matching the API's DryRunCheckResponse — not just absent. */
  message?: string | null;
  /** The check couldn't run. NOT a failure — and not a pass either. */
  skipped?: boolean;
}
export interface DryRunNodeResult {
  nodeId: string;
  type: string;
  checks: DryRunCheck[];
}
export interface DryRunResult {
  ok: boolean;
  probed: number;
  unprobeable: number;
  nodes: DryRunNodeResult[];
}

/**
 * One batch eval run (#575). `graphVersion` + `graphContentHash` are the SNAPSHOT the batch
 * measured — the key that lets a promote screen say "v9 passed 18/20 vs v8's 20/20".
 */
export interface EvalRun {
  id: string;
  datasetId: string;
  datasetName: string;
  workflowId: string;
  graphVersion: number;
  graphContentHash: string;
  status: string;
  totalCases: number;
  passed: number;
  failed: number;
  errored: number;
  costUsd: number | null;
  startedAt: string;
  finishedAt: string | null;
}

/**
 * One case inside a run. Verdicts, scores and assertion LABELS only — never prompt or completion
 * text, which is a deliberate property of the API (the ledger privacy rule extends here).
 */
export interface EvalCaseResult {
  caseName: string;
  executionId: string | null;
  verdict: string;
  score: number | null;
  costUsd: number | null;
  latencyMs: number | null;
  assertions: unknown;
}

/** A recurring schedule (mirrors the API's ScheduleView). */
export interface ScheduleRow {
  id: string;
  workflowKey: string;
  cron: string;
  paused: boolean;
  createdAt: string;
  nextRunAt: string | null;
}

/** Connection type — MCP/app servers plus SQL databases (the sqlQuery node). */
export type ConnectionType =
  | "github"
  | "atlassian"
  | "custom"
  | "postgres"
  | "mssql"
  | "mysql"
  | "signing"
  | "smtp";
export type ConnectionAuthMode =
  "api_token" | "pat" | "oauth" | "connection_string" | "github_app";

/** A connected MCP server / app / database (mirrors the API's ConnectionView; Date → string over JSON). */
export interface ConnectionRow {
  id: string;
  type: ConnectionType;
  label: string;
  serverUrl: string;
  authMode: ConnectionAuthMode;
  scopes: string[];
  status: "connected" | "needs_reauth" | "error";
  /** Nodes referencing this connection across the env's latest graphs (#471); 0 = unused. */
  usedByNodeCount?: number;
  /** Last 4 chars of the stored bearer credential (#471) — a "which key is this?" hint, never the
   *  full token. null for connection-string (DB/SMTP), tokenless, or too-short secrets. */
  credentialLast4?: string | null;
  createdAt: string;
}

/**
 * n8n import (#579) — an unsaved draft graph plus an honest per-node mapping report. Mirrors the
 * API's ImportN8nResponse (re-declared here rather than imported from @naary/dsl so the SPA's view
 * model stays independent of the DSL's internal report types).
 */
export interface N8nNodeReport {
  n8nName: string;
  n8nType: string;
  /** Null when the node is intentionally NOT a graph node (`skipped`). */
  nodeId: string | null;
  nodeType: string | null;
  status: "imported" | "approximated" | "unmapped" | "skipped";
  /** Always non-empty unless `status === "imported"`. */
  notes: string[];
}

export interface N8nCredentialReport {
  n8nType: string;
  usedBy: string[];
  suggestedConnectionType: string | null;
}

export interface N8nImportResult {
  name: string;
  graph: GraphDef;
  /** One entry per node in the export — nothing is dropped silently. */
  nodes: N8nNodeReport[];
  credentials: N8nCredentialReport[];
  unconvertedExpressions: {
    nodeId: string;
    field: string;
    expression: string;
    reason: string;
  }[];
  warnings: string[];
  counts: Record<N8nNodeReport["status"], number>;
}

/**
 * Result of testing a connection against its provider (#701). Mirrors the API's
 * ConnectionTestResponse.
 *
 * `status` is the test OUTCOME, not an HTTP code — `unknown` (we declined to probe, because the
 * provider has no read-only zero-argument action) is a different thing from `failed` (the provider
 * rejected the credential). `connectionStatus` is null exactly when the test learned nothing and
 * therefore left the connection's status alone.
 */
export interface ConnectionTestResult {
  ok: boolean;
  status: "ok" | "failed" | "unknown";
  httpStatus: number | null;
  checkedAction: string | null;
  connectionStatus: "connected" | "needs_reauth" | "error" | null;
  message: string;
}

/**
 * A browsable MCP server from the registry browser (#578). Mirrors the API's
 * McpRegistryServerResponse. Every field is SANITIZED server-side: `transportUrl` is always a
 * public https URL, `description` is plain text (render it as TEXT, never HTML), and `homepage`
 * is http/https or absent. `trust: "community"` means the row came from the public registry and
 * is authored by a third party.
 */
export interface McpRegistryServerRow {
  id: string;
  name: string;
  description: string;
  transportUrl: string;
  transport: "http";
  authMode: "api_token" | "pat" | "oauth" | "none";
  requiresAuth: boolean;
  trust: "curated" | "community";
  homepage?: string;
  tags: string[];
}

/** One page of registry results. `source: "curated"` = the upstream registry was unavailable and
 *  this is the degraded, in-repo list. */
export interface McpRegistryPage {
  servers: McpRegistryServerRow[];
  source: "registry" | "curated";
  degradedReason?: string;
  curatedAsOf: string;
}

/** A registered webhook endpoint (no signing secret; Date → string over JSON). */
export interface WebhookRow {
  id: string;
  provider: string;
  workflowId: string;
  /** Optional human name; null/absent when unset — the row then leads with its URL as before. */
  label?: string | null;
  /** Deliveries received in the last 7 days (#471); count only (no success rate stored). */
  deliveries7d?: number;
  createdAt: string;
}

/** Input to connect a server or database (token/DSN stored encrypted server-side). */
export interface ConnectionInput {
  type: ConnectionType;
  label: string;
  /** Non-secret: an https endpoint (MCP) or a display host (DB). Never the DSN. */
  serverUrl: string;
  authMode: ConnectionAuthMode;
  scopes?: string[];
  /** The secret: a PAT/api token (MCP) or the full connection string/DSN (DB). */
  token?: string;
}

/** Returned ONCE when registering a webhook — the signing secret is not retrievable again. */
export interface RegisteredWebhook {
  endpointId: string;
  ingressPath: string;
  signingSecret: string;
}

/** A registered hosted-form endpoint (no secret — the opaque id is the only capability). */
export interface FormRow {
  id: string;
  workflowId: string;
  createdAt: string;
}

/** Returned when registering a form — the public path to host/share. */
export interface RegisteredForm {
  formId: string;
  formPath: string;
}

/** One field of a public form definition (mirrors the API's FormFieldResponse). */
export interface FormFieldView {
  key: string;
  label: string;
  type: "text" | "textarea" | "number" | "email" | "select";
  required?: boolean;
  placeholder?: string;
  options?: string[];
}

/**
 * The active bot gate for a public form/chat page (docs/design/TENANT-BOT-GATE-PROVIDERS.md).
 * Absent ⇒ no gate. A discriminated union rather than a flag because the two providers carry
 * different data: Turnstile needs the tenant's public site key, App Check needs nothing at all
 * (it attests OUR Firebase project, which is also why it is the weaker of the two).
 */
export type BotGate =
  { provider: "turnstile"; siteKey: string } | { provider: "app_check" };

/** Public form definition served to an anonymous browser — carries NO tenant/workflow ids. */
export interface FormDefinition {
  formId: string;
  title?: string;
  description?: string;
  submitLabel?: string;
  fields: FormFieldView[];
  /** Present only when a form template drives this form: the template's ordered blocks, so the page
   *  renders content (heading/text/image/…) interleaved with fields. Absent for inline forms (render
   *  the flat `fields`). `fields` stays authoritative for validation. */
  blocks?: TemplateBlock[];
  /** Tenant presentation of the hosted page — success copy, redirect, accent, theme, layout. Every
   *  key optional; absent ⇒ the stock page. Already validated at save time AND re-projected
   *  server-side, but the accent is re-checked at the point of use (see public/form-branding.ts). */
  branding?: FormBrandingConfig;
  /** @deprecated Use `botGate`. Cloudflare Turnstile site key, still emitted for a Turnstile
   *  gate so a cached embedded bundle keeps working. Read it only as a fallback — an OLDER API
   *  emits this and no `botGate`, which is the direction that actually needs handling here. */
  turnstileSiteKey?: string;
  /** The active bot gate, absent when this env has none. Render via `<BotGate>`; send the
   *  resulting token back as `botToken`. */
  botGate?: BotGate;
}

/** A registered hosted-chat endpoint (no secret — the opaque id is the only capability). */
export interface ChatRow {
  id: string;
  workflowId: string;
  createdAt: string;
}

/** Returned when registering a chat — the public path to host/share. */
export interface RegisteredChat {
  chatId: string;
  chatPath: string;
}

/** Public chat definition served to an anonymous browser — carries NO tenant/workflow ids. */
export interface ChatDefinition {
  chatId: string;
  title?: string;
  description?: string;
  placeholder?: string;
  greeting?: string;
  /** @deprecated Use `botGate` — see FormDefinition. */
  turnstileSiteKey?: string;
  /** The active bot gate, absent when this env has none. Each message needs a FRESH token
   *  (both providers hand out single-use ones). */
  botGate?: BotGate;
}

/** A RAG source ("citation") the hosted chat used to answer (issue #482) — a privacy-safe subset of
 *  a vectorQuery match: the source collection, a truncated snippet, and the similarity score. */
export interface Citation {
  source?: string;
  snippet: string;
  score?: number;
}

/** The hosted chat's reply to a message. `citations` is the run's RAG sources — always present
 *  (an empty array when the chat graph ran no retrieval step). */
export interface ChatReply {
  status: string;
  reply?: unknown;
  citations: Citation[];
}

/** Approver routing summary on an awaiting row (Slice 1 — display; enforced server-side). */
export interface ApproverSummary {
  emails: string[];
  groups: { id: string; name: string }[];
}

/** A run paused at an approval, enriched with the node's prompt (approvals inbox).
 *  The Slice-1 fields come from the worker's pause-time snapshot; all null for
 *  gates without routing/SLA config (and for runs paused before Slice 1). */
export interface AwaitingApproval {
  workflowId: string;
  workflowKey: string | null;
  /** The workflow's display name, or null/absent when unresolvable. */
  workflowName?: string | null;
  nodeId: string;
  title: string;
  instructions: string | null;
  createdAt: string;
  /** When the gate paused (worker clock), ISO. */
  pausedAt: string | null;
  /** Display-only SLA hours configured on the gate. */
  slaHours: number | null;
  /** pausedAt + slaHours, derived server-side. */
  dueAt: string | null;
  /** Structured context card — expressions resolved at pause time (never secrets). */
  contextFields: Record<string, string> | null;
  approvers: ApproverSummary | null;
  escalateAfterHours: number | null;
  escalateTo: string | null;
}

export interface RunSummary {
  workflowId: string;
  /** The stable key the trigger/API references. Shown on hover; prefer `workflowName` for display. */
  workflowKey: string | null;
  /** The workflow's display name, or null/absent when unresolvable (pre-migration run, deleted
   *  workflow). Optional so story fixtures and cached responses without it still typecheck. */
  workflowName?: string | null;
  /** Live status from Temporal: running | awaiting_approval | completed |
   *  rejected | budget_exceeded | circuit_open | invalid_graph | failed |
   *  timed_out | terminated | canceled | unknown. */
  status: string;
  costUsd: number | null;
  startedAt: string;
  createdAt: string;
  /** When the run reached a terminal status (worker-stamped, Slice 2); null for
   *  in-flight runs and runs predating the stamp → render "—". */
  finishedAt: string | null;
  /** finishedAt − createdAt in ms; null whenever finishedAt is null. */
  durationMs: number | null;
  /** Compact failure classification (timeout | upstream_5xx | rate_limit | budget |
   *  rejected | error); null → fall back to the close status. */
  failureKind: string | null;
  /** Soft-archived (hidden from the default Runs list). */
  archived: boolean;
  /** The workflow graph version this run snapshotted at start; null for older runs. */
  graphVersion: number | null;
}
export interface UsageReport {
  totalCostUsd: number;
  totalTokens: number;
  byModel: {
    provider: string;
    model: string;
    calls: number;
    totalTokens: number;
    costUsd: number;
  }[];
  events: unknown[];
}

/** Cost/tokens/calls shared by every insights bucket. */
export interface InsightsBucket {
  costUsd: number;
  totalTokens: number;
  calls: number;
}

/** Usage rolled up by day, environment, workflow, and model (GET /tenants/:id/usage/insights).
 *  Slice 2 adds byNodeType (ledger nodeType tag), plus run-outcome rollups from the
 *  Execution table (runsByDay/runsByWorkflow/failureKinds — un-capped, unlike the runs
 *  list). The Slice-2 fields are optional so an older API responds without them. */
export interface InsightsReport {
  range: { from: string | null; to: string | null };
  totals: InsightsBucket;
  byDay: (InsightsBucket & { date: string })[];
  byEnvironment: (InsightsBucket & { environmentId: string | null })[];
  byWorkflow: (InsightsBucket & { workflowKey: string | null })[];
  byModel: (InsightsBucket & { provider: string; model: string })[];
  byNodeType?: (InsightsBucket & {
    nodeType: string | null;
    avgDurationMs: number | null;
  })[];
  runsByDay?: {
    date: string;
    total: number;
    byStatus: Record<string, number>;
  }[];
  runsByWorkflow?: {
    workflowKey: string | null;
    runs: number;
    avgDurationMs: number | null;
  }[];
  failureKinds?: { kind: string; count: number }[];
}
/** One Team-screen row: an ACTIVE member (a real Membership) or a PENDING invitation
 *  (RBAC U1). `id` is the Firebase uid for active rows (the role-change/remove key) and
 *  the invitation id for invited rows (the revoke key). */
export interface Member {
  id: string;
  /** Firebase uid — present on active rows only. */
  userId?: string;
  email: string;
  role: string;
  status: "active" | "invited";
  createdAt: string;
  /** Last authenticated request in this workspace (active rows only). null = not seen
   *  since tracking began; absent on invited rows. */
  lastActiveAt?: string | null;
}
export interface TenantSettings {
  displayName: string | null;
  defaultModel: string | null;
}

/** A Global Variable — non-secret, env-scoped config referenced as `{{ $vars.KEY }}`. */
export interface Variable {
  key: string;
  value: string;
}

/** An API token's metadata (never the token value). */
export interface ApiTokenRow {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  /** How many permission groups this token belongs to (RBAC-GROUPS.md §4a). Under group
   *  enforcement an ungrouped token is deny-by-default; >0 shows the "Restricted" badge. */
  groupCount: number;
}

/** A freshly minted token — `token` is the plaintext, shown once. */
export interface MintedToken {
  id: string;
  token: string;
  label: string;
  createdAt: string;
}

/** A workspace the current user belongs to, with their role (workspace switcher). */
export interface Workspace {
  tenantId: string;
  role: string;
  /** Display name (TenantSettings.displayName); may be unset for un-named workspaces. */
  name?: string;
  /** Soft-archived (COMPANIES.md Slice 4) — hidden from the switcher, but still listed
   *  so a user whose only workspace is archived isn't stranded on the create screen. */
  archived?: boolean;
}

/** A company the caller belongs to (COMPANIES.md — the admin/rollup layer above workspaces). */
export interface Company {
  id: string;
  name: string;
  slug: string;
  /** The caller's company role. */
  role: "owner" | "admin";
}

export interface CompanyUsageBucket {
  costUsd: number;
  totalTokens: number;
  calls: number;
}

/** Company-wide usage rollup — totals + per-workspace (+ nested per-environment). */
export interface CompanyUsage {
  range: { from: string | null; to: string | null };
  totals: CompanyUsageBucket;
  byWorkspace: Array<
    CompanyUsageBucket & {
      tenantId: string;
      displayName: string | null;
      /** Soft-archived (reversible; hidden from the switcher, still billed/rolled up). */
      archived: boolean;
      byEnvironment: Array<
        CompanyUsageBucket & { environmentId: string | null }
      >;
    }
  >;
}

/** One company member (COMPANIES.md Slice 4). Email may be null (enriched best-effort). */
export interface CompanyMember {
  userId: string;
  email: string | null;
  role: "owner" | "admin";
}

/** READ-ONLY run summaries of a member workspace (company console drill-down). */
export interface CompanyWorkspaceRuns {
  items: Array<{
    workflowId: string;
    workflowKey: string | null;
    status: string;
    createdAt: string;
  }>;
  nextCursor: string | null;
}

export interface CompanyWorkspaceWorkflow {
  workflowKey: string;
  name: string;
  version: number;
  updatedAt: string;
  active: boolean;
}

/** A company group's grant: six verbs, always all-workflows/all-environments (v1). */
export interface CompanyGroupGrant {
  id: string;
  canView: boolean;
  canRun: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canShare: boolean;
  canCreate: boolean;
  createdAt: string;
}

/** A company-wide permission group (RBAC-GROUPS §9): a second grant source unioned into
 *  workspace permission resolution for its members, only where a workspace has already
 *  restricted them (never flips a workspace's cliff). Owner-managed; uid-keyed only. */
export interface CompanyGroup {
  id: string;
  name: string;
  createdAt: string;
  members: Array<{ userId: string; createdAt: string }>;
  /** The group's single grant; null while none is set. */
  grant: CompanyGroupGrant | null;
}

/** One entry in the activity feed (who did what, when). */
export interface AuditEvent {
  id: string;
  /** The stored actor id (Firebase uid / `sso:…` / "api-token"). Stable; render `actorEmail` instead. */
  actor: string;
  /** The actor's email in this workspace, or null when unresolvable — never a fabricated value.
   *  Optional so a story fixture or an older cached response doesn't have to carry it. */
  actorEmail?: string | null;
  action: string;
  method: string;
  path: string;
  statusCode: number;
  /** Canonical Environment.id the actor had selected (#464); null when none. */
  environmentId?: string | null;
  createdAt: string;
}

export type NotificationChannelType = "slack" | "teams" | "email";

/** One notification channel row — a workspace can have ANY NUMBER per type (e.g. two
 *  Slack webhooks for #alerts and #oncall, plus an email list). Addressed by `id`;
 *  `label` tells same-type channels apart. */
export interface NotificationChannel {
  id: string;
  type: NotificationChannelType;
  label: string | null;
  /** Off = the worker skips this channel entirely, even with a URL set. */
  enabled: boolean;
  webhookUrl: string | null;
  /** Email channels: the smtp connection this channel sends through (Slice 4).
   *  Null for webhook channels / unconfigured. Credentials never leave the server. */
  emailConnectionId: string | null;
  /** Email channels: recipient addresses. Empty for webhook channels. */
  emailTo: string[];
  onApprovalPending: boolean;
  onRunFailed: boolean;
  /** Budget alert-threshold opt-in (Slice 3). Default false. */
  onBudgetThreshold: boolean;
  /** Promotion opt-in (Slice 4): a workflow promoted into this env. Default false. */
  onPromotion: boolean;
}

/**
 * GET /tenants/:id/budget — budget config plus live month-to-date spend.
 * Mirrors the server's BudgetView (apps/api/src/budget/budget.service.ts):
 * the persisted TenantBudgetConfig fields + the two view-only spend fields.
 * Defined inline (not imported from @naary/usage) because that's a server-only
 * package with Prisma deps that must not enter the web bundle.
 */
export interface BudgetView {
  tenantId: string;
  monthlyCapUsd: number;
  perExecutionCapUsd: number;
  maxStepsPerRun: number;
  onBudgetExceeded: "reject" | "downgrade" | "pause";
  fallbackModel: string | null;
  /** Alert threshold as % of the monthly cap; null = no alert configured (Slice 3). */
  alertThresholdPct: number | null;
  /** Spend so far this calendar month, in USD. */
  mtdSpendUsd: number;
  /** monthlyCapUsd − mtdSpendUsd (may be negative if over cap). */
  remainingUsd: number;
}

/** PUT /tenants/:id/budget body (mirrors the server's SetBudgetDto). */
export interface SetBudgetInput {
  monthlyCapUsd: number;
  perExecutionCapUsd: number;
  maxStepsPerRun?: number;
  onBudgetExceeded?: "reject" | "downgrade" | "pause";
  fallbackModel?: string | null;
  alertThresholdPct?: number | null;
}

/** One usage-ledger line item (UsageReport.events, narrowed — see parseUsageEvents). */
export interface UsageEventItem {
  id: string;
  executionId: string;
  nodeId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  createdAt: string;
}

/** The persisted company-wide budget config (COMPANIES.md §8, Slice 5). */
export interface CompanyBudgetConfig {
  monthlyCapUsd: number;
  onBudgetExceeded: "reject";
}

/**
 * GET /companies/:id/budget — company budget config (null when unset) plus the live
 * company-wide month-to-date spend across all member workspaces.
 */
export interface CompanyBudgetView {
  budget: CompanyBudgetConfig | null;
  mtdSpendUsd: number;
  /** monthlyCapUsd − mtdSpendUsd (may be negative); null when no budget is configured. */
  remainingUsd: number | null;
}

/* ---- Permission groups + grants (RBAC-GROUPS.md, slice G2) ---- */

/** One grant on a permission group: env scope + workflow scope + the six-verb matrix. */
export interface GroupGrant {
  id: string;
  /** null = every environment; otherwise the one env this grant applies to (§8.5). */
  environmentId: string | null;
  /** 'all' = every workflow in the workspace; 'selected' = exactly workflowKeys. */
  scope: "all" | "selected";
  canView: boolean;
  canRun: boolean;
  canEdit: boolean;
  canDelete: boolean;
  /** share = PROMOTE to another environment only (§8.2). */
  canShare: boolean;
  /** Create NEW workflows — its own verb (§8.3); valid only with scope 'all'. */
  canCreate: boolean;
  workflowKeys: string[];
  /** Tag ids this 'selected' grant carries (§9 tag-scoped grants): effective keys =
   *  workflowKeys ∪ every key tagged with ANY of these. Empty for scope 'all'. */
  tagIds: string[];
}

/** A permission group with its members, attached API tokens, and grants. */
export interface PermissionGroup {
  id: string;
  name: string;
  createdAt: string;
  members: { userId: string; createdAt: string }[];
  tokens: { tokenId: string; createdAt: string }[];
  grants: GroupGrant[];
}

/** Grant create/update payload (PATCH semantics on update — absent fields keep their value). */
export interface GrantInput {
  environmentId?: string | null;
  scope?: "all" | "selected";
  canView?: boolean;
  canRun?: boolean;
  canEdit?: boolean;
  canDelete?: boolean;
  canShare?: boolean;
  canCreate?: boolean;
  workflowKeys?: string[];
  /** Tag ids for scope 'selected' (replace-set on update). The workspace's FIRST TagGrant
   *  makes tags access-bearing — tag edits then require the Promote permission. */
  tagIds?: string[];
}

/** Effective access for one verb: everything, or an explicit key list. */
export interface VerbAccess {
  all: boolean;
  keys: string[];
}

/** GET /me/permissions — the caller's effective matrix in the active workspace + env.
 *  `restricted:false` = full access (owner/admin, unrestricted token, or zero grants). */
export interface EffectivePermissions {
  restricted: boolean;
  canCreate: boolean;
  view: VerbAccess;
  run: VerbAccess;
  edit: VerbAccess;
  delete: VerbAccess;
  share: VerbAccess;
}

/** Map a control-plane status to a design run-state token. */
export function statusToRunState(
  s: ExecutionStatus,
): "idle" | "running" | "paused" | "done" | "error" {
  switch (s) {
    case "running":
      return "running";
    case "awaiting_approval":
    case "awaiting_webhook":
    // Budget pause-not-fail (Slice 3): a durable pause, not an error.
    case "awaiting_budget":
      return "paused";
    case "completed":
      return "done";
    case "rejected":
    case "budget_exceeded":
    case "circuit_open":
      return "error";
  }
}
