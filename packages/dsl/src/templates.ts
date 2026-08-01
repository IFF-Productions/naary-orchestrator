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
          "Classify the submitted content for policy violations. Flag anything unsafe, spammy, or abusive.",
        // REQUIRED, not decorative (#830). An agent returns a structured object ONLY when its
        // config carries an `outputSchema`; without one it returns free text as `{ text }` — so
        // asking for JSON in the prompt and reading `classify.output.flagged` in the edges below
        // meant `flagged` was ALWAYS undefined. `eq true` never matched and `neq true` always did:
        // the gate failed OPEN, auto-accepting every submission and making the review branch
        // unreachable. The schema is what makes the field exist.
        outputSchema: {
          type: "object",
          properties: {
            flagged: {
              type: "boolean",
              description: "True when the content violates policy.",
            },
            reason: {
              type: "string",
              description: "Why it was flagged (or why it is clean).",
            },
          },
          required: ["flagged", "reason"],
        },
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
 * GitHub issue triage & act. A GitHub `issues` webhook (issue opened) → an agent
 * triages it (one-line summary, labels, priority) → it acts back on the issue via
 * a GitHub MCP connection: posts the triage as a comment AND applies the labels.
 * The "when I create a GitHub issue, it acts" flow — point `github` at your GitHub
 * MCP connection and wire the webhook to the repo's `issues` event.
 */
export const githubIssueTriageGraph: GraphDef = {
  startNodeId: "trigger",
  nodes: [
    { id: "trigger", type: "webhookTrigger" },
    {
      id: "triage",
      type: "agent",
      config: {
        provider: "anthropic",
        model: "claude-opus-4-8",
        systemPrompt:
          "A GitHub issue was just opened. Read its title and body and triage it. Be decisive.",
        // See moderationGraph: the prompt asking for JSON does not make the output structured, and
        // the `output.summary` / `output.labels` bindings below read fields that would never have
        // existed — the comment would post nothing and the label call would send no labels (#830).
        outputSchema: {
          type: "object",
          properties: {
            summary: { type: "string", description: "A one-line triage note." },
            labels: {
              type: "array",
              items: {
                type: "string",
                enum: ["bug", "enhancement", "question", "documentation"],
              },
            },
            priority: { type: "string", enum: ["low", "medium", "high"] },
          },
          required: ["summary", "labels", "priority"],
        },
      },
    },
    {
      id: "comment",
      type: "mcpTool",
      config: {
        connectionId: "github",
        tool: "add_issue_comment",
        // Post the agent's triage summary back on the issue that triggered the run.
        argumentBindings: {
          issueNumber: { from: "trigger", path: "issue.number" },
          body: { from: "triage", path: "output.summary" },
        },
      },
    },
    {
      id: "label",
      type: "mcpTool",
      config: {
        connectionId: "github",
        tool: "add_issue_labels",
        argumentBindings: {
          issueNumber: { from: "trigger", path: "issue.number" },
          labels: { from: "triage", path: "output.labels" },
        },
      },
    },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "trigger", to: "triage" },
    { from: "triage", to: "comment" },
    { from: "comment", to: "label" },
    { from: "label", to: "end" },
  ],
};

/**
 * Jira ticket from an intake. An inbound webhook (a bug report, feature ask, or
 * support message) → an agent structures it into a Jira ticket (summary, detail,
 * type, priority) → a human reviews it → the approved ticket is created in Jira via
 * an MCP connection. HITL by design: AI drafts the ticket, a person signs off before
 * it lands. Point `jira` at your Atlassian/Jira MCP connection.
 */
export const jiraTicketGraph: GraphDef = {
  startNodeId: "trigger",
  nodes: [
    { id: "trigger", type: "webhookTrigger" },
    {
      id: "structure",
      type: "agent",
      config: {
        provider: "anthropic",
        model: "claude-opus-4-8",
        systemPrompt:
          "You turn an inbound request (a bug report, feature ask, or support message) into a Jira ticket.",
        // See moderationGraph. Without this, the four `output.*` bindings below resolved to nothing
        // and Jira's create_issue was called with empty required arguments — AFTER a human had
        // already approved a ticket the run could not actually create (#830).
        outputSchema: {
          type: "object",
          properties: {
            summary: { type: "string", description: "A concise issue title." },
            description: {
              type: "string",
              description: "Clear, actionable detail.",
            },
            issueType: { type: "string", enum: ["Bug", "Task", "Story"] },
            priority: { type: "string", enum: ["Low", "Medium", "High"] },
          },
          required: ["summary", "description", "issueType", "priority"],
        },
      },
    },
    {
      id: "approval",
      type: "humanApproval",
      config: {
        title: "Approve the Jira ticket",
        instructions:
          "Review the AI-structured ticket (summary, type, priority) before it is created in Jira. Reject to discard it.",
        timeoutHours: 24,
      },
    },
    {
      id: "create",
      type: "mcpTool",
      config: {
        connectionId: "jira",
        tool: "create_issue",
        // Each Jira field is bound from the agent's structured output.
        argumentBindings: {
          summary: { from: "structure", path: "output.summary" },
          description: { from: "structure", path: "output.description" },
          issueType: { from: "structure", path: "output.issueType" },
          priority: { from: "structure", path: "output.priority" },
        },
      },
    },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "trigger", to: "structure" },
    { from: "structure", to: "approval" },
    { from: "approval", to: "create" },
    { from: "create", to: "end" },
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
      name: "Summarize ticket",
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
