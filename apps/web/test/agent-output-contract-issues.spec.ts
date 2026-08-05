import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  lintAgentOutputContract,
  matchFailingOpenFork,
  type GraphDef,
} from "@naary/dsl";
import { compileGraph } from "../src/lib/compile-graph";
import { decompileGraph } from "../src/lib/decompile-graph";
import type { CanvasEdge, CanvasNode } from "../src/lib/graph-model";
import type { CanvasIssue } from "../src/screens/canvas/CanvasIssuesPanel";

/**
 * THE NOTIFY HALF OF #1016, on the canvas.
 *
 * An agent returns structured fields ONLY when its config carries an `outputSchema`. A graph
 * that asks for JSON in the prompt and then branches on `agent.output.<field>` branches on a
 * field that can never exist — the bug that made the shipped `moderation` template's gate fail
 * OPEN, auto-accepting every submission with the human-review branch unreachable.
 *
 * #1016 MIGRATES only graphs that are recognisably a fork of a shipped template. Everything
 * merely similar is NOTIFIED and never edited, because a free-text agent whose prompt happens to
 * mention JSON is a legitimate authoring choice. The issues panel is that channel, so this
 * exercises the real path into it: canvas nodes → `compileGraph` → the lint → a `CanvasIssue`.
 */

const at = (x: number) => ({ x, y: 0 });

/** A moderation-shaped canvas whose agent asks for JSON and declares no schema. */
const NODES: CanvasNode[] = [
  { id: "trigger", type: "webhookTrigger", position: at(0) },
  {
    id: "classify",
    type: "agent",
    position: at(1),
    config: {
      provider: "anthropic",
      model: "claude-opus-4-8",
      systemPrompt:
        'Classify the submission. Respond with a JSON object: { "flagged": boolean }.',
    },
  },
  { id: "review", type: "humanApproval", position: at(2) },
  { id: "end", type: "end", position: at(3) },
];
const EDGES: CanvasEdge[] = [
  { id: "e1", source: "trigger", target: "classify" },
  {
    id: "e2",
    source: "classify",
    target: "review",
    // A CANVAS edge, so the condition is an EdgeConditionDraft and its `value` is the raw
    // text the user typed — `compileGraph` is what turns "true" into a boolean (see the
    // round-trip test below). The fixture said `true`, which is not an EdgeConditionDraft.
    condition: { path: "classify.output.flagged", op: "eq", value: "true" },
  },
  { id: "e3", source: "classify", target: "end" },
];

/** The panel's own mapping, from useCanvasDerivations' `templateWarnings` branch. */
function asIssues(nodes: CanvasNode[], edges: CanvasEdge[]): CanvasIssue[] {
  const { graph } = compileGraph(nodes, edges);
  if (!graph) throw new Error("canvas did not compile");
  return lintAgentOutputContract(graph).map((w) => ({
    nodeId: w.nodeId,
    field: w.field as string | undefined,
    ref: w.ref as string | undefined,
    message: w.message,
    kind: "reference" as const,
  }));
}

describe("the issues panel surfaces a missing agent output contract", () => {
  it("raises a row against the AGENT — that is where the schema goes, and clicking the row jumps there", () => {
    const issues = asIssues(NODES, EDGES);
    expect(issues).toHaveLength(1);
    expect(issues[0].nodeId).toBe("classify");
    expect(issues[0].field).toBe("outputSchema");
    expect(issues[0].ref).toBe("classify.output.flagged");
    expect(issues[0].message).toContain("undefined at run time");
  });

  it("goes quiet once the author adds the schema — the row is a fix, not a permanent scold", () => {
    const fixed = NODES.map((n) =>
      n.id === "classify"
        ? {
            ...n,
            config: {
              ...n.config,
              outputSchema: {
                type: "object",
                properties: { flagged: { type: "boolean" } },
              },
            },
          }
        : n,
    );
    expect(asIssues(fixed, EDGES)).toEqual([]);
  });

  it("says nothing about an ordinary free-text agent", () => {
    const plain: CanvasNode[] = [
      { id: "trigger", type: "webhookTrigger", position: at(0) },
      {
        id: "draft",
        type: "agent",
        position: at(1),
        config: { systemPrompt: "Write a short, friendly acknowledgement." },
      },
      { id: "end", type: "end", position: at(2) },
    ];
    const plainEdges: CanvasEdge[] = [
      { id: "e1", source: "trigger", target: "draft" },
      { id: "e2", source: "draft", target: "end" },
    ];
    expect(asIssues(plain, plainEdges)).toEqual([]);
  });
});

/**
 * THE POPULATION THE MIGRATION HAS TO REACH.
 *
 * A fork installed from the Templates screen is saved byte-for-byte. A fork the author has
 * OPENED AND RE-SAVED went through `decompileGraph` → canvas → `compileGraph`, and that round
 * trip rebuilds every edge condition from an editor draft: `{ value: true }` becomes the string
 * `"true"` on the way out and is re-coerced on the way back.
 *
 * `matchFailingOpenFork` compares conditions structurally, so if that round trip changed a
 * `true` into a `"true"` the predicate would quietly stop matching — and the migration would
 * miss most of the graphs it exists for while every test above still passed. Nothing would look
 * broken, which is the signature of this whole class of bug.
 */
describe("a fork survives the canvas round trip and is still recognised", () => {
  /** `moderationGraph` as it shipped BEFORE #1015 — the shape a fork carries. */
  const LEGACY: GraphDef = {
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

  const roundTripped = (): GraphDef => {
    const draft = decompileGraph(LEGACY);
    const { graph, error } = compileGraph(draft.nodes, draft.edges);
    if (!graph) throw new Error(error ?? "canvas did not compile");
    return graph;
  };

  it('the boolean edge values survive as booleans, not as the string "true"', () => {
    const cond = roundTripped().edges.find(
      (e) => e.to === "review",
    )!.condition!;
    expect(cond.value).toBe(true);
    expect(cond.op).toBe("eq");
    expect(cond.path).toBe("classify.output.flagged");
  });

  it("is still an exact fork after being opened and re-saved on the canvas", () => {
    expect(matchFailingOpenFork(roundTripped())?.templateKey).toBe(
      "moderation",
    );
  });
});

/**
 * The lint is only useful if the canvas actually calls it. This is a composition the type
 * checker cannot enforce — dropping the call compiles fine and the panel simply goes silent,
 * which is precisely the failure mode #1016 is about.
 */
describe("the canvas wires the lint in", () => {
  const src = readFileSync(
    resolve(__dirname, "../src/screens/canvas/useCanvasDerivations.ts"),
    "utf8",
  ).replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ""); // strip comments: prose must not satisfy this

  it("composes lintAgentOutputContract into the panel's warning list", () => {
    expect(src).toContain("lintAgentOutputContract(graph)");
    // Alongside the other two linters, in the same memo that feeds `allIssues`.
    const memo = /const templateWarnings = useMemo\(([\s\S]*?)\n  \);/.exec(
      src,
    );
    expect(memo, "templateWarnings memo not found").not.toBeNull();
    expect(memo![1]).toContain("lintTemplates(graph)");
    expect(memo![1]).toContain("lintBindings(graph)");
    expect(memo![1]).toContain("lintAgentOutputContract(graph)");
  });

  it("is NOT wired into the save gate — a warning must never start rejecting saved workflows", () => {
    const service = readFileSync(
      resolve(__dirname, "../../../apps/api/src/graphs/graphs.service.ts"),
      "utf8",
    );
    expect(service).not.toContain("lintAgentOutputContract");
  });
});
