import { describe, expect, it } from "vitest";
import { evaluateCondition, nextNodes, validateGraph } from "../src/branch";
import type { GraphDef } from "../src/types";

const ctx = {
  agent: { output: { category: "billing", urgency: 3 } },
  trigger: { number: 42 },
};

describe("evaluateCondition", () => {
  it("eq / neq", () => {
    expect(
      evaluateCondition(
        { path: "agent.output.category", op: "eq", value: "billing" },
        ctx,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { path: "agent.output.category", op: "eq", value: "other" },
        ctx,
      ),
    ).toBe(false);
    expect(
      evaluateCondition(
        { path: "agent.output.category", op: "neq", value: "other" },
        ctx,
      ),
    ).toBe(true);
  });
  it("exists (missing path is false)", () => {
    expect(
      evaluateCondition({ path: "agent.output.urgency", op: "exists" }, ctx),
    ).toBe(true);
    expect(
      evaluateCondition({ path: "agent.output.missing", op: "exists" }, ctx),
    ).toBe(false);
  });
  it("in / gt / lt", () => {
    expect(
      evaluateCondition(
        {
          path: "agent.output.category",
          op: "in",
          value: ["billing", "sales"],
        },
        ctx,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { path: "agent.output.urgency", op: "gt", value: 2 },
        ctx,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { path: "agent.output.urgency", op: "lt", value: 2 },
        ctx,
      ),
    ).toBe(false);
    // gt/lt are false for non-numbers (no coercion)
    expect(
      evaluateCondition(
        { path: "agent.output.category", op: "gt", value: 2 },
        ctx,
      ),
    ).toBe(false);
  });

  it("gte / lte (inclusive, numbers only)", () => {
    const c = { path: "agent.output.urgency", op: "gte" as const, value: 3 };
    expect(evaluateCondition(c, ctx)).toBe(true);
    expect(evaluateCondition({ ...c, value: 4 }, ctx)).toBe(false);
    expect(
      evaluateCondition(
        { path: "agent.output.urgency", op: "lte", value: 3 },
        ctx,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { path: "agent.output.category", op: "gte", value: 3 },
        ctx,
      ),
    ).toBe(false); // non-number
  });

  it("contains / notContains (string + array)", () => {
    const s = { agent: { output: { category: "billing-urgent" } } };
    expect(
      evaluateCondition(
        { path: "agent.output.category", op: "contains", value: "urgent" },
        s,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { path: "agent.output.category", op: "notContains", value: "sales" },
        s,
      ),
    ).toBe(true);
    const arr = { n: { tags: ["a", "b"] } };
    expect(
      evaluateCondition({ path: "n.tags", op: "contains", value: "b" }, arr),
    ).toBe(true);
    expect(
      evaluateCondition({ path: "n.tags", op: "contains", value: "z" }, arr),
    ).toBe(false);
    // a missing value does not contain the target → notContains is true
    expect(
      evaluateCondition(
        { path: "n.missing", op: "notContains", value: "x" },
        arr,
      ),
    ).toBe(true);
  });

  it("startsWith / endsWith (coerce non-strings)", () => {
    const s = { n: { name: "invoice-42", num: 4200 } };
    expect(
      evaluateCondition(
        { path: "n.name", op: "startsWith", value: "invoice" },
        s,
      ),
    ).toBe(true);
    expect(
      evaluateCondition({ path: "n.name", op: "endsWith", value: "42" }, s),
    ).toBe(true);
    expect(
      evaluateCondition({ path: "n.num", op: "startsWith", value: "42" }, s),
    ).toBe(true);
    expect(
      evaluateCondition({ path: "n.missing", op: "startsWith", value: "x" }, s),
    ).toBe(false);
  });

  it("regex (invalid pattern is false, never throws)", () => {
    const s = { n: { email: "a@b.co" } };
    expect(
      evaluateCondition(
        { path: "n.email", op: "regex", value: "^[^@]+@[^@]+$" },
        s,
      ),
    ).toBe(true);
    expect(
      evaluateCondition({ path: "n.email", op: "regex", value: "^x" }, s),
    ).toBe(false);
    expect(
      evaluateCondition({ path: "n.email", op: "regex", value: "(" }, s),
    ).toBe(false); // invalid
    expect(
      evaluateCondition({ path: "n.missing", op: "regex", value: ".*" }, s),
    ).toBe(false);
  });

  it("regex ReDoS guard: rejects catastrophic-backtracking patterns fast (#598)", () => {
    // The classic exponential pattern against a long non-matching input. Pre-guard
    // this would hang the (deterministic, uninterruptible) workflow thread; the guard
    // must return false essentially instantly.
    const evil = { n: { s: `${"a".repeat(40)}!` } };
    const start = Date.now();
    expect(
      evaluateCondition({ path: "n.s", op: "regex", value: "(a+)+$" }, evil),
    ).toBe(false);
    expect(
      evaluateCondition({ path: "n.s", op: "regex", value: "(a*)*$" }, evil),
    ).toBe(false);
    expect(
      evaluateCondition(
        { path: "n.s", op: "regex", value: "([a-z]+)*$" },
        evil,
      ),
    ).toBe(false);
    // `?` inside a quantified group is also exponential — `(a?)+` over "aaaa…!".
    expect(
      evaluateCondition({ path: "n.s", op: "regex", value: "(a?)+$" }, evil),
    ).toBe(false);
    expect(Date.now() - start).toBeLessThan(100);
  });

  it("regex guard: an OUTER `?` on a quantified group stays allowed (linear, safe)", () => {
    // `(a+)?` backtracks linearly, so the guard must NOT over-reject it.
    const s = { n: { v: "aaa" } };
    expect(
      evaluateCondition({ path: "n.v", op: "regex", value: "^(a+)?$" }, s),
    ).toBe(true);
  });

  it("regex guard: over-long pattern or input fails closed (#598)", () => {
    const s = { n: { v: "x".repeat(20_000) } };
    // Simple safe pattern, but the INPUT exceeds the cap → false.
    expect(
      evaluateCondition({ path: "n.v", op: "regex", value: "^x+$" }, s),
    ).toBe(false);
    // Over-long PATTERN → false.
    expect(
      evaluateCondition(
        { path: "n.v", op: "regex", value: `^${"a".repeat(300)}$` },
        { n: { v: "a" } },
      ),
    ).toBe(false);
  });

  it("regex guard: ordinary safe patterns still work, incl. a single quantified group", () => {
    const s = { n: { email: "a@b.co", code: "AB-123" } };
    expect(
      evaluateCondition(
        { path: "n.email", op: "regex", value: "^[^@]+@[^@]+$" },
        s,
      ),
    ).toBe(true);
    // One quantifier inside one group is NOT nested — must still be allowed.
    expect(
      evaluateCondition(
        { path: "n.code", op: "regex", value: "^([A-Z]+)-[0-9]+$" },
        s,
      ),
    ).toBe(true);
  });

  it("isEmpty / notEmpty (null, '', [], {})", () => {
    const s = { n: { a: "", b: [], c: {}, d: null, e: "x", f: [1], g: 0 } };
    for (const k of ["a", "b", "c", "d", "missing"]) {
      expect(evaluateCondition({ path: `n.${k}`, op: "isEmpty" }, s)).toBe(
        true,
      );
    }
    for (const k of ["e", "f"]) {
      expect(evaluateCondition({ path: `n.${k}`, op: "notEmpty" }, s)).toBe(
        true,
      );
    }
    // 0 is NOT empty (only null/undefined/""/[]/{})
    expect(evaluateCondition({ path: "n.g", op: "isEmpty" }, s)).toBe(false);
  });
});

