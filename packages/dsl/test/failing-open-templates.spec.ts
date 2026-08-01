import { describe, expect, it } from "vitest";
import {
  FAILING_OPEN_FINGERPRINTS,
  matchFailingOpenFork,
  migrateFailingOpenFork,
} from "../src/failing-open-templates";
import { lintAgentOutputContract } from "../src/agent-output-contract";
import { nextNodes } from "../src/branch";
import { canonicalize } from "../src/canonical";
import {
  githubIssueTriageGraph,
  jiraTicketGraph,
  moderationGraph,
} from "../src/templates";
import { validateGraph } from "../src/validate-graph";
import type { GraphDef } from "../src/types";

/**
 * THE FROZEN ARTIFACT (#1016).
 *
 * `moderationGraph` EXACTLY as it shipped before #1015 — copied from
 * `git show a3515db7^:packages/dsl/src/templates.ts`. This is the graph a tenant who used the
 * "Content moderation gate" template has sitting in their workspace right now: the agent asks
 * for JSON in the prompt and declares no `outputSchema`, and the two edges below branch on a
 * field that therefore never exists.
 *
 * Frozen on purpose. The fingerprints derive their topology from the LIVE template so the
 * replacement schema can never drift from what a fresh instantiation gets — this fixture is what
 * makes that safe, by failing loudly if a future template redesign moves the shape the migration
 * is supposed to recognise.
 */
