import type { GraphDef } from "./types";

/**
 * Product-facing starter templates surfaced in the Templates screen. Unlike the
 * test/demo graphs in sample-graph.ts, these are written to read as real, useful
 * starting points a user forks and customizes (swap connection ids, addresses,
 * prompts). Every graph here MUST pass validateGraph — templates.spec.ts enforces it.
 *
 * Config values that reference tenant resources (a `connectionId`, an email `to`,
 * a feed `url`) are placeholders the user edits after loading the template.
 */

/**
 * Feed digest → email. Scheduled/manual `start` → pull an RSS/Atom feed →
 * an agent writes a skimmable digest → email it. A classic "keep me posted"
 * automation for non-technical users; point it at any feed + SMTP connection.
 */
export const feedDigestGraph: GraphDef = {
  startNodeId: "start",
  nodes: [
    { id: "start", type: "start" },
    {
      id: "feed",
      type: "rssRead",
      config: { url: "https://hnrss.org/frontpage" },
    },
    {
      id: "digest",
      type: "agent",
      config: {
        provider: "anthropic",
        model: "claude-opus-4-8",
        systemPrompt:
          "You are given a list of feed items (title, link, summary). Write a concise digest of the 5 most important items. For each: a one-line takeaway followed by its link. Keep it skimmable; no preamble.",
      },
    },
    {
      id: "email",
      type: "sendEmail",
      config: {
        connectionId: "smtp",
        to: "you@example.com",
        subject: "Your feed digest",
      },
    },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "start", to: "feed" },
    { from: "feed", to: "digest" },
    { from: "digest", to: "email" },
    { from: "email", to: "end" },
  ],
};

/**
 * Support reply with human sign-off. Inbound webhook (a new ticket) → an agent
 * drafts a reply → a human reviews/approves it → the approved reply is emailed.
 * The differentiator flow: AI does the work, a person stays in the loop. The
 * approval node carries a title + instructions the reviewer reads at decision time.
 */
export const supportReplyGraph: GraphDef = {
  startNodeId: "trigger",
  nodes: [
    { id: "trigger", type: "webhookTrigger" },
    {
      id: "draft",
      type: "agent",
      config: {
        provider: "anthropic",
        model: "claude-opus-4-8",
        systemPrompt:
          "You are a support agent. Given the customer's message, draft a warm, accurate reply that resolves their issue. If you are unsure or the request is risky (refunds, account changes), say so and ask for human judgment. Return only the reply text.",
      },
    },
    {
      id: "approval",
      type: "humanApproval",
      config: {
        title: "Approve the support reply",
        instructions:
          "Review the AI-drafted reply for tone and accuracy before it is sent to the customer. Reject to stop it.",
        timeoutHours: 24,
      },
    },
    {
      id: "send",
      type: "sendEmail",
      config: {
        connectionId: "smtp",
        subject: "Re: your support request",
      },
    },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "trigger", to: "draft" },
    { from: "draft", to: "approval" },
    { from: "approval", to: "send" },
    { from: "send", to: "end" },
  ],
};

/**
 * Scheduled database report. `start` (run on a schedule) → a read-only query
 * against a tenant database → an agent turns the rows into a plain-language
 * summary → emailed. Point `app-db` at a `postgres`/`mssql` connection and edit
 * the query. Pairs with a Schedule to become a daily/weekly report.
 */
export const dbReportGraph: GraphDef = {
  startNodeId: "start",
  nodes: [
    { id: "start", type: "start" },
    {
      id: "query",
      type: "sqlQuery",
      config: {
        connectionId: "app-db",
        sql: "SELECT status, count(*) AS n FROM orders WHERE created_at > now() - interval '1 day' GROUP BY status",
      },
    },
    {
      id: "report",
      type: "agent",
      config: {
        provider: "anthropic",
        model: "claude-opus-4-8",
        systemPrompt:
          "You are given rows from a database query. Write a short, plain-language report a non-technical manager can read at a glance: the headline number, notable changes, and anything that looks off. No tables.",
      },
    },
    {
      id: "email",
      type: "sendEmail",
      config: {
        connectionId: "smtp",
        to: "team@example.com",
        subject: "Daily report",
      },
    },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "start", to: "query" },
    { from: "query", to: "report" },
    { from: "report", to: "email" },
    { from: "email", to: "end" },
  ],
};

/**
 * Content moderation gate. Inbound webhook (user-submitted content) → an agent
 * classifies it → branch on the verdict: flagged content routes to a human
 * approval, clean content responds 200 immediately. Shows classification +
 * status branching + a synchronous webhook response.
 */
export const moderationGraph: GraphDef = {
  startNodeId: "trigger",
  nodes: [
    { id: "trigger", type: "webhookTrigger" },
    {
      id: "classify",
      type: "agent",
      config: {
        provider: "anthropic",
        model: "claude-opus-4-8",
        systemPrompt:
          'Classify the submitted content for policy violations. Respond with a JSON object: { "flagged": boolean, "reason": string }. Flag anything unsafe, spammy, or abusive.',
      },
    },
    {
      id: "review",
      type: "humanApproval",
      config: {
        title: "Review flagged content",
        instructions:
          "The classifier flagged this submission. Approve to publish it anyway, or reject to keep it blocked.",
        timeoutHours: 48,
      },
    },
    {
      id: "accepted",
      type: "respondToWebhook",
      config: { statusCode: 200, body: { status: "accepted" } },
    },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "trigger", to: "classify" },
    // Flagged → human review; clean → respond 200 and finish.
    {
      from: "classify",
      to: "review",
      condition: { path: "classify.output.flagged", op: "eq", value: true },
    },
    {
      from: "classify",
      to: "accepted",
      condition: { path: "classify.output.flagged", op: "neq", value: true },
    },
    { from: "review", to: "accepted" },
    { from: "accepted", to: "end" },
  ],
};

/**
 * API enrichment. Inbound webhook → a GET against a REST API → an agent
 * summarizes the response. Set the URL (and an optional `connectionId` for
 * authenticated APIs). A clean starting point for "when X happens, look up Y."
 */
export const apiEnrichGraph: GraphDef = {
  startNodeId: "trigger",
  nodes: [
    { id: "trigger", type: "webhookTrigger" },
    {
      id: "fetch",
      type: "httpRequest",
      config: {
        method: "GET",
        url: "https://api.example.com/resource",
        headers: { Accept: "application/json" },
      },
    },
    {
      id: "summarize",
      type: "agent",
      config: {
        provider: "anthropic",
        model: "claude-opus-4-8",
        systemPrompt:
          "Summarize the fetched JSON for a human: what it is and the few fields that matter. Be brief.",
      },
    },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "trigger", to: "fetch" },
    { from: "fetch", to: "summarize" },
    { from: "summarize", to: "end" },
  ],
};
