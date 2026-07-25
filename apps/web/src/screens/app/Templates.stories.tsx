import type { Meta, StoryObj } from "@storybook/react-vite";
import { delay, http, HttpResponse } from "msw";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { codeAgentPrGraph, supervisorHandoffGraph } from "@naary/dsl";
import type { GraphDef } from "@naary/dsl";
import { ModeProvider } from "../../mode";
import { Templates } from "./Templates";

/**
 * Fixture graphs shaped exactly like the API's built-in templates (the DSL seed
 * graphs) — the screen derives chains, categories, approval badges, and the
 * teaching copy from these, so they must be structurally real.
 */
const webhookTriage: GraphDef = {
  startNodeId: "trigger",
  nodes: [
    { id: "trigger", type: "webhookTrigger" },
    {
      id: "agent",
      type: "agent",
      config: { provider: "anthropic", model: "claude-opus-4-8" },
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

const githubReview: GraphDef = {
  startNodeId: "trigger",
  nodes: [
    { id: "trigger", type: "webhookTrigger" },
    {
      id: "diff",
      type: "integration",
      config: {
        provider: "github",
        action: "get_pull_request",
        connectionId: "github",
      },
    },
    {
      id: "review",
      type: "agent",
      config: { provider: "anthropic", model: "claude-opus-4-8" },
    },
    {
      id: "comment",
      type: "integration",
      config: {
        provider: "github",
        action: "comment_issue",
        connectionId: "github",
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

const dbReport: GraphDef = {
  startNodeId: "start",
  nodes: [
    { id: "start", type: "start" },
    {
      id: "query",
      type: "sqlQuery",
      config: { connectionId: "app-db", sql: "SELECT 1" },
    },
    {
      id: "summarize",
      type: "agent",
      config: { provider: "anthropic", model: "claude-opus-4-8" },
    },
    {
      id: "email",
      type: "sendEmail",
      config: { connectionId: "smtp", subject: "Daily report" },
    },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "start", to: "query" },
    { from: "query", to: "summarize" },
    { from: "summarize", to: "email" },
    { from: "email", to: "end" },
  ],
};

const feedDigest: GraphDef = {
  startNodeId: "start",
  nodes: [
    { id: "start", type: "start" },
    { id: "feed", type: "rssRead", config: { url: "https://example.com/rss" } },
    {
      id: "digest",
      type: "agent",
      config: { provider: "anthropic", model: "claude-opus-4-8" },
    },
    {
      id: "email",
      type: "sendEmail",
      config: { connectionId: "smtp", subject: "Digest" },
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

const TEMPLATES: {
  key: string;
  name: string;
  description: string;
  graph: GraphDef;
}[] = [
  {
    key: "wf-default",
    name: "Webhook triage",
    description:
      "Webhook-triggered agent that summarizes the inbound event, then waits for approval.",
    graph: webhookTriage,
  },
  {
    key: "github-review",
    name: "GitHub PR review",
    description:
      "When a PR opens, fetch its diff, let an agent review the changes, post the review back, then a human sign-off.",
    graph: githubReview,
  },
  {
    key: "db-report",
    name: "Scheduled database report",
    description:
      "Run a read-only query against your database, turn the rows into a plain-language summary, and email it.",
    graph: dbReport,
  },
  {
    key: "feed-digest",
    name: "Feed digest by email",
    description:
      "Pull an RSS/Atom feed, let an agent write a skimmable digest, and email it.",
    graph: feedDigest,
  },
  {
    // The REAL shipped graph, imported from the DSL rather than re-fixtured — this is the
    // branching case (a supervisor fanning out to three specialists on conditional edges),
    // so it's what proves the read-only graph render draws branches and labels them.
    key: "supervisor-handoff",
    name: "Supervisor & specialist agents",
    description:
      "A supervisor agent reads an inbound request and hands it to exactly one specialist with a typed brief; that specialist answers and the reply is returned synchronously.",
    graph: supervisorHandoffGraph,
  },
  {
    // Also the REAL graph: it is the one template with a WRITE-mode codeAgent (whose
    // subtitle used to claim "read-only") and the one with an explicit decline branch.
    key: "code-agent-pr",
    name: "Issue to approved plan to pull request",
    description:
      "An agent judges whether an issue is safe to attempt and writes the plan; a human approves it; only then does the code agent open a PR. Capped in dollars and turns.",
    graph: codeAgentPrGraph,
  },
];

const summaries = TEMPLATES.map(({ key, name, description, graph }) => ({
  key,
  name,
  description,
  nodeCount: graph.nodes.length,
}));

const handlers = [
  http.get("*/api/templates", () => HttpResponse.json(summaries)),
  http.get("*/api/templates/:key", ({ params }) => {
    const t = TEMPLATES.find((x) => x.key === params.key);
    if (!t) return new HttpResponse(null, { status: 404 });
    return HttpResponse.json({ ...t, nodeCount: t.graph.nodes.length });
  }),
  // Install flow: no existing workflows → slug(name) is free; echo the saved key.
  http.get("*/api/graphs", () => HttpResponse.json([])),
  http.post("*/api/graphs", async ({ request }) => {
    const body = (await request.json()) as { workflowKey: string };
    return HttpResponse.json({
      workflowKey: body.workflowKey,
      version: 1,
      contentHash: "sb-hash",
    });
  }),
];

const meta: Meta<typeof Templates> = {
  title: "Screens/Templates",
  component: Templates,
  parameters: {
    layout: "fullscreen",
    msw: { handlers },
    router: { initialEntries: ["/app/templates"] },
  },
  decorators: [
    (Story) => (
      <ModeProvider>
        <div style={{ background: "var(--bg)", minHeight: "100vh" }}>
          <Story />
        </div>
      </ModeProvider>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof Templates>;

/** The gallery: teaching hero, derived category chips with counts, chain strips. */
export const Gallery: Story = {};

/** Shimmer skeletons while the template graphs load. */
export const Loading: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/api/templates", async () => {
          await delay("infinite");
          return HttpResponse.json([]);
        }),
      ],
    },
  },
};

/** The preview modal — flow list + derived "what you'll learn" + honest install CTA. */
export const Preview: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = await canvas.findByRole("button", {
      name: /Preview GitHub PR review/,
    });
    await userEvent.click(card);
    // Portal-free modal renders inside the story root.
    const dialog = await canvas.findByRole("dialog");
    await waitFor(() =>
      expect(within(dialog).getByText(/What you.ll learn/)).toBeTruthy(),
    );
    await expect(
      within(dialog).getByRole("button", { name: /Install template/ }),
    ).toBeTruthy();
  },
};

/**
 * The preview of a BRANCHING template (#574 + #580): the read-only graph must show the
 * supervisor fanning out to three specialists, with each conditional edge labelled by its
 * real condition — the check that the diagram reports structure rather than a straight line.
 */
export const PreviewBranchingGraph: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", {
        name: /Preview Supervisor & specialist agents/,
      }),
    );
    const dialog = await canvas.findByRole("dialog");
    // The lazily-imported react-flow chunk has to land before nodes exist.
    await waitFor(
      () =>
        expect(
          dialog.querySelectorAll(".react-flow__node").length,
        ).toBeGreaterThan(5),
      { timeout: 5000 },
    );
    // Three conditional handoff edges, each labelled with the target it routes to.
    const labels = [...dialog.querySelectorAll(".react-flow__edge-text")].map(
      (e) => e.textContent,
    );
    await expect(labels).toContain("billing_specialist");
    await expect(labels).toContain("technical_specialist");
  },
};