const LEGACY_MODERATION: GraphDef = {
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

/** Rebuild the pre-#1015 fork of a shipped template: its legacy prompt, and no `outputSchema`. */
function legacyForkOf(template: GraphDef, agentNodeId: string): GraphDef {
  const fp = FAILING_OPEN_FINGERPRINTS.find(
    (f) => f.agentNodeId === agentNodeId,
  );
  if (!fp) throw new Error(`no fingerprint for "${agentNodeId}"`);
  return {
    ...template,
    nodes: template.nodes.map((n) => {
      if (n.id !== agentNodeId) return n;
      const { outputSchema: _dropped, ...rest } = (n.config ?? {}) as Record<
        string,
        unknown
      >;
      return { ...n, config: { ...rest, systemPrompt: fp.legacySystemPrompt } };
    }),
  };
}

/** A deep clone with one node's config patched — for building lookalikes. */
function withNodeConfig(
  graph: GraphDef,
  nodeId: string,
  patch: Record<string, unknown>,
): GraphDef {
  return {
    ...graph,
    nodes: graph.nodes.map((n) =>
      n.id === nodeId ? { ...n, config: { ...(n.config ?? {}), ...patch } } : n,
    ),
  };
}

/**
 * THE SYMPTOM, NOT THE MECHANISM (#830's distinction, applied).
 *
 * Asserting "the migrated node has an outputSchema field" tests the mechanism. What was actually
 * broken is where a submission GOES — so this drives the interpreter's REAL edge selector,
 * `nextNodes`, the function `run-graph.ts` calls at every transition, over the graph as saved.
 *
 * The coupling that makes it a symptom test rather than a restatement is [[agentOutput]]: the
 * ctx is DERIVED from the node's own config, exactly as the activity derives it. Hand-feeding
 * `{ flagged: true }` to both graphs would route correctly through both — the edges were never
 * the bug — and the test would pass with the migration deleted.
 */

/**
 * The agent activity's output contract, modelled (`apps/worker/src/temporal/activities/agent.ts`
 * — `wantStructured = effectiveOutputSchema !== undefined`, and #450 removed the hardcoded
 * fallback schema):
 *
 *   - a node WITH an `outputSchema` returns an object carrying the fields it declares;
 *   - a node WITHOUT one returns free text as `{ text }` — whatever the prompt asked for.
 *
 * So the same model verdict lands in ctx differently depending only on what the node declares,
 * which is precisely what the migration changes and precisely what the routing then depends on.
 */
function agentOutput(
  graph: GraphDef,
  nodeId: string,
  verdict: Record<string, unknown>,
): Record<string, unknown> {
  const cfg = graph.nodes.find((n) => n.id === nodeId)?.config as
    { outputSchema?: { properties?: Record<string, unknown> } } | undefined;
  const props = cfg?.outputSchema?.properties;
  if (!props) return { text: JSON.stringify(verdict) };
  return Object.fromEntries(
    Object.entries(verdict).filter(([k]) => k in props),
  );
}

describe("moderationGraph forks — the gate that failed OPEN", () => {
  /** What the classifier decided. The model does its job correctly in every case below; the
   *  question is only whether the graph can hear the answer. */
  const UNSAFE = { flagged: true, reason: "abusive" };
  const CLEAN = { flagged: false, reason: "clean" };

  /** Route a submission through the graph as saved: run the agent, then pick the next node. */
  const routeOf = (graph: GraphDef, verdict: Record<string, unknown>) =>
    nextNodes(graph, "classify", {
      classify: { output: agentOutput(graph, "classify", verdict) },
    });

  it("BEFORE: the classifier says UNSAFE and the submission is auto-accepted anyway", () => {
    expect(routeOf(LEGACY_MODERATION, UNSAFE)).toEqual(["accepted"]);
  });

  it("BEFORE: `review` is unreachable — NO verdict can select it", () => {
    for (const verdict of [UNSAFE, CLEAN, { flagged: true }, {}]) {
      expect(routeOf(LEGACY_MODERATION, verdict)).not.toContain("review");
    }
  });

  it("AFTER: the same UNSAFE verdict reaches `review`", () => {
    const fixed = migrateFailingOpenFork(LEGACY_MODERATION)!.graph;
    expect(routeOf(fixed, UNSAFE)).toEqual(["review"]);
  });

  it("AFTER: a CLEAN verdict still reaches `accepted` — the branch is fixed, not inverted", () => {
    const fixed = migrateFailingOpenFork(LEGACY_MODERATION)!.graph;
    expect(routeOf(fixed, CLEAN)).toEqual(["accepted"]);
  });
});

describe("matchFailingOpenFork — MIGRATE only an exact fork", () => {
  it("matches the frozen pre-#1015 moderation graph", () => {
    expect(matchFailingOpenFork(LEGACY_MODERATION)?.templateKey).toBe(
      "moderation",
    );
  });

  it("covers all three templates #1015 fixed", () => {
    const cases: [GraphDef, string, string][] = [
      [moderationGraph, "classify", "moderation"],
      [githubIssueTriageGraph, "triage", "github-issue-triage"],
      [jiraTicketGraph, "structure", "jira-ticket"],
    ];
    for (const [template, agentNodeId, key] of cases) {
      const fork = legacyForkOf(template, agentNodeId);
      expect(matchFailingOpenFork(fork)?.templateKey, key).toBe(key);
    }
  });

  it("the fingerprint's topology still describes the frozen artifact — a template redesign must not silently narrow the match", () => {
    const fp = FAILING_OPEN_FINGERPRINTS.find(
      (f) => f.templateKey === "moderation",
    )!;
    expect(fp.startNodeId).toBe(LEGACY_MODERATION.startNodeId);
    expect(fp.nodes).toEqual(
      LEGACY_MODERATION.nodes.map((n) => ({ id: n.id, type: n.type })),
    );
    expect(fp.edges).toEqual(LEGACY_MODERATION.edges);
  });

  it("every fingerprint resolves a real replacement schema from its live template", () => {
    for (const fp of FAILING_OPEN_FINGERPRINTS) {
      expect(
        Object.keys(
          (fp.outputSchema?.properties as Record<string, unknown>) ?? {},
        ).length,
        fp.templateKey,
      ).toBeGreaterThan(0);
    }
  });

  it("tolerates a fork with EXTRA nodes and edges — still the same broken gate", () => {
    const extended: GraphDef = {
      ...LEGACY_MODERATION,
      nodes: [
        ...LEGACY_MODERATION.nodes,
        { id: "audit", type: "httpRequest", config: { url: "https://x/log" } },
      ],
      edges: [
        ...LEGACY_MODERATION.edges,
        { from: "classify", to: "audit" },
        { from: "audit", to: "end" },
      ],
    };
    expect(matchFailingOpenFork(extended)?.templateKey).toBe("moderation");
  });

  describe("does NOT touch a lookalike", () => {
    const cases: [string, GraphDef][] = [
      [
        "the prompt was edited — the author took ownership of this node",
        withNodeConfig(LEGACY_MODERATION, "classify", {
          systemPrompt:
            'Classify the submitted content for policy violations. Respond with a JSON object: { "flagged": boolean, "reason": string }. Flag anything unsafe, spammy, abusive, or off-topic for our forum.',
        }),
      ],
      [
        "the prompt differs by a single trailing space",
        withNodeConfig(LEGACY_MODERATION, "classify", {
          systemPrompt: `${
            FAILING_OPEN_FINGERPRINTS.find((f) => f.agentNodeId === "classify")!
              .legacySystemPrompt
          } `,
        }),
      ],
      [
        "the node already declares its own outputSchema",
        withNodeConfig(LEGACY_MODERATION, "classify", {
          outputSchema: {
            type: "object",
            properties: { verdict: { type: "string" } },
          },
        }),
      ],
      [
        "an edge condition was rewritten",
        {
          ...LEGACY_MODERATION,
          edges: LEGACY_MODERATION.edges.map((e) =>
            e.to === "review"
              ? {
                  ...e,
                  condition: {
                    path: "classify.output.flagged",
                    op: "exists" as const,
                  },
                }
              : e,
          ),
        },
      ],
      [
        "the review branch was deleted",
        {
          ...LEGACY_MODERATION,
          edges: LEGACY_MODERATION.edges.filter((e) => e.to !== "review"),
        },
      ],
      [
        "a node kept its id but changed type",
        {
          ...LEGACY_MODERATION,
          nodes: LEGACY_MODERATION.nodes.map((n) =>
            n.id === "review" ? { ...n, type: "end" as const } : n,
          ),
        },
      ],
      [
        "a different entry node",
        { ...LEGACY_MODERATION, startNodeId: "classify" },
      ],
      [
        // The case the whole clause-7 read check exists for: this author noticed the gate was
        // broken and routed on the FREE TEXT instead. Giving them a schema would delete the
        // `text` field their working workflow depends on.
        "the author worked AROUND the bug by reading classify.output.text",
        {
          ...LEGACY_MODERATION,
          nodes: [
            ...LEGACY_MODERATION.nodes,
            {
              id: "notify",
              type: "mcpTool",
              config: {
                connectionId: "slack",
                tool: "post",
                argumentBindings: {
                  text: { from: "classify", path: "output.text" },
                },
              },
            },
          ],
          edges: [
            ...LEGACY_MODERATION.edges,
            { from: "classify", to: "notify" },
          ],
        },
      ],
    ];

    for (const [name, graph] of cases) {
      it(name, () => {
        expect(matchFailingOpenFork(graph)).toBeNull();
        expect(migrateFailingOpenFork(graph)).toBeNull();
      });
    }
  });

  it("a legitimately free-text agent is not a fork of anything", () => {
    const freeText: GraphDef = {
      startNodeId: "trigger",
      nodes: [
        { id: "trigger", type: "webhookTrigger" },
        {
          id: "classify",
          type: "agent",
          config: {
            provider: "anthropic",
            model: "claude-opus-4-8",
            systemPrompt: "Write a friendly one-paragraph reply.",
          },
        },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "trigger", to: "classify" },
        { from: "classify", to: "end" },
      ],
    };
    expect(matchFailingOpenFork(freeText)).toBeNull();
  });
});

