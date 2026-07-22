import type { GraphDef } from "./types";

/**
 * The `{category, urgency}` structured-output schema these classifier/summarizer samples ask for
 * in their prompts. Declared explicitly now that the agent activity has no hardcoded default
 * (#450): a schema-less agent returns free text, so a sample that wants structured fields must
 * carry the schema. (This is exactly the shape the removed default used to force.)
 */
const CLASSIFY_SCHEMA = {
  type: "object",
  properties: {
    category: { type: "string" },
    urgency: { type: "number" },
  },
  required: ["category", "urgency"],
  additionalProperties: false,
} as const;

/**
 * The hardcoded, linear graph: start → agent → humanApproval → end.
 * (Loaded from Postgres in a later slice; hardcoded here on purpose.)
 *
 * The agent node config is the model call's parameters — provider/model/system.
 * The tenant's API key is NOT here; it's fetched inside the activity by tenantId.
 */
export const sampleGraph: GraphDef = {
  startNodeId: "start",
  nodes: [
    { id: "start", type: "start" },
    {
      id: "agent",
      type: "agent",
      config: {
        provider: "anthropic",
        model: "claude-opus-4-8",
        systemPrompt:
          "Classify the user's message. Respond with a category and an urgency from 1-5.",
        outputSchema: CLASSIFY_SCHEMA,
      },
    },
    { id: "approval", type: "humanApproval" },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "start", to: "agent" },
    { from: "agent", to: "approval" },
    { from: "approval", to: "end" },
  ],
};

/**
 * Slice #4 webhook-triggered graph: the inbound event becomes the trigger node's
 * output (consumed by the agent). Same linear shape, started by a webhook instead
 * of the API. (The B5 reference flow adds an mcpTool node between agent + approval.)
 */
export const webhookSampleGraph: GraphDef = {
  startNodeId: "trigger",
  nodes: [
    { id: "trigger", type: "webhookTrigger" },
    {
      id: "agent",
      type: "agent",
      config: {
        provider: "anthropic",
        model: "claude-opus-4-8",
        systemPrompt:
          "Summarize the inbound event. Respond with a category and an urgency from 1-5.",
        outputSchema: CLASSIFY_SCHEMA,
      },
    },
    { id: "approval", type: "humanApproval" },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "trigger", to: "agent" },
    { from: "agent", to: "approval" },
    { from: "approval", to: "end" },
  ],
};

/**
 * GitHub PR review — the "when a PR opens, review the code and comment back" flow.
 * A PR-`opened` webhook → fetch the PR's unified DIFF via the native GitHub integration
 * (get_pull_request with the diff media type) → an agent reviews the ACTUAL diff (injected
 * into its prompt with `{{ diff.body }}`) → the review is posted back as a PR comment via
 * the native integration → a human sign-off. Set every `github` connectionId to your real
 * GitHub connection (a token with repo / issues:write on the target repo), and wire the
 * webhook to the repo's `pull_request` event.
 *
 * NOTE: very large diffs may be claim-check offloaded; the agent then reviews PR metadata
 * only. For big PRs, narrow the diff (e.g. a paths filter) upstream.
 */
export const githubReviewGraph: GraphDef = {
  startNodeId: "trigger",
  nodes: [
    { id: "trigger", type: "webhookTrigger" },
    {
      // Fetch the PR as a unified diff (read action → retryable). Its `body` is the diff text.
      id: "diff",
      type: "integration",
      config: {
        provider: "github",
        action: "get_pull_request",
        connectionId: "github", // ← set to your GitHub connection id
        fieldBindings: {
          owner: { from: "trigger", path: "repository.owner.login" },
          repo: { from: "trigger", path: "repository.name" },
          pullNumber: { from: "trigger", path: "pull_request.number" },
        },
      },
    },
    {
      id: "review",
      type: "agent",
      config: {
        provider: "anthropic",
        model: "claude-opus-4-8",
        // The diff is injected via `{{ diff.body }}` (resolved from the get_pull_request
        // output before this node runs) — so the agent reviews the real code, not metadata.
        systemPrompt:
          "You are a senior engineer reviewing a GitHub pull request. Review the unified diff below and write concise, actionable feedback in GitHub-flavored markdown — flag correctness bugs, security issues, and missing tests; skip style nits. If it looks good, say so briefly.\n\nDIFF:\n{{ diff.body }}",
        outputSchema: {
          type: "object",
          properties: { review: { type: "string" } },
          required: ["review"],
          additionalProperties: false,
        },
        maxOutputTokens: 2048,
      },
    },
    {
      // Post the review back on the PR (PRs comment through the issues endpoint). Write
      // action → at-most-once; a non-2xx (e.g. a token without repo access) fails loudly.
      id: "comment",
      type: "integration",
      config: {
        provider: "github",
        action: "comment_issue",
        connectionId: "github", // ← set to your GitHub connection id
        fieldBindings: {
          owner: { from: "trigger", path: "repository.owner.login" },
          repo: { from: "trigger", path: "repository.name" },
          issueNumber: { from: "trigger", path: "pull_request.number" },
          body: { from: "review", path: "output.review" },
        },
      },
    },
    { id: "approval", type: "humanApproval" },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "trigger", to: "diff" },
    { from: "diff", to: "review" },
    { from: "review", to: "comment" },
    { from: "comment", to: "approval" },
    { from: "approval", to: "end" },
  ],
};