/** Full install: preview → Install template → the staggered success walkthrough. */
export const InstalledSuccess: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = await canvas.findByRole("button", {
      name: /Preview Webhook triage/,
    });
    await userEvent.click(card);
    const dialog = await canvas.findByRole("dialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: /Install template/ }),
    );
    await canvas.findByText(/Webhook triage installed/);
    // The four-beat walkthrough (this template has an approval, so all beats show).
    await expect(canvas.getByText("TRIGGER")).toBeTruthy();
    await expect(canvas.getByText("APPROVAL")).toBeTruthy();
    await expect(
      canvas.getByRole("button", { name: /Open in canvas/ }),
    ).toBeTruthy();
  },
};

/** A template without an approval node — the APPROVAL beat collapses away. */
export const InstalledNoApproval: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = await canvas.findByRole("button", {
      name: /Preview Scheduled database report/,
    });
    await userEvent.click(card);
    const dialog = await canvas.findByRole("dialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: /Install template/ }),
    );
    await canvas.findByText(/Scheduled database report installed/);
    await waitFor(() => expect(canvas.queryByText("APPROVAL")).toBeNull());
  },
};

/**
 * The code-agent template's preview. Two things this pins that no other story does: a
 * WRITE-mode codeAgent must not be subtitled "read-only" (it clones a repo and can open a
 * pull request), and the decline branch (`attempt` false) must be drawn and labelled rather
 * than dead-ending.
 */
export const PreviewCodeAgent: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", {
        name: /Preview Issue to approved plan/,
      }),
    );
    const dialog = await canvas.findByRole("dialog");
    await waitFor(
      () =>
        expect(
          dialog.querySelectorAll(".react-flow__node").length,
        ).toBeGreaterThan(4),
      { timeout: 5000 },
    );
    const shown = dialog.textContent ?? "";
    await expect(shown).toContain("write");
    await expect(shown).not.toContain("read-only");
    // Both branches off the plan node are conditional, and both are labelled.
    const labels = [...dialog.querySelectorAll(".react-flow__edge-text")].map(
      (e) => e.textContent,
    );
    await expect(labels).toContain("attempt = true");
    await expect(labels).toContain("attempt ≠ true");
  },
};
