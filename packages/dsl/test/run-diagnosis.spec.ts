// What a failed run tells a model — and, more importantly, what it does NOT.
//
// `buildFixInstruction` produces text that is sent to an LLM. The exclusions below are the whole
// privacy boundary for the fix feature, so they are asserted here rather than left as a comment
// and a good intention. If one of these tests goes red, tenant data is leaving that shouldn't.
//
// The boundary MOVED once, deliberately: it used to send only the steps the failing node reads,
// which made a cause two steps upstream unreachable. It now sends every step that ran. The tests
// that guarded the old narrower rule were rewritten rather than deleted, so the file reads as the
// current decision instead of as a rule someone quietly relaxed. What did NOT move: `$secrets`,
// `$vars`, and `__*` bookkeeping other than `__input`.
import { describe, expect, it } from "vitest";
import { buildFixInstruction } from "../src/run-diagnosis";
import type { GraphDef, NodeDef } from "../src/types";

const node = (id: string, config?: NodeDef["config"], type = "integration") =>
  ({ id, type, config }) as NodeDef;

const GRAPH: GraphDef = {
  startNodeId: "start",
  nodes: [
    node("start", { sampleInput: {} }, "start"),
    node("lookup", { url: "https://api/x" }, "httpRequest"),
    node("unrelated", { url: "https://api/y" }, "httpRequest"),
    node("pagerduty", {
      action: "createIncident",
      bindings: { title: { from: "lookup", path: "body.title" } },
      note: "opened for {{ start.ticketId }}",
    }),
  ],
  edges: [
    { from: "start", to: "lookup" },
    { from: "lookup", to: "pagerduty" },
  ],
};

const CTX = {
  __input: { ticketId: "NAARY-42" },
  __costUsd: 0.02,
  __nodeTimes: { lookup: { s: 1, f: 2 } },
  $vars: { REGION: "eu", ADMIN_EMAIL: "boss@corp.com" },
  $secrets: { PD_TOKEN: "super-secret-value" },
  start: { ticketId: "NAARY-42" },
  lookup: { status: 200, body: { title: "Disk full" } },
  unrelated: { customerEmail: "someone@example.com", ssn: "000-00-0000" },
};

const base = {
  graph: GRAPH,
  failedNodeId: "pagerduty",
  error: "Missing required header 'From'",
  failureKind: "provider_error",
  ctx: CTX,
};

describe("buildFixInstruction — what it includes", () => {
  it("names the failing node, its error and its kind", () => {
    const { instruction } = buildFixInstruction(base);
    expect(instruction).toContain("pagerduty");
    expect(instruction).toContain("Missing required header 'From'");
    expect(instruction).toContain("provider_error");
  });

  it("includes the failing node's own configuration", () => {
    const { instruction } = buildFixInstruction(base);
    expect(instruction).toContain("createIncident");
  });

  it("includes EVERY step that ran, not only the ones that node reads", () => {
    // The widening. `unrelated` is not referenced by the failing node at all, and its output is
    // sent anyway: a cause two steps upstream was unreachable when this was a filter.
    const { includedNodeIds, instruction } = buildFixInstruction(base);
    expect(includedNodeIds.sort()).toEqual(["lookup", "start", "unrelated"]);
    expect(instruction).toContain("Disk full");
  });

  it("puts the steps that node READS first", () => {
    // Ordering is not cosmetic: the section is bounded, so when it truncates these are the rows
    // that have to survive.
    const { includedNodeIds } = buildFixInstruction(base);
    // `lookup` via an ArgBinding, `start` via a {{ }} template — both are real reads.
    expect(includedNodeIds.slice(0, 2).sort()).toEqual(["lookup", "start"]);
    expect(includedNodeIds[2]).toBe("unrelated");
  });

  it("includes the run's trigger input", () => {
    const { instruction } = buildFixInstruction(base);
    expect(instruction).toContain("The input that started this run");
    expect(instruction).toContain("NAARY-42");
  });

  it("includes the config AS IT RAN, with this run's values filled in", () => {
    // The other half of the ask, and where a whole class of bug becomes visible: the authored
    // config says `{{ start.ticketId }}`, and what actually went out is the resolved value.
    const { instruction } = buildFixInstruction(base);
    expect(instruction).toContain("AS IT RAN");
    expect(instruction).toContain("opened for NAARY-42");
  });

  it("MARKS a reference that resolved to nothing instead of dropping the field", () => {
    // The single commonest cause of the failures this feature diagnoses is a mistyped path, and
    // for a whole-string token it resolves to `undefined` — which `JSON.stringify` DROPS. So the
    // first version of this block rendered a typo'd `title` as no `title` key at all: the one bug
    // the block exists to expose was the one it hid, and "this node has no title field" is a
    // different and false claim. Caught by reading the output, not by an assertion.
    const graph: GraphDef = {
      ...GRAPH,
      nodes: GRAPH.nodes.map((n) =>
        n.id === "pagerduty"
          ? node("pagerduty", { title: "{{ lookup.body.titel }}" }) // note the typo
          : n,
      ),
    };
    const { instruction } = buildFixInstruction({ ...base, graph });
    expect(instruction).toContain('"title":"<unresolved>"');
  });

  it("omits the AS IT RAN block when the ctx could not be READ", () => {
    // Resolving against a ctx we failed to recover marks every reference `<unresolved>`, which
    // asserts "this produced no value at runtime" when the truth is "we don't know". That is the
    // confident falsehood `ctxAvailable` exists to prevent, and this block reintroduced it one
    // level down until review caught it.
    const { instruction } = buildFixInstruction({
      ...base,
      ctx: {},
      ctxAvailable: false,
    });
    expect(instruction).not.toContain("AS IT RAN");
    expect(instruction).not.toContain("<unresolved>");
    expect(instruction).toContain("could not be read");
  });

  it("omits the AS IT RAN block when the config has no templates to fill in", () => {
    // Two identical blocks would invite the model to read the second as a different fact.
    const graph: GraphDef = {
      ...GRAPH,
      nodes: GRAPH.nodes.map((n) =>
        n.id === "pagerduty"
          ? node("pagerduty", { action: "createIncident" })
          : n,
      ),
    };
    const { instruction } = buildFixInstruction({ ...base, graph });
    expect(instruction).not.toContain("AS IT RAN");
  });

  it("includes the redacted HTTP capture", () => {
    const { instruction } = buildFixInstruction({
      ...base,
      http: {
        request: { method: "POST", url: "https://api.pagerduty.com/incidents" },
        response: { status: 400, statusText: "Bad Request" },
      },
    });
    expect(instruction).toContain("POST https://api.pagerduty.com/incidents");
    expect(instruction).toContain("400");
  });
});