/**
 * HTTP node demo: a webhook event triggers an enrichment GET against a REST API;
 * the graph branches on the response status — a 2xx feeds an agent summary, a
 * non-2xx routes straight to end. Shows the httpRequest node + status branching.
 * `connectionId` is optional; set it to a tenant connection for authenticated APIs.
 */
export const httpEnrichGraph: GraphDef = {
  startNodeId: "trigger",
  nodes: [
    { id: "trigger", type: "webhookTrigger" },
    {
      id: "fetch",
      type: "httpRequest",
      config: {
        method: "GET",
        url: "https://api.github.com/repos/temporalio/temporal",
        headers: { Accept: "application/vnd.github+json" },
      },
    },
    {
      id: "summarize",
      type: "agent",
      config: {
        provider: "anthropic",
        model: "claude-opus-4-8",
        systemPrompt:
          "Summarize the fetched JSON. Respond with a category and an urgency from 1-5.",
        outputSchema: CLASSIFY_SCHEMA,
      },
    },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "trigger", to: "fetch" },
    // 2xx → summarize; anything ≥400 → end (skip the agent).
    {
      from: "fetch",
      to: "summarize",
      condition: { path: "fetch.status", op: "lt", value: 400 },
    },
    {
      from: "fetch",
      to: "end",
      condition: { path: "fetch.status", op: "gt", value: 399 },
    },
    { from: "summarize", to: "end" },
  ],
};

/**
 * SQL node demo: a webhook event triggers a read-only lookup against a tenant
 * database; the rows feed an agent summary. The `userId` param is bound from the
 * event (never built into the SQL text). `connectionId` points at a `postgres`/
 * `mssql` connection whose DSN is stored as a secret.
 */
export const sqlEnrichGraph: GraphDef = {
  startNodeId: "trigger",
  nodes: [
    { id: "trigger", type: "webhookTrigger" },
    {
      id: "lookup",
      type: "sqlQuery",
      config: {
        connectionId: "app-db",
        sql: "SELECT id, email, plan FROM users WHERE id = $1",
        paramBindings: { 1: { from: "trigger", path: "userId" } },
      },
    },
    {
      id: "summarize",
      type: "agent",
      config: {
        provider: "anthropic",
        model: "claude-opus-4-8",
        systemPrompt:
          "Summarize the user record. Respond with a category and an urgency from 1-5.",
        outputSchema: CLASSIFY_SCHEMA,
      },
    },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "trigger", to: "lookup" },
    { from: "lookup", to: "summarize" },
    { from: "summarize", to: "end" },
  ],
};

/**
 * Maps a WebhookEndpoint's `workflowId` to the graph the ingress should start.
 * (Graphs come from Postgres in a later slice — hardcoded here, like sampleGraph.)
 * The ingress reads `endpoint.workflowId`, so registering an endpoint against
 * "github-review" actually reaches the B5 reference flow.
 */
export const graphRegistry: Record<string, GraphDef> = {
  "wf-default": webhookSampleGraph,
  "github-review": githubReviewGraph,
  "http-enrich": httpEnrichGraph,
  "sql-enrich": sqlEnrichGraph,
};

/** Resolve a webhook endpoint's workflowId to its graph, or undefined if unknown. */
export function getGraphForWorkflow(workflowId: string): GraphDef | undefined {
  return graphRegistry[workflowId];
}
