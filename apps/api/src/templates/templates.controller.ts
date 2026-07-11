import { Controller, Get, NotFoundException, Param } from "@nestjs/common";
import type { GraphDef } from "@naary/dsl";
import {
  apiEnrichGraph,
  dbReportGraph,
  feedDigestGraph,
  githubIssueTriageGraph,
  githubReviewGraph,
  jiraTicketGraph,
  moderationGraph,
  sampleGraph,
  supportReplyGraph,
  webhookSampleGraph,
} from "@naary/dsl";

/** A built-in workflow template, surfaced to the Templates screen. */
export interface TemplateSummary {
  key: string;
  name: string;
  description: string;
  nodeCount: number;
}

/** A template plus its graph — what "Use template" loads into the canvas. */
export interface TemplateDetail extends TemplateSummary {
  graph: GraphDef;
}

/**
 * The built-in templates are the DSL's seed graphs (one per seeded workflowKey).
 * Name/description are presentation metadata that the graph DSL deliberately does
 * not carry, so they live here. `key` MUST match the seeded workflowKey — the
 * canvas opens a template by that key (`/app/canvas?key=...`).
 */
const TEMPLATES: {
  key: string;
  name: string;
  description: string;
  graph: GraphDef;
}[] = [
  {
    key: "default",
    name: "Classify & approve",
    description:
      "Linear agent flow: classify an inbound message, then pause for human approval.",
    graph: sampleGraph,
  },
  {
    key: "wf-default",
    name: "Webhook triage",
    description:
      "Webhook-triggered agent that summarizes the inbound event, then waits for approval.",
    graph: webhookSampleGraph,
  },
  {
    key: "github-review",
    name: "GitHub PR review",
    description:
      "When a PR opens, fetch its diff, let an agent review the actual code changes, post the review back as a PR comment via your GitHub connection, then a human sign-off. Wire the webhook to the repo's pull_request event.",
    graph: githubReviewGraph,
  },
  {
    key: "feed-digest",
    name: "Feed digest by email",
    description:
      "Pull an RSS/Atom feed, let an agent write a skimmable digest, and email it. Point it at any feed + SMTP connection; pair with a schedule for a daily digest.",
    graph: feedDigestGraph,
  },
  {
    key: "support-reply",
    name: "Support reply with sign-off",
    description:
      "A new ticket comes in, an agent drafts a reply, a human reviews and approves it, then it's emailed. AI does the work; a person stays in the loop.",
    graph: supportReplyGraph,
  },
  {
    key: "db-report",
    name: "Scheduled database report",
    description:
      "Run a read-only query against your database, turn the rows into a plain-language summary, and email it. Pair with a schedule for a daily/weekly report.",
    graph: dbReportGraph,
  },
  {
    key: "moderation",
    name: "Content moderation gate",
    description:
      "Classify user-submitted content; clean submissions are accepted instantly, flagged ones route to a human before publishing.",
    graph: moderationGraph,
  },
  {
    key: "api-enrich",
    name: "API enrichment",
    description:
      "When a webhook fires, call a REST API and let an agent summarize the response. A starting point for 'when X happens, look up Y'.",
    graph: apiEnrichGraph,
  },
  {
    key: "github-issue-triage",
    name: "GitHub issue triage & act",
    description:
      "When a GitHub issue is opened, an agent triages it (summary, labels, priority) and acts back on the issue via your GitHub connection — posting the triage as a comment and applying the labels.",
    graph: githubIssueTriageGraph,
  },
  {
    key: "jira-ticket",
    name: "Jira ticket from an intake",
    description:
      "Turn an inbound request (bug report, feature ask, support message) into a structured Jira ticket. An agent drafts it, a human approves it, then it's created in Jira via your connection.",
    graph: jiraTicketGraph,
  },
];

/**
 * Built-in workflow templates. Authenticated like every other route, but NOT
 * tenant-scoped — these are global built-ins, identical for every tenant, so no
 * `@TenantId()` (and no `@Public()`: a token is still required).
 */
@Controller("templates")
export class TemplatesController {
  @Get()
  list(): TemplateSummary[] {
    return TEMPLATES.map(({ key, name, description, graph }) => ({
      key,
      name,
      description,
      nodeCount: graph.nodes.length,
    }));
  }

  /** The template + its graph — the canvas loads this as a NEW draft to fork. */
  @Get(":key")
  get(@Param("key") key: string): TemplateDetail {
    const t = TEMPLATES.find((x) => x.key === key);
    if (!t) throw new NotFoundException(`Unknown template '${key}'`);
    return {
      key: t.key,
      name: t.name,
      description: t.description,
      nodeCount: t.graph.nodes.length,
      graph: t.graph,
    };
  }
}