describe("buildFixInstruction — what it must NEVER include", () => {
  it("omits $secrets even when the failing node references them", () => {
    // The reference walk sees `$secrets` as an ordinary head, so this is dropped BY NAME.
    const graph: GraphDef = {
      ...GRAPH,
      nodes: GRAPH.nodes.map((n) =>
        n.id === "pagerduty"
          ? node("pagerduty", { token: "{{ $secrets.PD_TOKEN }}" })
          : n,
      ),
    };
    const { instruction, includedNodeIds } = buildFixInstruction({
      ...base,
      graph,
    });
    expect(includedNodeIds).not.toContain("$secrets");
    expect(instruction).not.toContain("super-secret-value");
    // …and the AS-IT-RAN block leaves the token LITERAL rather than blanking it. Blanking would
    // claim the header went out empty, which is a different and false statement about the run.
    expect(instruction).toContain("{{ $secrets.PD_TOKEN }}");
  });

  it("omits $vars even when the failing node references them", () => {
    const graph: GraphDef = {
      ...GRAPH,
      nodes: GRAPH.nodes.map((n) =>
        n.id === "pagerduty"
          ? node("pagerduty", { region: "{{ $vars.REGION }}" })
          : n,
      ),
    };
    const { instruction, includedNodeIds } = buildFixInstruction({
      ...base,
      graph,
    });
    expect(includedNodeIds).not.toContain("$vars");
    expect(instruction).not.toContain("boss@corp.com");
    // Same rule as secrets: not resolved, and left literal rather than blanked. `$vars` is
    // workspace configuration, not run data, so the widening to "every step" doesn't reach it.
    expect(instruction).not.toContain('"region":"eu"');
    expect(instruction).toContain("{{ $vars.REGION }}");
  });

  it("omits __* run bookkeeping — but NOT __input, which is the run's input", () => {
    // `__input` was previously swept up in the "`__*` is bookkeeping" exclusion. It isn't
    // bookkeeping; it is the run's input, and it is now disclosed as such. The rest still is.
    const graph: GraphDef = {
      ...GRAPH,
      nodes: GRAPH.nodes.map((n) =>
        n.id === "pagerduty"
          ? node("pagerduty", { echo: "{{ __input.ticketId }}" })
          : n,
      ),
    };
    const { includedNodeIds, instruction } = buildFixInstruction({
      ...base,
      graph,
    });
    // Bookkeeping is never a "step" and its values never appear.
    expect(includedNodeIds).not.toContain("__input");
    expect(includedNodeIds).not.toContain("__nodeTimes");
    expect(includedNodeIds).not.toContain("__costUsd");
    expect(instruction).not.toContain("__nodeTimes");
    expect(instruction).not.toContain("0.02");
    // The run input is disclosed, so resolving a reference to it discloses nothing new.
    expect(instruction).toContain("The input that started this run");
    expect(instruction).toContain('"echo":"NAARY-42"');
  });
});

