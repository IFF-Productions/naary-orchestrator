/**
 * Shared msw fixtures for the Workflows list + detail stories: a 3-env
 * workspace (sandbox default · UAT · prod) with per-env graph lists keyed off
 * the request's `x-environment-id` header — exactly how the screens fetch
 * cross-env data in production.
 */
import { HttpResponse, http } from "msw";
import type { GraphDef } from "@naary/dsl";

export const ENVIRONMENTS = [
  { id: "e-sb", name: "sandbox", slug: "sandbox", isDefault: true },
  { id: "e-uat", name: "UAT", slug: "uat", isDefault: false },
  { id: "e-prod", name: "prod", slug: "prod", isDefault: false },
];

const TAGS = [
  { id: "tag-bill", name: "billing", color: "#0ea5e9", workflowCount: 1 },
  { id: "tag-ai", name: "ai", color: "#8b5cf6", workflowCount: 1 },
];

const at = (iso: string) => new Date(iso).toISOString();

/** Latest summaries per environment (version counters are PER-ENV). */
export const GRAPHS_BY_ENV: Record<
  string,
  {
    workflowKey: string;
    name: string;
    version: number;
    updatedAt: string;
    active: boolean;
    entryType: string | null;
    tags: { id: string; name: string; color: string | null }[];
  }[]
> = {
  "e-sb": [
    {
      workflowKey: "refund-triage",
      name: "Refund triage",
      version: 9,
      updatedAt: at("2026-07-19T08:00:00Z"),
      active: true,
      entryType: "scheduleTrigger",
      tags: [{ id: "tag-bill", name: "billing", color: "#0ea5e9" }],
    },
    {
      workflowKey: "github-pr-ai-review",
      name: "GitHub PR reviewer",
      version: 7,
      updatedAt: at("2026-07-18T18:00:00Z"),
      active: true,
      entryType: "scheduleTrigger",
      tags: [{ id: "tag-ai", name: "ai", color: "#8b5cf6" }],
    },
    {
      workflowKey: "lead-router",
      name: "Lead router",
      version: 1,
      updatedAt: at("2026-07-12T12:00:00Z"),
      active: false,
      entryType: "scheduleTrigger",
      tags: [],
    },
  ],
  "e-uat": [
    {
      workflowKey: "refund-triage",
      name: "Refund triage",
      version: 4,
      updatedAt: at("2026-07-18T09:00:00Z"),
      active: true,
      entryType: "scheduleTrigger",
      tags: [{ id: "tag-bill", name: "billing", color: "#0ea5e9" }],
    },
  ],
  "e-prod": [
    {
      workflowKey: "refund-triage",
      name: "Refund triage",
      version: 3,
      updatedAt: at("2026-07-13T10:00:00Z"),
      active: true,
      entryType: "scheduleTrigger",
      tags: [{ id: "tag-bill", name: "billing", color: "#0ea5e9" }],
    },
    {
      workflowKey: "github-pr-ai-review",
      name: "GitHub PR reviewer",
      version: 2,
      updatedAt: at("2026-07-10T10:00:00Z"),
      active: false,
      entryType: "scheduleTrigger",
      tags: [{ id: "tag-ai", name: "ai", color: "#8b5cf6" }],
    },
  ],
};

/** Version histories per env for refund-triage. Content hashes tell the drift
 *  story: sandbox v8 == UAT v4 (1 behind), sandbox v6 == prod v3 (3 behind). */
export const VERSIONS_BY_ENV: Record<
  string,
  {
    version: number;
    contentHash: string;
    createdAt: string;
    savedBy?: string | null;
    saveMessage?: string | null;
  }[]
> = {
  "e-sb": [
    {
      version: 9,
      contentHash: "sha-i9",
      createdAt: at("2026-07-19T08:00:00Z"),
      savedBy: "ada@acme.io",
      saveMessage: "Add retry + timeout to the HTTP node",
    },
    {
      version: 8,
      contentHash: "sha-h8",
      createdAt: at("2026-07-18T08:30:00Z"),
      savedBy: "sam@acme.io",
    },
    {
      version: 7,
      contentHash: "sha-g7",
      createdAt: at("2026-07-16T10:00:00Z"),
    },
    {
      version: 6,
      contentHash: "sha-f6",
      createdAt: at("2026-07-13T09:00:00Z"),
    },
    {
      version: 5,
      contentHash: "sha-e5",
      createdAt: at("2026-07-08T09:00:00Z"),
    },
  ],
  "e-uat": [
    {
      version: 4,
      contentHash: "sha-h8",
      createdAt: at("2026-07-18T09:00:00Z"),
    },
    {
      version: 3,
      contentHash: "sha-f6",
      createdAt: at("2026-07-13T09:20:00Z"),
    },
  ],
  "e-prod": [
    {
      version: 3,
      contentHash: "sha-f6",
      createdAt: at("2026-07-13T10:00:00Z"),
    },
    {
      version: 2,
      contentHash: "sha-c2",
      createdAt: at("2026-06-30T10:00:00Z"),
    },
  ],
};

