// Conditional and multi-path routing plus the per-node execution matrix.
// Split out of interpreter.e2e.spec.ts (issue #496). Shared harness + fixtures
// live in ./interpreter-harness; this file owns its own TestWorkflowEnvironment.
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { createLocalTestEnv } from "./local-test-env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GraphDef } from "@naary/dsl";
import { runGraph } from "../src/temporal/workflows";
import {
  TASK_QUEUE,
  csvCalls,
  encodeCalls,
  hashCalls,
  randomCalls,
  htmlExtractCalls,
  markdownCalls,
  makeWorker,
} from "./interpreter-harness";

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await createLocalTestEnv();
}, 60_000);

afterAll(async () => {
  await env?.teardown();
});

/**
 * Conditional & multi-path routing — the interpreter walking real branches. Proves switch
 * (multi-way), the standalone if gate, the full edge-condition operator set, a diamond fan-out→merge,
 * and a nested if→switch chain. All pure control-flow (no activity stubs): the branch a run takes is
 * asserted by which terminal `set` node wrote its output into ctx.
 */
describe("runGraph interpreter — conditional & multi-path routing", () => {
  // Run a graph to completion and return {status, ctx}. Each caller passes a unique workflowId.
  async function runFlow(
    graph: GraphDef,
    input: Record<string, unknown>,
    workflowId: string,
    tenantId = "t-route",
  ): Promise<{ status: string; ctx: Record<string, unknown> }> {
    const worker = await makeWorker(env);
    let result!: { status: string; ctx: Record<string, unknown> };
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [graph, input, { tenantId }],
        taskQueue: TASK_QUEUE,
        workflowId,
      });
      result = (await handle.result()) as {
        status: string;
        ctx: Record<string, unknown>;
      };
    });
    return result;
  }

  // --- switch: multi-way branch on the first matching rule, else fallback ---------------------
  const switchGraph: GraphDef = {
    startNodeId: "trigger",
    nodes: [
      { id: "trigger", type: "webhookTrigger" },
      {
        id: "sw",
        type: "switch",
        config: {
          rules: [
            {
              name: "high",
              condition: { path: "trigger.amount", op: "gt", value: 100 },
            },
            {
              name: "mid",
              condition: { path: "trigger.amount", op: "gt", value: 10 },
            },
          ],
          fallback: "low",
        },
      },
      { id: "tHigh", type: "set", config: { fields: { tier: "high" } } },
      { id: "tMid", type: "set", config: { fields: { tier: "mid" } } },
      { id: "tLow", type: "set", config: { fields: { tier: "low" } } },
      { id: "end", type: "end" },
    ],
    edges: [
      { from: "trigger", to: "sw" },
      {
        from: "sw",
        to: "tHigh",
        condition: { path: "sw.matched", op: "eq", value: "high" },
      },
      {
        from: "sw",
        to: "tMid",
        condition: { path: "sw.matched", op: "eq", value: "mid" },
      },
      {
        from: "sw",
        to: "tLow",
        condition: { path: "sw.matched", op: "eq", value: "low" },
      },
      { from: "tHigh", to: "end" },
      { from: "tMid", to: "end" },
      { from: "tLow", to: "end" },
    ],
  };

  it("switch: first matching rule wins (250 matches high AND mid → high) and only that branch runs", async () => {
    const r = await runFlow(switchGraph, { amount: 250 }, "e2e-switch-high");
    expect(r.status).toBe("completed");
    expect(r.ctx.sw).toEqual({ matched: "high" });
    expect(r.ctx.tHigh).toEqual({ tier: "high" });
    expect(r.ctx.tMid).toBeUndefined();
    expect(r.ctx.tLow).toBeUndefined();
  });

  it("switch: a later rule matches when the first doesn't (50 → mid)", async () => {
    const r = await runFlow(switchGraph, { amount: 50 }, "e2e-switch-mid");
    expect(r.ctx.sw).toEqual({ matched: "mid" });
    expect(r.ctx.tMid).toEqual({ tier: "mid" });
    expect(r.ctx.tHigh).toBeUndefined();
  });

  it("switch: no rule matches → the fallback branch (5 → low)", async () => {
    const r = await runFlow(switchGraph, { amount: 5 }, "e2e-switch-low");
    expect(r.ctx.sw).toEqual({ matched: "low" });
    expect(r.ctx.tLow).toEqual({ tier: "low" });
  });

  // --- if: boolean gate → true/false edges ----------------------------------------------------
  function ifGraph(config: Record<string, unknown>): GraphDef {
    return {
      startNodeId: "trigger",
      nodes: [
        { id: "trigger", type: "webhookTrigger" },
        { id: "gate", type: "if", config },
        { id: "tYes", type: "set", config: { fields: { took: "yes" } } },
        { id: "tNo", type: "set", config: { fields: { took: "no" } } },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "trigger", to: "gate" },
        {
          from: "gate",
          to: "tYes",
          condition: { path: "gate.result", op: "eq", value: true },
        },
        {
          from: "gate",
          to: "tNo",
          condition: { path: "gate.result", op: "eq", value: false },
        },
        { from: "tYes", to: "end" },
        { from: "tNo", to: "end" },
      ],
    };
  }

  it("if: a passing predicate takes the true edge", async () => {
    const g = ifGraph({
      conditions: [{ path: "trigger.amount", op: "gt", value: 100 }],
    });
    const r = await runFlow(g, { amount: 250 }, "e2e-if-true");
    expect(r.ctx.gate).toEqual({ result: true });
    expect(r.ctx.tYes).toEqual({ took: "yes" });
    expect(r.ctx.tNo).toBeUndefined();
  });

  it("if: a failing predicate takes the false edge", async () => {
    const g = ifGraph({
      conditions: [{ path: "trigger.amount", op: "gt", value: 100 }],
    });
    const r = await runFlow(g, { amount: 5 }, "e2e-if-false");
    expect(r.ctx.gate).toEqual({ result: false });
    expect(r.ctx.tNo).toEqual({ took: "no" });
    expect(r.ctx.tYes).toBeUndefined();
  });

  it("if: combine 'or' passes when any predicate holds; 'and' needs all", async () => {
    const or = ifGraph({
      combine: "or",
      conditions: [
        { path: "trigger.a", op: "eq", value: 1 },
        { path: "trigger.b", op: "eq", value: 2 },
      ],
    });
    expect((await runFlow(or, { a: 0, b: 2 }, "e2e-if-or")).ctx.gate).toEqual({
      result: true,
    });

    const and = ifGraph({
      combine: "and",
      conditions: [
        { path: "trigger.a", op: "eq", value: 1 },
        { path: "trigger.b", op: "eq", value: 2 },
      ],
    });
    expect((await runFlow(and, { a: 1, b: 0 }, "e2e-if-and")).ctx.gate).toEqual(
      { result: false },
    );
  });

  it("if: empty conditions ⇒ false (a gate with nothing to test doesn't pass)", async () => {
    const r = await runFlow(ifGraph({ conditions: [] }), {}, "e2e-if-empty");
    expect(r.ctx.gate).toEqual({ result: false });
    expect(r.ctx.tNo).toEqual({ took: "no" });
  });

  // --- edge-condition operators: the full op set, via a single-condition if gate --------------
  const OP_CASES: Array<{
    op: string;
    value?: unknown;
    v: unknown;
    expected: boolean;
  }> = [
    { op: "eq", value: "x", v: "x", expected: true },
    { op: "eq", value: "x", v: "y", expected: false },
    { op: "neq", value: "x", v: "y", expected: true },
    { op: "gt", value: 10, v: 20, expected: true },
    { op: "gt", value: 10, v: 5, expected: false },
    { op: "gte", value: 10, v: 10, expected: true },
    { op: "lt", value: 10, v: 5, expected: true },
    { op: "lte", value: 10, v: 10, expected: true },
    { op: "in", value: ["a", "b"], v: "b", expected: true },
    { op: "in", value: ["a", "b"], v: "c", expected: false },
    { op: "contains", value: "ell", v: "hello", expected: true },
    { op: "notContains", value: "z", v: "hello", expected: true },
    { op: "startsWith", value: "he", v: "hello", expected: true },
    { op: "endsWith", value: "lo", v: "hello", expected: true },
    { op: "regex", value: "^h.*o$", v: "hello", expected: true },
    { op: "exists", v: "present", expected: true },
    { op: "isEmpty", v: "", expected: true },
    { op: "notEmpty", v: "x", expected: true },
  ];

  it.each(OP_CASES)(
    "edge condition op '$op' (value=$value, v=$v) → $expected",
    async ({ op, value, v, expected }) => {
      const condition =
        value === undefined
          ? { path: "trigger.v", op }
          : { path: "trigger.v", op, value };
      const g = ifGraph({ conditions: [condition] });
      const r = await runFlow(g, { v }, `e2e-op-${op}-${String(v)}`);
      expect(r.ctx.gate).toEqual({ result: expected });
    },
  );

  // --- diamond: unconditional fan-out to 3 parallel branches → merge (object) ------------------
  it("diamond: fan-out to 3 parallel set nodes, merge combines all (multi-path join)", async () => {
    const diamond: GraphDef = {
      startNodeId: "trigger",
      nodes: [
        { id: "trigger", type: "webhookTrigger" },
        { id: "a", type: "set", config: { fields: { a: 1 } } },
        { id: "b", type: "set", config: { fields: { b: 2 } } },
        { id: "c", type: "set", config: { fields: { c: 3 } } },
        { id: "join", type: "merge", config: { mode: "object" } },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "trigger", to: "a" },
        { from: "trigger", to: "b" },
        { from: "trigger", to: "c" },
        { from: "a", to: "join" },
        { from: "b", to: "join" },
        { from: "c", to: "join" },
        { from: "join", to: "end" },
      ],
    };
    const r = await runFlow(diamond, {}, "e2e-diamond");
    expect(r.status).toBe("completed");
    expect(r.ctx.join).toEqual({ a: 1, b: 2, c: 3 });
  });

  // --- nested: if → (true) switch → branch; the false branch is never entered -----------------
  it("nested if→switch: chained conditionals route to the deep branch", async () => {
    const nested: GraphDef = {
      startNodeId: "trigger",
      nodes: [
        { id: "trigger", type: "webhookTrigger" },
        {
          id: "gate",
          type: "if",
          config: {
            conditions: [{ path: "trigger.amount", op: "gt", value: 0 }],
          },
        },
        {
          id: "sw",
          type: "switch",
          config: {
            rules: [
              {
                name: "b",
                condition: { path: "trigger.category", op: "eq", value: "b" },
              },
            ],
            fallback: "other",
          },
        },
        { id: "hitB", type: "set", config: { fields: { path: "b" } } },
        { id: "hitOther", type: "set", config: { fields: { path: "other" } } },
        { id: "neg", type: "set", config: { fields: { path: "neg" } } },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "trigger", to: "gate" },
        {
          from: "gate",
          to: "sw",
          condition: { path: "gate.result", op: "eq", value: true },
        },
        {
          from: "gate",
          to: "neg",
          condition: { path: "gate.result", op: "eq", value: false },
        },
        {
          from: "sw",
          to: "hitB",
          condition: { path: "sw.matched", op: "eq", value: "b" },
        },
        {
          from: "sw",
          to: "hitOther",
          condition: { path: "sw.matched", op: "eq", value: "other" },
        },
        { from: "hitB", to: "end" },
        { from: "hitOther", to: "end" },
        { from: "neg", to: "end" },
      ],
    };
    const r = await runFlow(nested, { amount: 5, category: "b" }, "e2e-nested");
    expect(r.status).toBe("completed");
    expect(r.ctx.gate).toEqual({ result: true });
    expect(r.ctx.sw).toEqual({ matched: "b" });
    expect(r.ctx.hitB).toEqual({ path: "b" });
    expect(r.ctx.hitOther).toBeUndefined();
    expect(r.ctx.neg).toBeUndefined();
  });
});

