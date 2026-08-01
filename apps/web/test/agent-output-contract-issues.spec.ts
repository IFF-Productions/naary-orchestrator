import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { lintAgentOutputContract } from "@naary/dsl";
import { compileGraph } from "../src/lib/compile-graph";
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
    condition: { path: "classify.output.flagged", op: "eq", value: true },
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