export const PROMOTIONS = [
  {
    fromEnvId: "e-sb",
    toEnvId: "e-uat",
    fromVersion: 8,
    toVersion: 4,
    actor: "tarazena@gmail.com",
    createdAt: at("2026-07-18T09:00:00Z"),
  },
  {
    fromEnvId: "e-uat",
    toEnvId: "e-prod",
    fromVersion: 3,
    toVersion: 3,
    actor: "m.alvarez@acme.co",
    createdAt: at("2026-07-13T10:00:00Z"),
  },
];

/** Graph defs (trigger column + the detail's read-only preview). */
export const GRAPH_DEFS: Record<string, GraphDef> = {
  "refund-triage": {
    startNodeId: "form",
    nodes: [
      { id: "form", type: "formTrigger", config: { fields: [] } },
      {
        id: "classify",
        type: "agent",
        config: { provider: "anthropic", model: "claude-opus-4-8" },
      },
      {
        id: "gate",
        type: "humanApproval",
        config: { title: "Approve refund" },
      },
      { id: "done", type: "end" },
    ],
    edges: [
      { from: "form", to: "classify" },
      { from: "classify", to: "gate" },
      { from: "gate", to: "done" },
    ],
  } as GraphDef,
  "github-pr-ai-review": {
    startNodeId: "hook",
    nodes: [
      { id: "hook", type: "webhookTrigger", config: {} },
      {
        id: "review",
        type: "agent",
        config: { provider: "anthropic", model: "claude-opus-4-8" },
      },
      { id: "done", type: "end" },
    ],
    edges: [
      { from: "hook", to: "review" },
      { from: "review", to: "done" },
    ],
  } as GraphDef,
  "lead-router": {
    startNodeId: "start",
    nodes: [
      { id: "start", type: "start" },
      { id: "route", type: "switch", config: {} },
      { id: "done", type: "end" },
    ],
    edges: [
      { from: "start", to: "route" },
      { from: "route", to: "done" },
    ],
  } as GraphDef,
};

export const RUNS = [
  { workflowKey: "refund-triage", status: "completed", minsAgo: 4 },
  { workflowKey: "refund-triage", status: "awaiting_approval", minsAgo: 62 },
  { workflowKey: "refund-triage", status: "completed", minsAgo: 180 },
  { workflowKey: "refund-triage", status: "failed", minsAgo: 480 },
  { workflowKey: "github-pr-ai-review", status: "running", minsAgo: 1 },
  { workflowKey: "github-pr-ai-review", status: "completed", minsAgo: 90 },
].map((r, i) => ({
  workflowId: `wh-t1-${i}`,
  workflowKey: r.workflowKey,
  status: r.status,
  costUsd: 0.01,
  startedAt: new Date(Date.now() - r.minsAgo * 60_000).toISOString(),
  createdAt: new Date(Date.now() - r.minsAgo * 60_000).toISOString(),
  archived: false,
  graphVersion: 9,
}));

const DIFF = {
  fromVersion: 6,
  toVersion: 9,
  nodesAdded: [
    { id: "gate", type: "humanApproval", config: { title: "Approve refund" } },
  ],
  nodesRemoved: [{ id: "legacy-hook", type: "webhookTrigger", config: {} }],
  nodesChanged: [
    {
      id: "classify",
      fields: ["model"],
      before: { id: "classify", type: "agent", config: {} },
      after: {
        id: "classify",
        type: "agent",
        config: { model: "claude-opus-4-8" },
      },
    },
  ],
  edgesAdded: [{ from: "classify", to: "gate" }],
  edgesRemoved: [],
  edgesReordered: false,
  startNodeChanged: false,
};

const envOf = (request: Request): string =>
  request.headers.get("x-environment-id") ?? "e-sb";

