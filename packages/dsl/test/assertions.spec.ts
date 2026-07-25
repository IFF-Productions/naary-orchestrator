// Workflow evals (#575) — assertions v1 + the dataset write gate.
import { describe, expect, it } from "vitest";
import {
  aggregateVerdict,
  assertionLabel,
  assertionsForCase,
  buildPersistableOutcome,
  DEFAULT_JUDGE_THRESHOLD,
  evalDatasetBodySchema,
  evaluateDeterministicAssertion,
  InvalidEvalDatasetError,
  isLlmJudge,
  judgeOutcome,
  parseEvalDatasetBody,
  type Assertion,
} from "../src/assertions";

/** A representative child-run ctx: node id → node output. */
const CTX = {
  agent: { status: "ok", output: { category: "billing", urgency: 4 } },
  http: { httpStatus: 200, body: { items: [{ id: 1 }, { id: 2 }] } },
  tags: ["refund", "urgent"],
  score: 0.82,
};

const ev = (a: Assertion, i = 0) => evaluateDeterministicAssertion(a, CTX, i);

describe("jsonPathEquals", () => {
  it("passes on a deep-equal value", () => {
    expect(
      ev({
        kind: "jsonPathEquals",
        path: "agent.output.category",
        value: "billing",
      }),
    ).toEqual({
      label: "jsonPathEquals#0",
      kind: "jsonPathEquals",
      passed: true,
      score: 1,
    });
  });

  it("compares OBJECTS structurally (key order irrelevant, array order relevant)", () => {
    expect(
      ev({
        kind: "jsonPathEquals",
        path: "agent.output",
        value: { urgency: 4, category: "billing" },
      }).passed,
    ).toBe(true);
    expect(
      ev({ kind: "jsonPathEquals", path: "tags", value: ["urgent", "refund"] })
        .passed,
    ).toBe(false);
  });

  it("fails on a mismatch, and reports missing-path for an absent path", () => {
    expect(
      ev({
        kind: "jsonPathEquals",
        path: "agent.output.category",
        value: "sales",
      }),
      // A plain mismatch carries NO error code — the assertion ran fine, the answer was wrong.
      // (`error` is absent from the object, not present-and-undefined.)
    ).toEqual({
      label: "jsonPathEquals#0",
      kind: "jsonPathEquals",
      passed: false,
      score: 0,
    });
    expect(
      ev({ kind: "jsonPathEquals", path: "nope.nope", value: 1 }).error,
    ).toBe("missing-path");
  });

  it("uses the author's label when given", () => {
    expect(
      ev({
        kind: "jsonPathEquals",
        label: "is-billing",
        path: "agent.output.category",
        value: "billing",
      }).label,
    ).toBe("is-billing");
  });
});

describe("jsonPathContains", () => {
  it("matches array MEMBERSHIP", () => {
    expect(
      ev({ kind: "jsonPathContains", path: "tags", value: "urgent" }).passed,
    ).toBe(true);
    expect(
      ev({ kind: "jsonPathContains", path: "tags", value: "nope" }).passed,
    ).toBe(false);
  });

  it("matches a SUBSTRING of a string, and of a stringified object", () => {
    expect(
      ev({
        kind: "jsonPathContains",
        path: "agent.output.category",
        value: "bill",
      }).passed,
    ).toBe(true);
    expect(
      ev({ kind: "jsonPathContains", path: "http.body", value: '"id":2' })
        .passed,
    ).toBe(true);
  });
});

describe("numericTolerance", () => {
  it("honours the tolerance window (defaulting to exact)", () => {
    expect(
      ev({
        kind: "numericTolerance",
        path: "score",
        expected: 0.8,
        tolerance: 0.05,
      }).passed,
    ).toBe(true);
    expect(
      ev({
        kind: "numericTolerance",
        path: "score",
        expected: 0.8,
        tolerance: 0.01,
      }).passed,
    ).toBe(false);
    expect(
      ev({ kind: "numericTolerance", path: "score", expected: 0.82 }).passed,
    ).toBe(true);
  });

  it("coerces a numeric string but reports not-a-number otherwise", () => {
    expect(
      evaluateDeterministicAssertion(
        { kind: "numericTolerance", path: "n", expected: 5 },
        { n: "5" },
        0,
      ).passed,
    ).toBe(true);
    expect(
      evaluateDeterministicAssertion(
        { kind: "numericTolerance", path: "n", expected: 5 },
        { n: "abc" },
        0,
      ).error,
    ).toBe("not-a-number");
  });
});

