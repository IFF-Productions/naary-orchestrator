// What a failed run tells a model — and, more importantly, what it does NOT.
//
// `buildFixInstruction` produces text that is sent to an LLM. The exclusions below are the whole
// privacy boundary for the fix feature, so they are asserted here rather than left as a comment
// and a good intention. If one of these tests goes red, tenant data is leaving that shouldn't.
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

  it("includes the outputs of the steps that node actually READS", () => {
    const { includedNodeIds, instruction } = buildFixInstruction(base);
    // `lookup` via an ArgBinding, `start` via a {{ }} template — both are real reads.
    expect(includedNodeIds.sort()).toEqual(["lookup", "start"]);
    expect(instruction).toContain("Disk full");
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
  it("omits an unrelated node's output entirely", () => {
    const { instruction, includedNodeIds } = buildFixInstruction(base);
    expect(includedNodeIds).not.toContain("unrelated");
    expect(instruction).not.toContain("someone@example.com");
    expect(instruction).not.toContain("000-00-0000");
  });

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
  });

  it("omits __* run bookkeeping", () => {
    const graph: GraphDef = {
      ...GRAPH,
      nodes: GRAPH.nodes.map((n) =>
        n.id === "pagerduty"
          ? node("pagerduty", { echo: "{{ __input.ticketId }}" })
          : n,
      ),
    };
    const { includedNodeIds } = buildFixInstruction({ ...base, graph });
    expect(includedNodeIds).toEqual([]);
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
    expect(includedNodeIds).toEqual([]);
  });

  it("skips a referenced step that produced no output", () => {
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