/** The full handler set both screens need (env-header-aware where it matters). */
/**
 * Eval runs for the story (#575). Two versions so the comparison line has something honest to say,
 * and a deliberately IMPERFECT latest run — a card that only ever shows 20/20 hides how the
 * failure state reads.
 */
const evalRuns = [
  {
    id: "er-2",
    datasetId: "d1",
    datasetName: "golden",
    workflowId: "refund-triage",
    graphVersion: 9,
    graphContentHash: "9f2c…",
    status: "completed",
    totalCases: 20,
    passed: 18,
    failed: 2,
    errored: 0,
    costUsd: 0.1842,
    startedAt: "2026-07-27T09:00:00Z",
    finishedAt: "2026-07-27T09:04:00Z",
  },
  {
    id: "er-1",
    datasetId: "d1",
    datasetName: "golden",
    workflowId: "refund-triage",
    graphVersion: 8,
    graphContentHash: "3a71…",
    status: "completed",
    totalCases: 20,
    passed: 20,
    failed: 0,
    errored: 0,
    costUsd: 0.1731,
    startedAt: "2026-07-26T09:00:00Z",
    finishedAt: "2026-07-26T09:04:00Z",
  },
];

const evalCases = [
  { caseName: "refund under threshold auto-approves", executionId: "wh-1", verdict: "pass", score: 1, costUsd: 0.0091, latencyMs: 1840 },
  { caseName: "refund over threshold routes to human", executionId: "wh-2", verdict: "pass", score: 1, costUsd: 0.0102, latencyMs: 2110 },
  // The two that make v9 an 18/20 — the card has to render a failure legibly, not just a tick.
  { caseName: "duplicate request is de-duplicated", executionId: "wh-3", verdict: "fail", score: 0, costUsd: 0.0088, latencyMs: 1990 },
  { caseName: "missing amount is rejected", executionId: "wh-4", verdict: "fail", score: 0, costUsd: null, latencyMs: null },
];

export const workflowHandlers = [
  http.get("*/api/graphs/:key/evals/runs", () => HttpResponse.json(evalRuns)),
  http.get("*/api/evals/runs/:id", ({ params }) =>
    HttpResponse.json({
      ...(evalRuns.find((r) => r.id === params.id) ?? evalRuns[0]),
      cases: evalCases,
    }),
  ),
  http.get("*/api/me", () =>
    HttpResponse.json({ userId: "u1", email: "a@b.co", tenantId: "t1" }),
  ),
  http.get("*/api/me/permissions", () =>
    HttpResponse.json({ restricted: false }),
  ),
  http.get("*/api/tags", () => HttpResponse.json(TAGS)),
  http.get("*/api/tenants/:t/environments", () =>
    HttpResponse.json(ENVIRONMENTS),
  ),
  http.get("*/api/tenants/:t/webhooks", () => HttpResponse.json([])),
  http.get("*/api/executions", () => HttpResponse.json(RUNS)),
  http.get("*/api/graphs", ({ request }) =>
    HttpResponse.json(GRAPHS_BY_ENV[envOf(request)] ?? []),
  ),
  http.get("*/api/graphs/:key/versions", ({ request, params }) =>
    HttpResponse.json(
      params.key === "refund-triage"
        ? (VERSIONS_BY_ENV[envOf(request)] ?? [])
        : [],
    ),
  ),
  http.get("*/api/graphs/:key/promotions", ({ params }) =>
    HttpResponse.json(params.key === "refund-triage" ? PROMOTIONS : []),
  ),
  http.get("*/api/graphs/:key/diff", () => HttpResponse.json(DIFF)),
  http.post("*/api/graphs/:key/promote", () =>
    HttpResponse.json({
      fromVersion: 9,
      toVersion: 4,
      contentHash: "sha-i9",
    }),
  ),
  http.get("*/api/graphs/:key/error-handler", () =>
    HttpResponse.json({ errorWorkflowKey: null }),
  ),
  http.get("*/api/graphs/:key", ({ request, params }) => {
    const key = String(params.key);
    const def = GRAPH_DEFS[key];
    const summary = (GRAPHS_BY_ENV[envOf(request)] ?? []).find(
      (g) => g.workflowKey === key,
    );
    if (!def || !summary) {
      return HttpResponse.json({ message: "not found" }, { status: 404 });
    }
    return HttpResponse.json({
      workflowKey: key,
      name: summary.name,
      version: summary.version,
      graph: def,
    });
  }),
];