describe("schemaValid (real zod, compiled from JSON Schema)", () => {
  const schema = {
    type: "object",
    properties: { category: { type: "string" }, urgency: { type: "number" } },
    required: ["category", "urgency"],
  };

  it("passes a conforming value and fails a non-conforming one", () => {
    expect(
      ev({ kind: "schemaValid", path: "agent.output", schema }).passed,
    ).toBe(true);
    expect(
      evaluateDeterministicAssertion(
        { kind: "schemaValid", path: "o", schema },
        { o: { category: "x" } },
        0,
      ).passed,
    ).toBe(false);
  });

  it("enforces additionalProperties: false", () => {
    expect(
      evaluateDeterministicAssertion(
        {
          kind: "schemaValid",
          path: "o",
          schema: {
            type: "object",
            properties: { a: { type: "string" } },
            required: ["a"],
            additionalProperties: false,
          },
        },
        { o: { a: "x", extra: 1 } },
        0,
      ).passed,
    ).toBe(false);
  });

  it("an UNCONVERTIBLE schema is an assertion ERROR, never a silent pass", () => {
    const r = ev({
      kind: "schemaValid",
      path: "agent.output",
      schema: { type: "nonsense" },
    });
    expect(r.passed).toBe(false);
    expect(r.error).toBe("invalid-schema");
  });

  it("reports missing-path when the addressed value is absent", () => {
    expect(ev({ kind: "schemaValid", path: "nope", schema }).error).toBe(
      "missing-path",
    );
  });
});

describe("llmJudge", () => {
  it("is not evaluable deterministically (the activity handles it)", () => {
    expect(isLlmJudge({ kind: "llmJudge", criteria: "polite?" })).toBe(true);
    expect(ev({ kind: "llmJudge", criteria: "polite?" }).error).toBe(
      "judge-unavailable",
    );
  });

  it("turns a score into pass/fail at the threshold (default 0.7) and clamps", () => {
    const a = { kind: "llmJudge", criteria: "c" } as const;
    expect(judgeOutcome(a, 0, 0.7).passed).toBe(true);
    expect(judgeOutcome(a, 0, 0.69).passed).toBe(false);
    expect(judgeOutcome({ ...a, threshold: 0.5 }, 0, 0.6).passed).toBe(true);
    expect(judgeOutcome(a, 0, 42).score).toBe(1);
    expect(judgeOutcome(a, 0, -3).score).toBe(0);
    expect(judgeOutcome(a, 0, Number.NaN).score).toBe(0);
    expect(DEFAULT_JUDGE_THRESHOLD).toBe(0.7);
  });
});

describe("buildPersistableOutcome — the privacy allowlist", () => {
  it("keeps ONLY label/kind/passed/score/error, dropping anything else a caller passes", () => {
    const o = buildPersistableOutcome({
      label: "l",
      kind: "llmJudge",
      passed: true,
      score: 0.9,
      // Extra fields a future refactor might spread in — must not survive.
      ...({
        reason: "because the OUTPUT said Ada's card was declined",
        actual: "secret",
      } as never),
    });
    expect(Object.keys(o).sort()).toEqual(["kind", "label", "passed", "score"]);
    expect(JSON.stringify(o)).not.toContain("Ada");
    expect(JSON.stringify(o)).not.toContain("secret");
  });

  it("includes `error` only when present", () => {
    expect(
      buildPersistableOutcome({
        label: "l",
        kind: "schemaValid",
        passed: false,
        score: 0,
        error: "invalid-schema",
      }).error,
    ).toBe("invalid-schema");
  });
});