describe("migrateFailingOpenFork — exactly the schema, nothing else", () => {
  it("adds the schema the shipped template carries today", () => {
    const cases: [GraphDef, string][] = [
      [moderationGraph, "classify"],
      [githubIssueTriageGraph, "triage"],
      [jiraTicketGraph, "structure"],
    ];
    for (const [template, agentNodeId] of cases) {
      const fixed = migrateFailingOpenFork(
        legacyForkOf(template, agentNodeId),
      )!.graph;
      const got = (
        fixed.nodes.find((n) => n.id === agentNodeId)!.config as {
          outputSchema: unknown;
        }
      ).outputSchema;
      const want = (
        template.nodes.find((n) => n.id === agentNodeId)!.config as {
          outputSchema: unknown;
        }
      ).outputSchema;
      expect(got, agentNodeId).toEqual(want);
    }
  });

  it("changes NOTHING else — the version diff a tenant sees is one added field", () => {
    const fixed = migrateFailingOpenFork(LEGACY_MODERATION)!.graph;
    const strip = (g: GraphDef): GraphDef => ({
      ...g,
      nodes: g.nodes.map((n) => {
        if (n.id !== "classify") return n;
        const { outputSchema: _s, ...rest } = (n.config ?? {}) as Record<
          string,
          unknown
        >;
        return { ...n, config: rest };
      }),
    });
    expect(canonicalize(strip(fixed))).toBe(
      canonicalize(strip(LEGACY_MODERATION)),
    );
  });

  it("does NOT rewrite the legacy prompt — the schema is the fix; anything more is an edit the author did not ask for", () => {
    const fixed = migrateFailingOpenFork(LEGACY_MODERATION)!.graph;
    const cfg = fixed.nodes.find((n) => n.id === "classify")!.config as {
      systemPrompt: string;
    };
    expect(cfg.systemPrompt).toBe(
      'Classify the submitted content for policy violations. Respond with a JSON object: { "flagged": boolean, "reason": string }. Flag anything unsafe, spammy, or abusive.',
    );
  });

  it("never mutates the input graph", () => {
    const before = canonicalize(LEGACY_MODERATION);
    migrateFailingOpenFork(LEGACY_MODERATION);
    expect(canonicalize(LEGACY_MODERATION)).toBe(before);
  });

  it("IDEMPOTENT — a migrated graph is no longer a match, so a second run mints no second version", () => {
    const once = migrateFailingOpenFork(LEGACY_MODERATION)!.graph;
    expect(matchFailingOpenFork(once)).toBeNull();
    expect(migrateFailingOpenFork(once)).toBeNull();
  });

  it("the result is a graph the save gate accepts", () => {
    for (const [template, agentNodeId] of [
      [moderationGraph, "classify"],
      [githubIssueTriageGraph, "triage"],
      [jiraTicketGraph, "structure"],
    ] as [GraphDef, string][]) {
      const fixed = migrateFailingOpenFork(
        legacyForkOf(template, agentNodeId),
      )!.graph;
      expect(validateGraph(fixed), agentNodeId).toEqual({ valid: true });
    }
  });

  it("the shipped templates are already correct — running this over today's templates is a no-op", () => {
    for (const g of [
      moderationGraph,
      githubIssueTriageGraph,
      jiraTicketGraph,
    ]) {
      expect(migrateFailingOpenFork(g)).toBeNull();
    }
  });
});

