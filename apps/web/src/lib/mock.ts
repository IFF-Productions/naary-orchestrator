/**
 * Mock data ported verbatim from the Naary product design (Naary.dc.html).
 * Screens render against this until real endpoints exist; the Runs screen
 * additionally wires to the live executions API (see lib/api.ts).
 */
import type { RunState } from "../components";
import type { NodeType } from "../components";

export interface WorkflowRow {
  name: string;
  desc: string;
  status: string;
  statusState: RunState;
  trigger: string;
  runs: string;
  success: string;
  successOk: boolean;
  accent: NodeType;
}

export const workflows: WorkflowRow[] = [
  {
    name: "Email triage & refunds",
    desc: "Classify inbound mail, route refunds to approval",
    status: "Paused",
    statusState: "paused",
    trigger: "Webhook",
    runs: "1,204",
    success: "98.7%",
    successOk: true,
    accent: "approval",
  },
  {
    name: "Lead enrichment",
    desc: "Enrich new leads via CRM + web search",
    status: "Running",
    statusState: "running",
    trigger: "Webhook",
    runs: "880",
    success: "99.2%",
    successOk: true,
    accent: "agent",
  },
  {
    name: "Invoice extraction",
    desc: "Extract line items from PDF invoices",
    status: "Active",
    statusState: "done",
    trigger: "Schedule",
    runs: "412",
    success: "97.0%",
    successOk: true,
    accent: "mcp",
  },
  {
    name: "Support router",
    desc: "Triage and escalate support tickets",
    status: "Active",
    statusState: "done",
    trigger: "Webhook",
    runs: "2,310",
    success: "98.1%",
    successOk: true,
    accent: "router",
  },
  {
    name: "Content pipeline",
    desc: "Draft → review → publish blog posts",
    status: "Active",
    statusState: "done",
    trigger: "Manual",
    runs: "96",
    success: "100%",
    successOk: true,
    accent: "trigger",
  },
  {
    name: "Nightly data sync",
    desc: "Sync warehouse → vector store",
    status: "Failing",
    statusState: "error",
    trigger: "Cron",
    runs: "30",
    success: "80%",
    successOk: false,
    accent: "http",
  },
  {
    name: "Onboarding drip",
    desc: "Personalized onboarding email sequence",
    status: "Draft",
    statusState: "idle",
    trigger: "—",
    runs: "—",
    success: "0%",
    successOk: false,
    accent: "end",
  },
];

export interface RunRow {
  id: string;
  wf: string;
  status: string;
  statusState: RunState;
  awaiting: boolean;
  steps: string;
  cost: string;
  started: string;
}

export const runs: RunRow[] = [
  {
    id: "rs_8f3a",
    wf: "Email triage & refunds",
    status: "Awaiting",
    statusState: "paused",
    awaiting: true,
    steps: "4/5",
    cost: "$0.014",
    started: "2h ago",
  },
  {
    id: "rs_8f29",
    wf: "Lead enrichment",
    status: "Running",
    statusState: "running",
    awaiting: false,
    steps: "6/9",
    cost: "$0.082",
    started: "now",
  },
  {
    id: "rs_8f10",
    wf: "Invoice extraction",
    status: "Done",
    statusState: "done",
    awaiting: false,
    steps: "5/5",
    cost: "$0.031",
    started: "6m ago",
  },
  {
    id: "rs_8ef7",
    wf: "Support router",
    status: "Awaiting",
    statusState: "paused",
    awaiting: true,
    steps: "3/6",
    cost: "$0.009",
    started: "12m ago",
  },
  {
    id: "rs_8ee0",
    wf: "Nightly data sync",
    status: "Failed",
    statusState: "error",
    awaiting: false,
    steps: "2/7",
    cost: "$0.004",
    started: "34m ago",
  },
  {
    id: "rs_8ed2",
    wf: "Content pipeline",
    status: "Done",
    statusState: "done",
    awaiting: false,
    steps: "8/8",
    cost: "$0.067",
    started: "52m ago",
  },
  {
    id: "rs_8ec1",
    wf: "Lead enrichment",
    status: "Done",
    statusState: "done",
    awaiting: false,
    steps: "9/9",
    cost: "$0.078",
    started: "1h ago",
  },
  {
    id: "rs_8eb5",
    wf: "Support router",
    status: "Awaiting",
    statusState: "paused",
    awaiting: true,
    steps: "3/6",
    cost: "$0.011",
    started: "1h ago",
  },
  {
    id: "rs_8ea0",
    wf: "Invoice extraction",
    status: "Done",
    statusState: "done",
    awaiting: false,
    steps: "5/5",
    cost: "$0.029",
    started: "2h ago",
  },
];