describe("aggregateVerdict", () => {
  const o = (passed: boolean, score: number, error?: "missing-path") =>
    buildPersistableOutcome({
      label: "l",
      kind: "jsonPathEquals",
      passed,
      score,
      error,
    });

  it("all passed ⇒ pass; any failed ⇒ fail; score is the mean", () => {
    expect(aggregateVerdict([o(true, 1), o(true, 1)])).toEqual({
      verdict: "pass",
      score: 1,
    });
    expect(aggregateVerdict([o(true, 1), o(false, 0)])).toEqual({
      verdict: "fail",
      score: 0.5,
    });
  });

  it("an ERRORED assertion ⇒ 'error', NOT 'fail' (a promote screen must not conflate them)", () => {
    expect(
      aggregateVerdict([o(true, 1), o(false, 0, "missing-path")]).verdict,
    ).toBe("error");
  });

  it("no assertions ⇒ pass (the case proved the graph runs end to end)", () => {
    expect(aggregateVerdict([])).toEqual({ verdict: "pass", score: 1 });
  });
});

describe("assertionsForCase / assertionLabel", () => {
  it("dataset-level assertions come FIRST, then the case's own (label indices depend on it)", () => {
    const dataset = {
      assertions: [
        {
          kind: "jsonPathEquals",
          label: "d1",
          path: "a",
          value: 1,
        } as Assertion,
      ],
      cases: [],
    };
    const merged = assertionsForCase(dataset, {
      name: "c",
      input: {},
      assertions: [
        {
          kind: "jsonPathEquals",
          label: "c1",
          path: "b",
          value: 2,
        } as Assertion,
      ],
    });
    expect(merged.map((a) => a.label)).toEqual(["d1", "c1"]);
  });

  it("falls back to a stable <kind>#<index> label", () => {
    expect(
      assertionLabel({ kind: "jsonPathEquals", path: "a", value: 1 }, 3),
    ).toBe("jsonPathEquals#3");
    expect(
      assertionLabel(
        { kind: "jsonPathEquals", label: "  ", path: "a", value: 1 },
        3,
      ),
    ).toBe("jsonPathEquals#3");
  });
});

describe("evalDatasetBodySchema — the write gate", () => {
  const ok = {
    assertions: [
      {
        kind: "jsonPathEquals",
        label: "cat",
        path: "agent.output.category",
        value: "billing",
      },
    ],
    cases: [
      { name: "double-charge", input: { message: "charged twice" } },
      {
        name: "greeting",
        input: { message: "hi" },
        assertions: [{ kind: "llmJudge", criteria: "polite?", threshold: 0.8 }],
      },
    ],
  };

  it("accepts a realistic dataset", () => {
    expect(evalDatasetBodySchema.parse(ok)).toEqual(ok);
  });

  it("rejects DUPLICATE case names (they key the result rows)", () => {
    const res = evalDatasetBodySchema.safeParse({
      cases: [
        { name: "same", input: 1 },
        { name: "same", input: 2 },
      ],
    });
    expect(res.success).toBe(false);
    expect(JSON.stringify(res.error?.issues)).toContain("unique");
  });

  it("rejects an empty case list, an unknown assertion kind, and a typo'd key", () => {
    expect(evalDatasetBodySchema.safeParse({ cases: [] }).success).toBe(false);
    expect(
      evalDatasetBodySchema.safeParse({
        cases: [{ name: "a", input: 1, assertions: [{ kind: "vibes" }] }],
      }).success,
    ).toBe(false);
    expect(
      evalDatasetBodySchema.safeParse({
        cases: [{ name: "a", input: 1, expectations: [] }],
      }).success,
    ).toBe(false);
  });

  it("rejects an out-of-range judge threshold", () => {
    expect(
      evalDatasetBodySchema.safeParse({
        cases: [
          {
            name: "a",
            input: 1,
            assertions: [{ kind: "llmJudge", criteria: "c", threshold: 1.5 }],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("parseEvalDatasetBody throws (never degrades) on a malformed stored body", () => {
    expect(() => parseEvalDatasetBody({ cases: "nope" })).toThrow(
      InvalidEvalDatasetError,
    );
    expect(parseEvalDatasetBody(ok).cases).toHaveLength(2);
  });
});