/**
 * THE NOTIFY HALF. Liberal where the migration is narrow: everything the predicate declines
 * should still reach its author, as a warning next to the node — never as an edit, and never as
 * a save rejection.
 */
describe("lintAgentOutputContract — NOTIFY the broader shape", () => {
  const nodeIds = (g: GraphDef) =>
    lintAgentOutputContract(g).map((w) => w.nodeId);

  it("fires on the lookalike the migration deliberately refused to touch", () => {
    const edited = withNodeConfig(LEGACY_MODERATION, "classify", {
      systemPrompt:
        'Classify this. Respond with ONLY a JSON object: { "flagged": boolean }. Our house rules apply.',
    });
    expect(matchFailingOpenFork(edited)).toBeNull(); // not migrated…
    expect(nodeIds(edited)).toContain("classify"); // …but the author is told
  });

  it("names the guaranteed-undefined read, not just the prompt", () => {
    const [first] = lintAgentOutputContract(LEGACY_MODERATION);
    expect(first.nodeId).toBe("classify");
    expect(first.ref).toBe("classify.output.flagged");
    expect(first.message).toContain("undefined at run time");
  });

  it("does NOT fire on a legitimately free-text agent", () => {
    const g: GraphDef = {
      startNodeId: "trigger",
      nodes: [
        { id: "trigger", type: "webhookTrigger" },
        {
          id: "draft",
          type: "agent",
          config: { systemPrompt: "Draft a warm reply to the customer." },
        },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "trigger", to: "draft" },
        { from: "draft", to: "end" },
      ],
    };
    expect(lintAgentOutputContract(g)).toEqual([]);
  });

  it("does NOT fire when JSON is the INPUT rather than the requested output", () => {
    const g: GraphDef = {
      startNodeId: "trigger",
      nodes: [
        { id: "trigger", type: "webhookTrigger" },
        {
          id: "explain",
          type: "agent",
          config: {
            systemPrompt:
              "Summarize the JSON payload you are given in plain English for a non-technical reader.",
          },
        },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "trigger", to: "explain" },
        { from: "explain", to: "end" },
      ],
    };
    expect(lintAgentOutputContract(g)).toEqual([]);
  });

  it("does NOT fire on `output.text` — a schema-less agent genuinely promises that", () => {
    const g: GraphDef = {
      startNodeId: "trigger",
      nodes: [
        { id: "trigger", type: "webhookTrigger" },
        {
          id: "draft",
          type: "agent",
          config: { systemPrompt: "Draft a reply." },
        },
        {
          id: "send",
          type: "mcpTool",
          config: {
            connectionId: "slack",
            tool: "post",
            argumentBindings: { text: { from: "draft", path: "output.text" } },
          },
        },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "trigger", to: "draft" },
        { from: "draft", to: "send" },
        { from: "send", to: "end" },
      ],
    };
    expect(lintAgentOutputContract(g)).toEqual([]);
  });

  it("goes QUIET once the graph is migrated — that is how the tenant sees it fixed", () => {
    const fixed = migrateFailingOpenFork(LEGACY_MODERATION)!.graph;
    expect(lintAgentOutputContract(fixed)).toEqual([]);
  });

  it("is silent on every shipped template — #1015 fixed them all", () => {
    for (const g of [
      moderationGraph,
      githubIssueTriageGraph,
      jiraTicketGraph,
    ]) {
      expect(lintAgentOutputContract(g)).toEqual([]);
    }
  });

  it("reports at most one row per agent — the read beats the prompt heuristic", () => {
    // LEGACY_MODERATION trips BOTH reasons (its prompt asks for JSON *and* the edges read a
    // field it never promised). One node, one row: a duplicate would be noise in the panel.
    expect(nodeIds(LEGACY_MODERATION)).toEqual(["classify"]);
  });
});
