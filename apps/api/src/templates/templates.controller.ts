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

/**
 * Server-owned template taxonomy (#574). A CLOSED set of ids: the SPA maps each id to a
 * label/icon/accent, so adding one here without a matching web entry degrades to the id
 * rather than breaking — but keep the two in sync (apps/web/.../templates/model.ts
 * CATEGORY_DEFS). The API deliberately ships only the id: colors and glyphs are
 * presentation and must not leak into the control plane.
 */
export type TemplateCategory =
  "agents" | "api" | "database" | "email" | "github" | "jira";

/** A built-in workflow template, surfaced to the Templates screen. */
export interface TemplateSummary {
  key: string;
  name: string;
  description: string;
  nodeCount: number;
  /**
   * Curated category (#574). ADDED, never replacing a field — the SPA used to INFER this
   * by inspecting graph node types; now the catalog owns it. Non-optional here so a new
   * template can't ship uncategorized; the SPA still keeps a graph-derived fallback for
   * an older API that predates this field.
   */
  category: TemplateCategory;
  /** Free-form use-case tags (#574) — feed the gallery's search, lowercase, no duplicates. */
  tags: string[];
}

/** A template plus its graph — what "Use template" loads into the canvas. */
export interface TemplateDetail extends TemplateSummary {
  graph: GraphDef;
}

/**
 * The built-in templates are the DSL's seed graphs (one per seeded workflowKey).
 * Name/description/category/tags are presentation + taxonomy metadata that the graph DSL
 * deliberately does not carry, so they live here. `key` MUST match the seeded workflowKey
 * — the canvas opens a template by that key (`/app/canvas?key=...`).
 */
const TEMPLATES: {
  key: string;
  name: string;
  description: string;
  category: TemplateCategory;
  tags: string[];
  graph: GraphDef;
}[] = [
  {
    key: "default",
    name: "Classify & approve",
    description:
      "Linear agent flow: classify an inbound message, then pause for human approval.",
    category: "agents",
    tags: ["getting-started", "classification", "human-approval"],
    graph: sampleGraph,
  },
  {
    key: "wf-default",
    name: "Webhook triage",
    description:
      "Webhook-triggered agent that summarizes the inbound event, then waits for approval.",
    category: "agents",
    tags: ["getting-started", "webhook", "summarization", "human-approval"],
    graph: webhookSampleGraph,
  },
  {
    key: "github-review",
    name: "GitHub PR review",
    description:
      "When a PR opens, fetch its diff, let an agent review the actual code changes, post the review back as a PR comment via your GitHub connection, then a human sign-off. Wire the webhook to the repo's pull_request event.",
    category: "github",
    tags: ["code-review", "pull-request", "webhook", "human-approval"],
    graph: githubReviewGraph,
  },
  {
    key: "feed-digest",
    name: "Feed digest by email",
    description:
      "Pull an RSS/Atom feed, let an agent write a skimmable digest, and email it. Point it at any feed + SMTP connection; pair with a schedule for a daily digest.",
    category: "email",
    tags: ["rss", "digest", "schedule", "notification"],
    graph: feedDigestGraph,
  },
  {
    key: "support-reply",
    name: "Support reply with sign-off",
    description:
      "A new ticket comes in, an agent drafts a reply, a human reviews and approves it, then it's emailed. AI does the work; a person stays in the loop.",
    category: "email",
    tags: ["support", "human-approval", "webhook", "drafting"],
    graph: supportReplyGraph,
  },
  {
    key: "db-report",
    name: "Scheduled database report",
    description:
      "Run a read-only query against your database, turn the rows into a plain-language summary, and email it. Pair with a schedule for a daily/weekly report.",
    category: "database",
    tags: ["sql", "reporting", "schedule", "summarization"],
    graph: dbReportGraph,
  },
  {
    key: "moderation",
    name: "Content moderation gate",
    description:
      "Classify user-submitted content; clean submissions are accepted instantly, flagged ones route to a human before publishing.",
    category: "agents",
    tags: ["moderation", "classification", "branching", "human-approval"],
    graph: moderationGraph,
  },
  {
    key: "api-enrich",
    name: "API enrichment",
    description:
      "When a webhook fires, call a REST API and let an agent summarize the response. A starting point for 'when X happens, look up Y'.",
    category: "api",
    tags: ["http", "enrichment", "webhook", "rest"],
    graph: apiEnrichGraph,
  },
  {
    key: "github-issue-triage",
    name: "GitHub issue triage & act",
    description:
      "When a GitHub issue is opened, an agent triages it (summary, labels, priority) and acts back on the issue via your GitHub connection — posting the triage as a comment and applying the labels.",
    category: "github",
    tags: ["issue-triage", "labelling", "webhook", "mcp"],
    graph: githubIssueTriageGraph,
  },
  {
    key: "jira-ticket",
    name: "Jira ticket from an intake",
    description:
      "Turn an inbound request (bug report, feature ask, support message) into a structured Jira ticket. An agent drafts it, a human approves it, then it's created in Jira via your connection.",
    category: "jira",
    tags: ["intake", "ticketing", "human-approval", "mcp"],
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
    // ADDITIVE projection: key/name/description/nodeCount keep their exact meaning and
    // type, so an existing GET /templates consumer is unaffected (#574 AC).
    return TEMPLATES.map(
      ({ key, name, description, category, tags, graph }) => ({
        key,
        name,
        description,
        nodeCount: graph.nodes.length,
        category,
        tags: [...tags],
      }),
    );
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
      category: t.category,
      tags: [...t.tags],
      graph: t.graph,
    };
  }
}
