import { describe, expect, it } from "vitest";
import {
  handoffConditionPath,
  supervisorHandoffGraph,
  validateGraph,
  type AgentHandoff,
} from "@naary/dsl";
import { compileGraph } from "../src/lib/compile-graph";
import { decompileGraph } from "../src/lib/decompile-graph";

/**
 * The canvas round-trip is the ENTIRE risk surface for `handoff` (#580 Phase 1), because
 * there is no canvas UI to author one: the only way a user ever has a handoff is to install
 * the supervisor template, open it on the canvas, and save. `handoff` is an *unmodeled* key
 * as far as the canvas is concerned — no field editor knows about it — so it only survives
 * because the editor preserves config it doesn't understand.
 *
 * Two failure modes, and the first is silent, which is why it's worth a dedicated test:
 *
 *  1. If the canvas ever drops `handoff` on save, `validateHandoffs` finds no handoff and
 *     happily passes — but the three edges still condition on `<supervisor>.output.target`,
 *     which a schema-less agent never produces. Every condition fails, the run stops at the
 *     supervisor, and NOTHING errors. A working template quietly becomes a no-op.
 *  2. If the condition round-trip (`draftFromCondition` → `conditionFromDraft`) is lossy in
 *     path, op, or value, then an untouched re-save of an installed template 400s on the
 *     save-gate — which is strict about all three on purpose.
 *
 * The gate can't catch (1) itself: rejecting "edges route on `output.target` but the node
 * declares no handoff" would also reject a hand-written router agent whose own
 * `outputSchema` has a `target` field, i.e. it would newly fail graphs already saved. So the
 * invariant is pinned here instead, where breaking it fails a test rather than a user's run.
 */

const supervisorOf = (nodes: { id: string; config?: unknown }[]) =>
  nodes.find((n) => n.id === "supervisor");

describe("handoff survives the canvas round-trip", () => {
  it("compiles back to a graph the save-gate still accepts", () => {
    const { nodes, edges } = decompileGraph(supervisorHandoffGraph);
    const res = compileGraph(nodes, edges);

    expect(res.error).toBeUndefined();
    expect(res.graph).toBeDefined();
    // compile-graph runs the same validateGraph the API does; assert directly too.
    expect(validateGraph(res.graph!)).toEqual({ valid: true });
  });

  it("preserves the handoff block the canvas has no editor for", () => {
    const { nodes, edges } = decompileGraph(supervisorHandoffGraph);
    const compiled = compileGraph(nodes, edges).graph!;

    const original = (
      supervisorOf(supervisorHandoffGraph.nodes)?.config as {
        handoff: AgentHandoff;
      }
    ).handoff;
    const survived = (
      supervisorOf(compiled.nodes)?.config as {
        handoff?: AgentHandoff;
      }
    )?.handoff;

    // Deep-equal, not just present: a partial round-trip (e.g. losing target descriptions,
    // which feed the model's routing decision) is a silent quality regression.
    expect(survived).toEqual(original);
  });

  it("preserves each handoff edge's path, op AND value exactly", () => {
    const { nodes, edges } = decompileGraph(supervisorHandoffGraph);
    const compiled = compileGraph(nodes, edges).graph!;

    const before = supervisorHandoffGraph.edges.filter(
      (e) => e.from === "supervisor",
    );
    const after = compiled.edges.filter((e) => e.from === "supervisor");
    expect(after).toEqual(before);
    // …and they really are the canonical handoff shape, not coincidentally-equal junk.
    for (const e of after) {
      expect(e.condition?.path).toBe(handoffConditionPath("supervisor"));
      expect(e.condition?.op).toBe("eq");
    }
  });

  it("survives an inspector edit to the supervisor's other fields", () => {
    // CanvasPage.updateConfig applies a patch as `{ ...existingConfig, ...patch }`. This
    // models that: editing the prompt must not take the handoff with it. If someone ever
    // reworks the inspector to rebuild config from its known fields instead of spreading,
    // this is the test that fails.
    const { nodes, edges } = decompileGraph(supervisorHandoffGraph);
    const edited = nodes.map((n) =>
      n.id === "supervisor"
        ? { ...n, config: { ...n.config, systemPrompt: "Route it. Tersely." } }
        : n,
    );

    const compiled = compileGraph(edited, edges).graph!;
    expect(validateGraph(compiled)).toEqual({ valid: true });
    const cfg = supervisorOf(compiled.nodes)?.config as {
      handoff?: AgentHandoff;
      systemPrompt?: string;
    };
    expect(cfg?.systemPrompt).toBe("Route it. Tersely.");
    expect(cfg?.handoff?.targets).toHaveLength(3);
  });

  it("would REJECT the save if an edit broke a handoff edge (the gate still bites)", () => {
    // Sanity check on the negative: the round-trip tests above pass because the pipeline is
    // lossless, not because the gate stopped looking.
    const { nodes, edges } = decompileGraph(supervisorHandoffGraph);
    const broken = edges.map((e) =>
      e.source === "supervisor" && e.target === "technical"
        ? { ...e, data: undefined, condition: undefined }
        : e,
    );
    const res = compileGraph(nodes, broken);
    expect(res.error).toMatch(/unconditional|no edge to it|handoff/i);
  });
});