export interface McpRow {
  name: string;
  tools: string;
  url: string;
  status: "Connected" | "Error";
}

export const mcps: McpRow[] = [
  {
    name: "google-workspace",
    tools: "8",
    url: "mcp.naary.io/gworkspace",
    status: "Connected",
  },
  {
    name: "internal-crm",
    tools: "5",
    url: "crm.northwind.internal",
    status: "Connected",
  },
  { name: "stripe", tools: "12", url: "mcp.stripe.com", status: "Connected" },
  {
    name: "github",
    tools: "9",
    url: "api.githubcopilot.com/mcp",
    status: "Connected",
  },
  {
    name: "snowflake-warehouse",
    tools: "4",
    url: "mcp.naary.io/snowflake",
    status: "Error",
  },
];

const tnodes: NodeType[] = [
  "trigger",
  "agent",
  "mcp",
  "router",
  "http",
  "approval",
];
export interface TemplateRow {
  name: string;
  desc: string;
  nodes: string;
  tag: string;
  accent: NodeType;
}
export const templates: TemplateRow[] = [
  [
    "Support email triage",
    "Classify, route and auto-resolve inbound support email with human approval on refunds.",
    "7",
    "Customer support",
  ],
  [
    "RAG document Q&A",
    "Ingest docs to a vector store and answer questions with cited sources.",
    "6",
    "Knowledge",
  ],
  [
    "Lead enrichment",
    "Enrich inbound leads via CRM + web search, then score and assign.",
    "8",
    "Sales",
  ],
  [
    "Invoice processing",
    "Extract line items from PDFs, validate, and post to accounting.",
    "9",
    "Finance",
  ],
  [
    "Content pipeline",
    "Draft → human review → multi-channel publish with brand checks.",
    "10",
    "Marketing",
  ],
  [
    "Incident triage",
    "Page on-call, summarize logs, draft a status update for approval.",
    "7",
    "DevOps",
  ],
].map((t, i) => ({
  name: t[0],
  desc: t[1],
  nodes: t[2],
  tag: t[3],
  accent: tnodes[i % tnodes.length],
}));

export type Role = "Owner" | "Admin" | "Member" | "Viewer";
export interface MemberRow {
  name: string;
  email: string;
  initials: string;
  av: string;
  role: Role;
  approve: string;
  active: string;
}
export const members: MemberRow[] = [
  {
    name: "Maria Alvarez",
    email: "m.alvarez@northwind.io",
    initials: "MA",
    av: "linear-gradient(140deg,#f2622e,#c8331f)",
    role: "Owner",
    approve: "All runs",
    active: "now",
  },
  {
    name: "Devin Park",
    email: "d.park@northwind.io",
    initials: "DP",
    av: "linear-gradient(140deg,#5793ef,#3a6fd0)",
    role: "Admin",
    approve: "All runs",
    active: "8m ago",
  },
  {
    name: "Sara Cohen",
    email: "s.cohen@northwind.io",
    initials: "SC",
    av: "linear-gradient(140deg,#8d7cf2,#6a5bd0)",
    role: "Member",
    approve: "Refunds ≤ $100",
    active: "1h ago",
  },
  {
    name: "Tom Reyes",
    email: "t.reyes@northwind.io",
    initials: "TR",
    av: "linear-gradient(140deg,#48b9c4,#2f8f99)",
    role: "Member",
    approve: "None",
    active: "2d ago",
  },
  {
    name: "Priya Nair",
    email: "p.nair@northwind.io",
    initials: "PN",
    av: "linear-gradient(140deg,#52b56b,#3a8f50)",
    role: "Viewer",
    approve: "None",
    active: "5d ago",
  },
];

export const ROLE_COLOR: Record<Role, string> = {
  Owner: "var(--brand)",
  Admin: "var(--state-info)",
  Member: "var(--ink-2)",
  Viewer: "var(--ink-3)",
};

/** Page title + subtitle per route (from the DC `meta()` map). */
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
  "/app/settings": [
    "Settings",
    "Workspace, environments, API keys and secrets.",
  ],
};
