/**
 * Static UI metadata (page titles/subtitles). The former mock data arrays
 * (workflows, runs, mcps, templates, members) were removed once every screen was
 * wired to the real API — only this non-data, presentational map remains.
 */
export const PAGE_META: Record<string, [string, string]> = {
  "/app": ["Overview", ""],
  "/app/workflows": [
    "Workflows",
    "All workflows in this workspace, grouped by status and owner.",
  ],
  "/app/runs": [
    "Runs",
    "Durable execution history — including runs paused for human approval.",
  ],
  "/app/schedules": [
    "Schedules",
    "Recurring runs — start a workflow on a cron (Temporal Schedules).",
  ],
  "/app/templates": [
    "Templates",
    "Production-ready agent workflows you can fork in one click.",
  ],
  "/app/integrations": [
    "Integrations",
    "MCP servers, model providers and connected apps.",
  ],
  "/app/observability": [
    "Observability",
    "Latency, cost and error-rate analytics across all workflows.",
  ],
  "/app/billing": [
    "Billing & usage",
    "Plan, spend caps, invoices and usage by model.",
  ],
  "/app/team": ["Team", "Members, roles and approval permissions."],
  "/app/groups": [
    "Groups",
    "Permission groups — what members and API tokens can see and do.",
  ],
  "/app/company": [
    "Company",
    "Cross-workspace usage and read-only visibility for company admins.",
  ],
  "/app/settings": [
    "Settings",
    "Workspace, environments, API keys and secrets.",
  ],
};
