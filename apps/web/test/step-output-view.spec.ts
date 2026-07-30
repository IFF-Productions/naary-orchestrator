// Which value the step-detail panel shows, and whether it's labelled "Trigger input".
//
// This exists because the previous regression here was caught only by Playwright, six minutes into
// CI. Making `start` publish its input (like every other entry node) silently flipped the entry
// step's label to "Output", because the old rule was "this is the trigger payload only when the
// node wrote NO output of its own" — a correct label that depended on a node producing nothing.
import { describe, expect, it } from "vitest";
import { stepOutputView } from "../src/screens/app/run-detail/run-view-model";

const INPUT = { ticket: "NAARY-42" };

describe("stepOutputView", () => {
  it("labels the entry node's OWN output as the trigger input", () => {
    // The current shape: `start` (and every other entry node) publishes ctx[id] = __input.
    const v = stepOutputView("start", "start", {
      start: INPUT,
      __input: INPUT,
    });
    expect(v.isTriggerInput).toBe(true);
    expect(v.output).toEqual(INPUT);
    // It IS a real ctx entry, so it stays addressable as <runId>/<nodeId>.
    expect(v.hasCtxOutput).toBe(true);
  });

  it("still labels an OLDER run's entry step, where only __input exists", () => {
    // Runs recorded before `start` published anything must not regress to "no output".
    const v = stepOutputView("start", "start", { __input: INPUT });
    expect(v.isTriggerInput).toBe(true);
    expect(v.output).toEqual(INPUT);
    // …but the value is the run's input standing in, not this node's entry, so no node id.
    expect(v.hasCtxOutput).toBe(false);
  });

  it("labels a webhookTrigger's event as the trigger input too", () => {
    // This one has ALWAYS written its own ctx entry, so the old rule mislabelled it "Output"
    // even though its output has always been the inbound event.
    const v = stepOutputView("hook", "hook", {
      hook: { body: INPUT },
      __input: { body: INPUT },
    });
    expect(v.isTriggerInput).toBe(true);
  });

  it("does not call a NON-entry node's output a trigger input", () => {
    const v = stepOutputView("agent", "start", {
      start: INPUT,
      __input: INPUT,
      agent: { text: "hi" },
    });
    expect(v.isTriggerInput).toBe(false);
    expect(v.output).toEqual({ text: "hi" });
    expect(v.hasCtxOutput).toBe(true);
  });

  it("reports no output for a node that hasn't produced one", () => {
    const v = stepOutputView("end", "start", { start: INPUT, __input: INPUT });
    expect(v.output).toBeUndefined();
    expect(v.isTriggerInput).toBe(false);
    expect(v.hasCtxOutput).toBe(false);
  });

  it("does not invent a trigger input for a run that had none", () => {
    // A manual run with no input at all: the entry step has nothing to show, and must not be
    // labelled as showing a payload.
    const v = stepOutputView("start", "start", {});
    expect(v.isTriggerInput).toBe(false);
    expect(v.output).toBeUndefined();
  });

  it("shows a node's own output even when it is undefined-but-present", () => {
    // `id in ctx` is the test, not truthiness — a node that legitimately wrote a falsy value
    // must not fall through to the trigger-input branch.
    const v = stepOutputView("gate", "start", {
      start: INPUT,
      __input: INPUT,
      gate: false,
    });
    expect(v.hasCtxOutput).toBe(true);
    expect(v.output).toBe(false);
  });
});
