/**
 * Every shared type of the API client — the view models the SPA renders. All of
 * these remain importable from the ../api barrel (`import type { X } from "../lib/api"`).
 */
import type { GraphDef } from "@naary/dsl";

export type ExecutionStatus =
  | "running"
  | "awaiting_approval"
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
/** One stored version of a workflow (identity only) — for the re-run-at-version picker. */
export interface GraphVersion {
  version: number;
  contentHash: string;
  createdAt: string;
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

/** Result of a single-node test run. */
export type TestNodeResult =
  { pure: true; output: unknown } | { pure: false; message: string };

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
  createdAt: string;
}

/** A registered webhook endpoint (no signing secret; Date → string over JSON). */
export interface WebhookRow {
  id: string;
  provider: string;
  workflowId: string;
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

/** Public form definition served to an anonymous browser — carries NO tenant/workflow ids. */
export interface FormDefinition {
  formId: string;
  title?: string;
  description?: string;
  submitLabel?: string;
  fields: FormFieldView[];
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
}

/** A run paused at an approval, enriched with the node's prompt (approvals inbox). */
export interface AwaitingApproval {
  workflowId: string;
  workflowKey: string | null;
  nodeId: string;
  title: string;
  instructions: string | null;
  createdAt: string;
}

/** One run's outcome in a batch approve/reject — ok:false carries why it slipped. */
export interface BatchDecisionResult {
  workflowId: string;
  ok: boolean;
  error?: string;
}

export interface RunSummary {
  workflowId: string;
  workflowKey: string | null;
  /** Live status from Temporal: running | awaiting_approval | completed |
   *  rejected | budget_exceeded | circuit_open | invalid_graph | failed |
   *  timed_out | terminated | canceled | unknown. */
  status: string;
  costUsd: number | null;
  startedAt: string;
  createdAt: string;
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

/** Usage rolled up by day, environment, workflow, and model (GET /tenants/:id/usage/insights). */
export interface InsightsReport {
  range: { from: string | null; to: string | null };
  totals: InsightsBucket;
  byDay: (InsightsBucket & { date: string })[];
  byEnvironment: (InsightsBucket & { environmentId: string | null })[];
  byWorkflow: (InsightsBucket & { workflowKey: string | null })[];
  byModel: (InsightsBucket & { provider: string; model: string })[];
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

/** One entry in the activity feed (who did what, when). */
export interface AuditEvent {
  id: string;
  actor: string;
  action: string;
  method: string;
  path: string;
  statusCode: number;
  createdAt: string;
}

export type NotificationChannelType = "slack" | "teams";

/** One notification channel row — a workspace can have ANY NUMBER per type (e.g. two
 *  Slack webhooks for #alerts and #oncall). Addressed by `id`; `label` tells same-type
 *  channels apart. */
export interface NotificationChannel {
  id: string;
  type: NotificationChannelType;
  label: string | null;
  /** Off = the worker skips this channel entirely, even with a URL set. */
  enabled: boolean;
  webhookUrl: string | null;
  onApprovalPending: boolean;
  onRunFailed: boolean;
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
  onBudgetExceeded: "reject" | "downgrade";
  fallbackModel: string | null;
  /** Spend so far this calendar month, in USD. */
  mtdSpendUsd: number;
  /** monthlyCapUsd − mtdSpendUsd (may be negative if over cap). */
  remainingUsd: number;
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

/** Map a control-plane status to a design run-state token. */
export function statusToRunState(
  s: ExecutionStatus,
): "idle" | "running" | "paused" | "done" | "error" {
  switch (s) {
    case "running":
      return "running";
    case "awaiting_approval":
      return "paused";
    case "completed":
      return "done";
    case "rejected":
    case "budget_exceeded":
    case "circuit_open":
      return "error";
  }
}