// ── Bounds ────────────────────────────────────────────────────────────────────────────────────
//
// Per-step clipping bounded the old version, because it only ever sent a handful of steps. Sending
// EVERY step means the section itself has to be bounded, or a large run produces a prompt whose
// size is the workflow's size — paid for in tokens, every time a run fails.
describe("buildFixInstruction — the step section is bounded", () => {
  /** A run with far more step output than the section can hold. */
  const bigRun = () => {
    const ctx: Record<string, unknown> = { start: { ticketId: "NAARY-42" } };
    for (let i = 0; i < 100; i++) {
      ctx[`step${i}`] = { note: `x`.repeat(500) };
    }
    // `lookup` is READ by the failing node and is added LAST, so only the ordering can save it.
    // Its output is the same SIZE as the others on purpose: a small row would slip into leftover
    // budget no matter where it sat in the list, and the ordering assertion below would pass
    // without the ordering existing. (It did, the first time this was written.)
    ctx.lookup = {
      status: 200,
      body: { title: `Disk full ${"x".repeat(500)}` },
    };
    return ctx;
  };

  it("stays bounded, and SAYS how many steps it dropped", () => {
    const { instruction, includedNodeIds } = buildFixInstruction({
      ...base,
      ctx: bigRun(),
    });
    expect(instruction.length).toBeLessThan(20_000);
    expect(includedNodeIds.length).toBeLessThan(101);
    // Silent truncation of a disclosure is the thing to avoid: the reader must be able to tell
    // "this step produced nothing" from "we didn't send it".
    expect(instruction).toMatch(/… and \d+ more steps? omitted for length/);
  });

  it("keeps the steps the failing node READS when it truncates", () => {
    // The whole point of ordering. `lookup` is last in the ctx and would be cut on insertion
    // order alone — it survives because the failing node reads it.
    const { includedNodeIds, instruction } = buildFixInstruction({
      ...base,
      ctx: bigRun(),
    });
    expect(includedNodeIds).toContain("lookup");
    expect(includedNodeIds).toContain("start");
    expect(instruction).toContain("Disk full");
  });

  it("includes one step even when that step alone exceeds the section budget", () => {
    // A diagnosis with no step data is worse than one slightly over budget — and `clip` has
    // already bounded the row itself.
    const { includedNodeIds } = buildFixInstruction({
      ...base,
      ctx: { lookup: { body: "y".repeat(60_000) } },
    });
    expect(includedNodeIds).toEqual(["lookup"]);
  });
});

describe("buildFixInstruction — bounds and edge cases", () => {
  it("truncates an oversized output and SAYS that it did", () => {
    const big = "x".repeat(50_000);
    const { instruction } = buildFixInstruction({
      ...base,
      ctx: { ...CTX, lookup: { body: big } },
    });
    expect(instruction).toContain("truncated");
    expect(instruction.length).toBeLessThan(20_000);
  });

  it("survives an unserializable output rather than throwing", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const { instruction } = buildFixInstruction({
      ...base,
      ctx: { ...CTX, lookup: circular },
    });
    expect(instruction).toContain("[unserializable]");
  });

  it("still produces an instruction when the failing node is GONE from the graph", () => {
    // Decision 1: the fix targets the workflow's LATEST version, which may no longer contain the
    // node that failed. That is a case to describe honestly, not to crash on.
    const { instruction, includedNodeIds } = buildFixInstruction({
      ...base,
      failedNodeId: "deleted-node",
    });
    expect(instruction).toContain("deleted-node");
    expect(instruction).toContain("no longer in the workflow");
    // The run's steps still ran, and their data is still what a diagnosis needs — there is just
    // no failing node left to order them by. (Under the old read-filter this was necessarily
    // empty, because "what does the missing node read" has no answer.)
    expect(includedNodeIds.sort()).toEqual(["lookup", "start", "unrelated"]);
  });

  it("skips a step with no output at all", () => {
    const { includedNodeIds } = buildFixInstruction({
      ...base,
      ctx: { start: { ticketId: "NAARY-42" } }, // `lookup` never ran
    });
    expect(includedNodeIds).toEqual(["start"]);
  });

  it("says the outputs were UNREADABLE rather than absent, when told so", () => {
    // A closed run whose ctx we couldn't recover answers `{}` — indistinguishable from an empty
    // run unless the caller says which it was. Calling it "reads no data" would hand the model a
    // confident falsehood about the workflow.
    const { instruction } = buildFixInstruction({
      ...base,
      ctx: {},
      ctxAvailable: false,
    });
    expect(instruction).toContain("could not be read");
    expect(instruction).not.toContain("reads no data from other steps");
  });

  it("distinguishes 'reads nothing' from 'read steps that produced nothing'", () => {
    // Node with no references at all.
    const noRefs = buildFixInstruction({
      ...base,
      graph: {
        ...GRAPH,
        nodes: GRAPH.nodes.map((n) =>
          n.id === "pagerduty" ? node("pagerduty", { action: "x" }) : n,
        ),
      },
      ctx: {},
    });
    expect(noRefs.instruction).toContain("reads no data from other steps");

    // Node that DOES reference upstream steps, which simply produced nothing this run.
    const emptyUpstream = buildFixInstruction({ ...base, ctx: {} });
    expect(emptyUpstream.instruction).toContain(
      "produced no output in this run",
    );
    expect(emptyUpstream.instruction).toContain('"lookup"');
  });

  it("handles a missing error and a missing ctx", () => {
    const { instruction } = buildFixInstruction({
      graph: GRAPH,
      failedNodeId: "pagerduty",
    });
    expect(instruction).toContain("no error message was recorded");
  });
});