const graph: GraphDef = {
  startNodeId: "agent",
  nodes: [
    { id: "agent", type: "agent" },
    { id: "billing", type: "end" },
    { id: "other", type: "end" },
    { id: "always", type: "end" },
  ],
  edges: [
    {
      from: "agent",
      to: "billing",
      condition: { path: "agent.output.category", op: "eq", value: "billing" },
    },
    {
      from: "agent",
      to: "other",
      condition: { path: "agent.output.category", op: "eq", value: "other" },
    },
    { from: "agent", to: "always" }, // unconditional
  ],
};

describe("nextNodes", () => {
  it("returns only passing edges, in declared order (unconditional always passes)", () => {
    expect(nextNodes(graph, "agent", ctx)).toEqual(["billing", "always"]);
  });
  it("returns [] when no edges leave the node", () => {
    expect(nextNodes(graph, "billing", ctx)).toEqual([]);
  });
});

describe("validateGraph", () => {
  it("accepts a well-formed graph (cycles allowed)", () => {
    const looped: GraphDef = {
      startNodeId: "a",
      nodes: [{ id: "a", type: "start" }],
      edges: [{ from: "a", to: "a" }],
    };
    expect(validateGraph(looped).valid).toBe(true);
  });
  it("rejects a dangling edge and a missing start", () => {
    expect(
      validateGraph({
        startNodeId: "a",
        nodes: [{ id: "a", type: "start" }],
        edges: [{ from: "a", to: "ghost" }],
      }).valid,
    ).toBe(false);
    expect(
      validateGraph({
        startNodeId: "missing",
        nodes: [{ id: "a", type: "start" }],
        edges: [],
      }).valid,
    ).toBe(false);
  });

  it("accepts unconditional fan-in into a merge node", () => {
    const diamond: GraphDef = {
      startNodeId: "s",
      nodes: [
        { id: "s", type: "start" },
        { id: "a", type: "set" },
        { id: "b", type: "set" },
        { id: "m", type: "merge" },
      ],
      edges: [
        { from: "s", to: "a" },
        { from: "s", to: "b" },
        { from: "a", to: "m" },
        { from: "b", to: "m" },
      ],
    };
    expect(validateGraph(diamond).valid).toBe(true);
  });

  it("rejects a multi-node graph whose start has no outgoing edge (disconnected)", () => {
    // The AI generator emitting nodes with an empty edges array — the run would do nothing.
    const orphaned: GraphDef = {
      startNodeId: "s",
      nodes: [
        { id: "s", type: "start" },
        { id: "a", type: "agent" },
        { id: "e", type: "end" },
      ],
      edges: [],
    };
    const res = validateGraph(orphaned);
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/no outgoing edge|disconnected/);
  });

  it("rejects a conditional edge into a merge node (v1 fan-in must be unconditional)", () => {
    const bad: GraphDef = {
      startNodeId: "s",
      nodes: [
        { id: "s", type: "start" },
        { id: "a", type: "set" },
        { id: "m", type: "merge" },
      ],
      edges: [
        { from: "s", to: "a" },
        { from: "a", to: "m", condition: { path: "a.ok", op: "exists" } },
      ],
    };
    const res = validateGraph(bad);
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/merge/);
  });
});