/**
 * Per-node execution matrix (Part 2): prove every remaining node type actually RUNS through the real
 * interpreter and produces its documented output. Part 1 covered the conditional/routing nodes and the
 * I/O nodes above; this block fills the gaps — the pure transforms (noOp/number), the activity-backed
 * transforms (csv/encode/hash/htmlExtract/markdown/random), and the three passthrough entry triggers
 * (chatTrigger/formTrigger/scheduleTrigger). Config shapes + output shapes are taken from the DSL
 * schema (packages/dsl/src/registry.ts) and the interpreter's own dispatch (workflow/run-graph.ts).
 *
 * Note: `regex`, `group`, and `summary` are NOT node types — `regex` is a ConditionOp and
 * group/summary are catalog metadata fields. The intent is already covered: `text` (regexExtract) and
 * `aggregate` are tested elsewhere in this file.
 */
describe("runGraph interpreter — per-node execution matrix", () => {
  // Local run helper: start the graph, await the terminal result, return { status, ctx }.
  async function runFlow(
    graph: GraphDef,
    input: unknown,
    workflowId: string,
    tenantId = "t-matrix",
  ): Promise<{ status: string; ctx: Record<string, unknown> }> {
    const worker = await makeWorker(env);
    return worker.runUntil(async () => {
      const handle = await env.client.workflow.start(runGraph, {
        args: [graph, input, { tenantId }],
        taskQueue: TASK_QUEUE,
        workflowId,
      });
      return (await handle.result()) as {
        status: string;
        ctx: Record<string, unknown>;
      };
    });
  }

  // Build a linear `webhookTrigger → <node> → end` graph feeding the node the run input.
  function oneNodeGraph(id: string, type: string, config?: unknown): GraphDef {
    return {
      startNodeId: "trigger",
      nodes: [
        { id: "trigger", type: "webhookTrigger" },
        { id, type, ...(config ? { config } : {}) },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "trigger", to: id },
        { from: id, to: "end" },
      ],
    } as GraphDef;
  }

  // ── A. Pure transform nodes ────────────────────────────────────────────────

  it("noOp: emits {} and passes control through (structural placeholder)", async () => {
    const result = await runFlow(
      oneNodeGraph("nop", "noOp"),
      { anything: 1 },
      "e2e-matrix-noop",
    );
    expect(result.status).toBe("completed");
    expect(result.ctx.nop).toEqual({});
  });

  it("number: runs the arithmetic op on static + bound operands → { result } (pure)", async () => {
    // a is static (6); b binds from the trigger (7) → multiply = 42. Proves both operand paths.
    const result = await runFlow(
      oneNodeGraph("calc", "number", {
        operation: "multiply",
        a: 6,
        bBinding: { from: "trigger", path: "factor" },
      }),
      { factor: 7 },
      "e2e-matrix-number",
    );
    expect(result.status).toBe("completed");
    expect(result.ctx.calc).toEqual({ result: 42 });
  });

  it("csv: passes {operation,header,delimiter} + resolved input to the activity; stores res.result", async () => {
    csvCalls.length = 0;
    const result = await runFlow(
      oneNodeGraph("parse", "csv", {
        operation: "parse",
        from: "trigger",
        path: "raw",
        header: true,
        delimiter: ",",
      }),
      { raw: "id,name\n1,Ada" },
      "e2e-matrix-csv",
    );
    expect(result.status).toBe("completed");
    // ctx.<node> IS the activity's `result` (interpreter unwraps .result for csv)
    expect(result.ctx.parse).toEqual([{ id: "1", name: "Ada" }]);
    // the interpreter resolved the input value from the trigger + threaded the parse options
    expect(csvCalls[0].input).toBe("id,name\n1,Ada");
    expect(csvCalls[0].cfg).toEqual({
      operation: "parse",
      header: true,
      delimiter: ",",
    });
  });

  it("encode: resolves input + operation, stores { result } (wrapped)", async () => {
    encodeCalls.length = 0;
    const result = await runFlow(
      oneNodeGraph("enc", "encode", {
        operation: "base64Encode",
        from: "trigger",
        path: "text",
      }),
      { text: "hi" },
      "e2e-matrix-encode",
    );
    expect(result.status).toBe("completed");
    // encode WRAPS: ctx.<node> = { result: res.result }
    expect(result.ctx.enc).toEqual({ result: "enc(hi)" });
    expect(encodeCalls[0].input).toBe("hi");
    expect(encodeCalls[0].cfg).toEqual({ operation: "base64Encode" });
  });

  it("hash: resolves the bound input in-workflow, hashes in-activity → { digest }", async () => {
    hashCalls.length = 0;
    const result = await runFlow(
      oneNodeGraph("h", "hash", {
        algorithm: "sha256",
        inputBinding: { from: "trigger", path: "body" },
        encoding: "hex",
      }),
      { body: { amount: 5 } },
      "e2e-matrix-hash",
    );
    expect(result.status).toBe("completed");
    expect(result.ctx.h).toEqual({ digest: "deadbeef" });
    // resolveHash threaded the bound value + algorithm/encoding into the activity (key never here)
    expect(hashCalls[0]).toEqual({
      algorithm: "sha256",
      input: { amount: 5 },
      encoding: "hex",
    });
  });

  it("htmlExtract: passes selectors + resolved HTML to the activity; stores res.result", async () => {
    htmlExtractCalls.length = 0;
    const result = await runFlow(
      oneNodeGraph("x", "htmlExtract", {
        from: "trigger",
        path: "html",
        extractions: [{ key: "title", selector: "h1" }],
      }),
      { html: "<h1>Hello</h1>" },
      "e2e-matrix-html",
    );
    expect(result.status).toBe("completed");
    expect(result.ctx.x).toEqual({ title: "Hello" });
    expect(htmlExtractCalls[0].input).toBe("<h1>Hello</h1>");
    expect(htmlExtractCalls[0].cfg).toEqual({
      extractions: [{ key: "title", selector: "h1" }],
    });
  });

  it("markdown: passes the resolved HTML to the activity; stores res.result", async () => {
    markdownCalls.length = 0;
    const result = await runFlow(
      oneNodeGraph("md", "markdown", { from: "trigger", path: "html" }),
      { html: "<h1>Hi</h1>" },
      "e2e-matrix-markdown",
    );
    expect(result.status).toBe("completed");
    expect(result.ctx.md).toEqual({ markdown: "# Hi" });
    // callMarkdown's first positional arg is the INPUT (no cfg param) — proves the resolved value
    expect(markdownCalls[0]).toBe("<h1>Hi</h1>");
  });

  // ── C. random (activity — Math.random is banned in workflow code) ──────────

  it("random: runs in an activity and threads its value downstream", async () => {
    randomCalls.length = 0;
    // trigger → rnd(random) → capture(set binds from rnd.value) → end. Proves the node runs AND its
    // value flows into a downstream node's output (not just sits in ctx).
    const graph: GraphDef = {
      startNodeId: "trigger",
      nodes: [
        { id: "trigger", type: "webhookTrigger" },
        {
          id: "rnd",
          type: "random",
          config: { operation: "hex", length: 16 },
        },
        {
          id: "capture",
          type: "set",
          config: { fieldBindings: { token: { from: "rnd", path: "value" } } },
        },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "trigger", to: "rnd" },
        { from: "rnd", to: "capture" },
        { from: "capture", to: "end" },
      ],
    };
    const result = await runFlow(graph, {}, "e2e-matrix-random");
    expect(result.status).toBe("completed");
    // output is { value } (the activity generates it — no input)
    expect(result.ctx.rnd).toEqual({ value: "r4nd0mhex" });
    // the config (operation + length) reached the activity
    expect(randomCalls[0]).toEqual({
      operation: "hex",
      length: 16,
      min: undefined,
      max: undefined,
    });
    // …and the value threaded into the downstream set node
    expect(result.ctx.capture).toEqual({ token: "r4nd0mhex" });
  });

  // ── B. Entry trigger nodes (output == the trigger event/fields) ────────────

  it.each([
    ["scheduleTrigger", { cron: "0 0 * * *" }],
    ["formTrigger", { title: "Contact" }],
    ["chatTrigger", {}],
  ] as const)(
    "%s: entry passthrough — the run input becomes the trigger node's output",
    async (type, config) => {
      const event = { message: "hello", sessionId: "s-1", n: 3 };
      const graph: GraphDef = {
        startNodeId: "trig",
        nodes: [
          { id: "trig", type, config },
          { id: "end", type: "end" },
        ],
        edges: [{ from: "trig", to: "end" }],
      } as GraphDef;
      const result = await runFlow(graph, event, `e2e-matrix-${type}`);
      expect(result.status).toBe("completed");
      // the inbound event IS the entry node's output (like webhookTrigger)
      expect(result.ctx.trig).toEqual(event);
    },
  );
});
