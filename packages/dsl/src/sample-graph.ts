import type { GraphDef } from "./types";

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
 * Slice #4 B5 reference flow: GitHub PR webhook → agent reviews → MCP Tool node
 * comments back via a GitHub connection → human approval before any merge.
 * The mcpTool node's connectionId is per-tenant; set it to a real connection id.
 */
export const githubReviewGraph: GraphDef = {
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
          "Review the pull request. Respond with a category and an urgency from 1-5.",
      },
    },
    {
      id: "comment",
      type: "mcpTool",
      config: { connectionId: "github", tool: "add_pull_request_comment" },
    },
    { id: "approval", type: "humanApproval" },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "trigger", to: "agent" },
    { from: "agent", to: "comment" },
    { from: "comment", to: "approval" },
    { from: "approval", to: "end" },
  ],
};
