// "That run used v3; this workflow is now v7" — the warning on the Fix-with-AI path.
//
// The fix targets the workflow's CURRENT version (decision 1), so when the failed run executed an
// older one the diagnosis may name a step that has since changed. That is worth saying, and it is
// the kind of thing that fails silently: computed inside the fetch effect, `currentVersion` would
// be captured from the FIRST render — null, because the workflow is still loading — and the
// warning would simply never appear. Nothing would look broken. Hence a pure function with tests.
import { describe, expect, it } from "vitest";
import {
  blockedReason,
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
//
// `blocked` is NOT "there is no graph", though — that reading is how #1006 shipped. A workflow
// that failed to OPEN blocks too, and it has a graph: the seed left on the canvas, compiling. Two
// routes in, which is why `canvasLoad` is asked before `hasGraph` and why the cases below pass
// `hasGraph: true` on the failed open.
describe("fixStage", () => {
  const RUN = "exec-t-demo-1";

  it("is idle when the user didn't arrive from a run", () => {
    expect(
      fixStage({
        fixRunId: null,
        hasGraph: true,
        canvasLoad: "loaded",
        doneFor: null,
      }),
    ).toBe("idle");
  });

  it("waits on the CANVAS before the workflow has loaded", () => {
    expect(
      fixStage({
        fixRunId: RUN,
        hasGraph: false,
        canvasLoad: "loading",
        doneFor: null,
      }),
    ).toBe("loading-canvas");
  });

  it("STILL waits on the canvas when a graph compiles before the workflow lands", () => {
    // #998, and the reason this stage was unreachable in the app. The canvas mounts with
    // SEED_NODES (start → approval → end), which COMPILE — so `hasGraph` is true on the very
    // first render, before the workflow has been fetched. A graph is not the workflow: reporting
    // "reading the run" here would name the wait wrongly, and the build effect reads the same
    // condition, so it would describe the failure against the SEED canvas.
    expect(
      fixStage({
        fixRunId: RUN,
        hasGraph: true,
        canvasLoad: "loading",
        doneFor: null,
      }),
    ).toBe("loading-canvas");
  });

  it("waits on the RUN once there's a graph to describe the failure against", () => {
    expect(
      fixStage({
        fixRunId: RUN,
        hasGraph: true,
        canvasLoad: "loaded",
        doneFor: null,
      }),
    ).toBe("reading-run");
  });

  it("STOPS waiting when the workflow FAILED to open — with a graph still compiling", () => {
    // #1006, and the reason a settled/not-settled boolean was not enough. A failed `/graphs` read
    // never replaces the nodes, so SEED_NODES are still mounted and still COMPILE — `hasGraph` is
    // true. Reported as "settled", that seed is what the failure gets described against, and the
    // prompt says a step is "no longer in the workflow" under a banner naming the workflow the
    // user came from. `hasGraph` is deliberately true in this case so the test fails if the
    // failure is ever folded back into the `hasGraph ? … : …` line below.
    expect(
      fixStage({
        fixRunId: RUN,
        hasGraph: true,
        canvasLoad: "failed",
        doneFor: null,
      }),
    ).toBe("blocked");
  });

  it("does NOT reopen the wait for a workflow that failed to open", () => {
    // The other half: `failed` is terminal, not a retry-forever spinner. Inverting `canvasLoaded`
    // to mean "succeeded" would have produced exactly that — `loading-canvas` for good, on the one
    // path that most needs to say what went wrong.
    expect(
      fixStage({
        fixRunId: RUN,
        hasGraph: false,
        canvasLoad: "failed",
        doneFor: null,
      }),
    ).toBe("blocked");
  });

  it("STOPS waiting when the canvas has loaded and still has no graph", () => {
    // The whole reason this is an enum. `hasGraph` never becoming true is not a slow load — the
    // canvas is empty or doesn't compile — and the effect will never run, so there is nothing to
    // wait for. Say so instead of spinning.
    expect(
      fixStage({
        fixRunId: RUN,
        hasGraph: false,
        canvasLoad: "loaded",
        doneFor: null,
      }),
    ).toBe("blocked");
  });

  it("is done once the run has been reported on", () => {
    expect(
      fixStage({
        fixRunId: RUN,
        hasGraph: true,
        canvasLoad: "loaded",
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
        canvasLoad: "loaded",
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
        canvasLoad: "loaded",
        doneFor: RUN,
      }),
    ).toBe("reading-run");
  });
});

// WHICH SENTENCE `blocked` SHOWS. Three situations reach it and each of the other two sentences is
// FALSE about the third — which matters more than it sounds, because this branch has already
// shipped a sentence that was plainly false about a visible canvas, twice. Precedence is the whole
// content of the test: a failed open compiles (the SEED graph is still mounted), so if it is not
// asked first it falls through to "there's no workflow on the canvas" — with three nodes rendered.
describe("blockedReason", () => {
  it("names the failed OPEN first — the canvas is neither empty nor broken, just not the workflow", () => {
    const copy = blockedReason({ canvasLoadFailed: true, canvasError: null });
    expect(copy).toMatch(/couldn't be opened/);
    expect(copy).not.toMatch(/no workflow on the canvas/);
    expect(copy).not.toMatch(/doesn't compile/);
  });

  it("prefers the failed open even when the canvas ALSO has a compile error", () => {
    // A canvas that failed to open and was then edited into a non-compiling state. The open is the
    // older and more fundamental fact: nothing here is the user's workflow, so naming the compile
    // error would send them to fix the wrong thing.
    expect(
      blockedReason({ canvasLoadFailed: true, canvasError: "Multiple entry" }),
    ).toMatch(/couldn't be opened/);
  });

  it("names the compile error when the workflow IS here and doesn't compile", () => {
    const copy = blockedReason({ canvasError: "Multiple entry nodes" });
    expect(copy).toMatch(/doesn't compile — Multiple entry nodes/);
    expect(copy).not.toMatch(/no workflow on the canvas/);
  });

  it("says there's no workflow only when that is actually true", () => {
    expect(blockedReason({})).toMatch(/no workflow on the canvas/);
  });
});
