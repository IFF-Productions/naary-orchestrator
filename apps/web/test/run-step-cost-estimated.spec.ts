/**
 * Run detail must not present an ESTIMATE as a MEASUREMENT (#1069).
 *
 * A step whose provider reported no token usage still gets a cost, because Tier-1 rule 6 says a
 * silently-free call is worse than an approximate one. But the number that results is a different
 * KIND of claim from a metered one, and run detail is the screen where someone asks "what did this
 * actually cost?" — so the two must not render identically.
 *
 * The three properties below are the ones that can regress silently:
 *
 *   1. the marker appears when the ledger says estimated,
 *   2. it does NOT appear otherwise — including when we simply don't know, which is every
 *      pre-#1060 run and every node type that never bills, and
 *   3. it does not travel through the node's OUTPUT, so `SAFE_OUTPUT_FIELDS` is not widened.
 *
 * (3) is the one worth stating out loud. The allowlist is what keeps output CONTENT out of a log
 * line; the provenance flag comes from the usage ledger joined on (executionId, nodeId), never
 * from the node's result, so it must ride the step and leave that list alone.
 */
import { describe, expect, it } from "vitest";
import {
  buildNodeLogRows,
  safeFields,
} from "../src/screens/app/run-detail/NodeLogRows";
import { nodeEstimated } from "../src/screens/app/run-detail/run-view-model";
import type { TimelineStep } from "../src/screens/app/run-detail/StepTimeline";

const step = (p: Partial<TimelineStep> & { id: string }): TimelineStep => ({
  label: p.id,
  icon: "workflow",
  accent: "var(--ink-3)",
  state: "done",
  duration: null,
  durationMs: null,
  cost: null,
  ...p,
});

/** An agent output as it reaches the run ctx: cost and tokens, and no idea which kind they are. */
const AGENT_OUT = {
  model: "claude-opus-4-8",
  totalTokens: 900,
  costUsd: 0.004,
};

describe("nodeEstimated — reading the ledger provenance map", () => {
  const MAP = {
    "agent-1": { estimated: true },
    "agent-2": { estimated: false },
    // The API types this map as an unknown record (it matches the generated schema), so the read
    // has to survive anything that could actually arrive on the wire.
    weird: "not an object",
    nully: null,
  } as Record<string, unknown>;

  it("says true only on an explicit estimated:true", () => {
    expect(nodeEstimated(MAP, "agent-1")).toBe(true);
    expect(nodeEstimated(MAP, "agent-2")).toBe(false);
  });

  it("says false — not undefined, not a throw — for anything it cannot read", () => {
    // These all mean "no claim". Collapsing them to false is what keeps an unmarked step from
    // being an assertion: the UI marks estimated and stays silent about everything else.
    expect(nodeEstimated(MAP, "never-billed")).toBe(false);
    expect(nodeEstimated(MAP, "weird")).toBe(false);
    expect(nodeEstimated(MAP, "nully")).toBe(false);
    expect(nodeEstimated(null, "agent-1")).toBe(false); // a run predating the field
    expect(nodeEstimated(undefined, "agent-1")).toBe(false);
  });
});

describe("execution-log rows — estimated vs measured token cost", () => {
  it("marks a step the ledger flagged as estimated", () => {
    const rows = buildNodeLogRows({
      steps: [step({ id: "agent-1", costEstimated: true })],
      ctx: { "agent-1": AGENT_OUT },
      nodeTimes: null,
    });
    // The figures stay — an estimate is still the best answer we have — but the line says so.
    expect(rows[0].label).toContain("tokens=900");
    expect(rows[0].label).toContain("cost=$0.0040");
    expect(rows[0].label).toContain("est. tokens");
  });

  it("leaves a MEASURED step's row byte-for-byte unchanged", () => {
    // The regression this guards: qualifying the estimated case is worthless if the qualifier
    // also lands on metered rows — the two would be indistinguishable again, just noisier.
    const args = {
      steps: [step({ id: "agent-1" })],
      ctx: { "agent-1": AGENT_OUT },
      nodeTimes: null,
    };
    const measured = buildNodeLogRows({
      ...args,
      steps: [step({ id: "agent-1", costEstimated: false })],
    });
    const unknown = buildNodeLogRows(args); // no ledger row at all — a pre-#1060 run
    expect(measured[0].label).not.toContain("est.");
    // Absent MUST read the same as measured here, not as a third rendered state: we are not
    // claiming "measured" for it either, we are simply saying nothing.
    expect(unknown[0].label).toEqual(measured[0].label);
  });

  it("does not read provenance out of the node's output (the allowlist is unwidened)", () => {
    // If someone later routes the flag through the activity's return value instead, this fails —
    // which is the point. `SAFE_OUTPUT_FIELDS` bounds what OUTPUT content can reach a row, and the
    // ledger join exists so that list never has to grow to answer a billing question.
    expect(safeFields({ ...AGENT_OUT, estimated: true })).toEqual([
      "model=claude-opus-4-8",
      "tokens=900",
      "cost=$0.0040",
    ]);
  });
});
