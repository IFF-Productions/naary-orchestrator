import { Controller, Get } from "@nestjs/common";
import type { GraphDef } from "@naary/dsl";
import { githubReviewGraph, sampleGraph, webhookSampleGraph } from "@naary/dsl";

/** A built-in workflow template, surfaced to the Templates screen. */
export interface TemplateSummary {
  key: string;
  name: string;
  description: string;
  nodeCount: number;
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
      "Reviews a pull request, comments back via an MCP connection, then requires approval before merge.",
    graph: githubReviewGraph,
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
}
