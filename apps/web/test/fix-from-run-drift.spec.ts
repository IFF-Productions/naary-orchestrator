// "That run used v3; this workflow is now v7" — the warning on the Fix-with-AI path.
//
// The fix targets the workflow's CURRENT version (decision 1), so when the failed run executed an
// older one the diagnosis may name a step that has since changed. That is worth saying, and it is
// the kind of thing that fails silently: computed inside the fetch effect, `currentVersion` would
// be captured from the FIRST render — null, because the workflow is still loading — and the
// warning would simply never appear. Nothing would look broken. Hence a pure function with tests.
import { describe, expect, it } from "vitest";
import {
  ctxWasReadable,
  driftBetween,
  fixStage,
} from "../src/screens/canvas/useFixFromRun";

// "Could not read the run's outputs" vs "the run produced none". Getting this wrong tells the
// model a confident falsehood about the workflow — and it has now had to be fixed twice: once
// inside buildFixInstruction (which grew the flag for exactly this reason), and once at this call
// site, where the first version answered it with `Object.keys(ctx).length > 0`.
describe("ctxWasReadable", () => {
  it("is readable when the ctx has anything in it", () => {
    expect(ctxWasReadable({ pagerduty: { status: 200 } }, [])).toBe(true);
  });

  it("is NOT readable when the ctx is empty but steps are stamped as executed", () => {
    // queryState falls back to the read-model stamp exactly when it could not recover the ctx
    // (#525), so this combination is the signature of a failed read.
    expect(ctxWasReadable({}, ["schedule", "pagerduty"])).toBe(false);
  });

  it("IS readable when nothing ran — an empty run produced nothing, and that is a fact", () => {
    // The regression the first version had: a run that failed on its very first step has an
    // empty ctx legitimately, and must not be described as unreadable.
    expect(ctxWasReadable({}, [])).toBe(true);
  });

  it("survives missing fields", () => {
    expect(ctxWasReadable(undefined, undefined)).toBe(true);
    expect(ctxWasReadable({}, undefined)).toBe(true);
  });
});

describe("driftBetween", () => {
  it("reports drift when the run's version differs from the canvas's", () => {
    expect(driftBetween(3, 7)).toEqual({ runVersion: 3, currentVersion: 7 });
  });

  it("reports drift when the canvas is somehow BEHIND the run", () => {
    // A rollback, or a version restored from history. Still a mismatch worth flagging — the
    // direction is not what makes it worth checking.
    expect(driftBetween(9, 4)).toEqual({ runVersion: 9, currentVersion: 4 });
  });

  it("is silent when the run used the version now on the canvas", () => {
    expect(driftBetween(7, 7)).toBeNull();
  });

  it("is silent while the canvas is still loading its version", () => {
    // The bug this guards: during the fetch, `currentVersion` is null. Treating that as drift
    // would warn on every single fix; treating a LOADED mismatch as null-safe silence would warn
    // on none. Null means "no comparison to make", not "no drift".
    expect(driftBetween(3, null)).toBeNull();
  });

  it("is silent for a run from before version tracking", () => {
    expect(driftBetween(null, 7)).toBeNull();
    expect(driftBetween(null, null)).toBeNull();
  });

  it("treats v0 as a real version, not as absent", () => {
    // `!runVersion` would swallow this; the check is `== null` for that reason.
    expect(driftBetween(0, 2)).toEqual({ runVersion: 0, currentVersion: 2 });
    expect(driftBetween(2, 0)).toEqual({ runVersion: 2, currentVersion: 0 });
    expect(driftBetween(0, 0)).toBeNull();
  });
});

// What the panel REPORTS while the box is still empty.
//
// Reported as "Fix with AI initially loads the canvas but nothing is happening, then it will show
// the prefilled prompt". The waits are real, so the fix is to name them — and the state that has
// to be right is `blocked`: the build effect refuses to run without a compiled graph, so a plain
// loading boolean would spin forever on a canvas that never compiles. A spinner that never
// resolves is a worse version of the complaint it was added to fix.
describe("fixStage", () => {
  const RUN = "exec-t-demo-1";

  it("is idle when the user didn't arrive from a run", () => {
    expect(
      fixStage({
        fixRunId: null,
        hasGraph: true,
        canvasLoaded: true,
        doneFor: null,
      }),
    ).toBe("idle");
  });

  it("waits on the CANVAS before the workflow has loaded", () => {
    expect(
      fixStage({
        fixRunId: RUN,
        hasGraph: false,
        canvasLoaded: false,
        doneFor: null,
      }),
    ).toBe("loading-canvas");
  });

  it("waits on the RUN once there's a graph to describe the failure against", () => {
    expect(
      fixStage({
        fixRunId: RUN,
        hasGraph: true,
        canvasLoaded: true,
        doneFor: null,
      }),
    ).toBe("reading-run");
  });

  it("STOPS waiting when the canvas has loaded and still has no graph", () => {
    // The whole reason this is an enum. `hasGraph` never becoming true is not a slow load — the
    // canvas is empty or doesn't compile — and the effect will never run, so there is nothing to
    // wait for. Say so instead of spinning.
    expect(
      fixStage({
        fixRunId: RUN,
        hasGraph: false,
        canvasLoaded: true,
        doneFor: null,
      }),
    ).toBe("blocked");
  });

  it("is done once the run has been reported on", () => {
    expect(
      fixStage({
        fixRunId: RUN,
        hasGraph: true,
        canvasLoaded: true,
        doneFor: RUN,
      }),
    ).toBe("done");
  });

  it("is done even if the canvas later stops compiling", () => {
    // The description is already in the box; a subsequent edit that breaks compilation must not
    // reopen the wait and replace what the user is reading with a spinner.
    expect(
      fixStage({
        fixRunId: RUN,
        hasGraph: false,
        canvasLoaded: true,
        doneFor: RUN,
      }),
    ).toBe("done");
  });

  it("starts reporting again for a DIFFERENT run", () => {
    // Arriving from a second failed run while the first one's result is still on screen. Keyed by
    // id, not a boolean, so the previous run's description isn't presented as this one's.
    expect(
      fixStage({
        fixRunId: "exec-t-demo-2",
        hasGraph: true,
        canvasLoaded: true,
        doneFor: RUN,
      }),
    ).toBe("reading-run");
  });
});
