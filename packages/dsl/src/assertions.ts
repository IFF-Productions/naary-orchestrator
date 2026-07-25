/**
 * WORKFLOW EVALS (#575) — golden-dataset cases + assertions v1.
 *
 * TIER-1 LANDMINE (CLAUDE.md rule 2), same as ./registry: this module imports zod, so it is
 * DELIBERATELY NOT re-exported from ./index — the worker's `@naary/dsl` import surface stays
 * zod-free and nothing here can enter the deterministic workflow bundle. The API and the eval
 * ACTIVITY import it directly (`@naary/dsl/dist/assertions`). Assertions are evaluated in an
 * activity by design (the issue says so, and the LLM-judge assertion is a network call).
 *
 * PRIVACY (the issue's ledger rule, extended to eval results): an {@link AssertionOutcome} carries a
 * LABEL, a kind, a boolean, a 0–1 score, and an optional short error CODE. It never carries the
 * actual value, the expected value, or the judge's prose. `buildPersistableOutcome` is the single
 * constructor for what may be written to Postgres — an explicit allowlist, not a spread-and-delete,
 * so a later refactor cannot quietly widen it.
 */
import { z } from "zod";
import { getByPath } from "./mcp-args";

// ---------------------------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------------------------

export type AssertionKind =
  | "jsonPathEquals"
  | "jsonPathContains"
  | "schemaValid"
  | "numericTolerance"
  | "llmJudge";

/** Deep-equality of the value at `path` (a run-ctx path, e.g. "agent.output.category"). */
export interface JsonPathEqualsAssertion {
  kind: "jsonPathEquals";
  label?: string;
  path: string;
  value: unknown;
}

/** The value at `path`, stringified, contains `value`. Also covers array membership. */
export interface JsonPathContainsAssertion {
  kind: "jsonPathContains";
  label?: string;
  path: string;
  value: string;
}

/** The value at `path` (or the whole ctx when omitted) validates against a JSON Schema, compiled
 *  to a real zod schema via `z.fromJSONSchema`. An unconvertible schema is an assertion ERROR
 *  surfaced to the author — never a silent pass. */
export interface SchemaValidAssertion {
  kind: "schemaValid";
  label?: string;
  path?: string;
  schema: Record<string, unknown>;
}

/** |actual − expected| ≤ tolerance (tolerance defaults to 0). */
export interface NumericToleranceAssertion {
  kind: "numericTolerance";
  label?: string;
  path: string;
  expected: number;
  tolerance?: number;
}

/**
 * OPTIONAL LLM-judge assertion. Evaluated in the eval activity by the SAME BYOK agent path a real
 * agent node uses, so it is reserved + billed through the existing reservation/ledger with the
 * rule-6 fail-safe. `threshold` (default 0.7) turns the judge's 0–1 score into pass/fail.
 */
export interface LlmJudgeAssertion {
  kind: "llmJudge";
  label?: string;
  /** What to judge; omitted ⇒ the whole run ctx. */
  path?: string;
  /** The rubric handed to the judge. Operator-authored text, not run data. */
  criteria: string;
  provider?: string;
  model?: string;
  threshold?: number;
}

export type Assertion =
  | JsonPathEqualsAssertion
  | JsonPathContainsAssertion
  | SchemaValidAssertion
  | NumericToleranceAssertion
  | LlmJudgeAssertion;

/** Default pass threshold for a judge score. */
export const DEFAULT_JUDGE_THRESHOLD = 0.7;

/** Short, enumerated reasons an assertion could not be evaluated. A CODE is not content, so it is
 *  safe to persist — unlike "expected X, got Y", which would carry the model's output. */
export type AssertionErrorCode =
  "missing-path" | "invalid-schema" | "not-a-number" | "judge-unavailable";

/** The persistable result of one assertion. See the privacy note at the top of the file. */
export interface AssertionOutcome {
  /** The author's `label`, else a stable `"<kind>#<index>"`. */
  label: string;
  kind: AssertionKind;
  passed: boolean;
  /** 0–1. Deterministic assertions are exactly 1 or 0; the judge reports its own score. */
  score: number;
  error?: AssertionErrorCode;
}

/** Stable label for an assertion, so a result row is comparable across eval runs. */
export function assertionLabel(a: Assertion, index: number): string {
  return a.label?.trim() || `${a.kind}#${index}`;
}

export function isLlmJudge(a: Assertion): a is LlmJudgeAssertion {
  return a.kind === "llmJudge";
}

/**
 * THE ONLY constructor for a persistable outcome. Explicit field allowlist — never a spread of a
 * richer internal object. Anything with run/model CONTENT (an actual value, the judge's prose
 * reasoning) is dropped here structurally rather than by a later `delete`.
 */
export function buildPersistableOutcome(o: {
  label: string;
  kind: AssertionKind;
  passed: boolean;
  score: number;
  error?: AssertionErrorCode;
}): AssertionOutcome {
  return {
    label: o.label,
    kind: o.kind,
    passed: o.passed,
    score: o.score,
    ...(o.error ? { error: o.error } : {}),
  };
}

/** `path`-relative read against the run ctx. An omitted path reads the whole ctx. */
function valueAt(ctx: unknown, path: string | undefined): unknown {
  return path === undefined || path === "" ? ctx : getByPath(ctx, path);
}

/**
 * Evaluate ONE deterministic assertion (everything except `llmJudge`) against a run's ctx. PURE:
 * no I/O, no clock. Never throws — an unusable assertion becomes `passed: false` with an error code,
 * because a thrown assertion would fail the whole eval case for an authoring mistake.
 */
export function evaluateDeterministicAssertion(
  assertion: Assertion,
  ctx: unknown,
  index: number,
): AssertionOutcome {
  const label = assertionLabel(assertion, index);
  const fail = (error?: AssertionErrorCode) =>
    buildPersistableOutcome({
      label,
      kind: assertion.kind,
      passed: false,
      score: 0,
      error,
    });
  const pass = () =>
    buildPersistableOutcome({
      label,
      kind: assertion.kind,
      passed: true,
      score: 1,
    });

  switch (assertion.kind) {
    case "jsonPathEquals": {
      const actual = valueAt(ctx, assertion.path);
      if (actual === undefined) return fail("missing-path");
      return deepEqual(actual, assertion.value) ? pass() : fail();
    }
    case "jsonPathContains": {
      const actual = valueAt(ctx, assertion.path);
      if (actual === undefined) return fail("missing-path");
      // Array membership first (the common "one of these tags" case), then substring.
      if (Array.isArray(actual)) {
        return actual.some(
          (v) => v === assertion.value || stringify(v) === assertion.value,
        )
          ? pass()
          : fail();
      }
      return stringify(actual).includes(assertion.value) ? pass() : fail();
    }
    case "numericTolerance": {
      const actual = valueAt(ctx, assertion.path);
      if (actual === undefined) return fail("missing-path");
      const n = typeof actual === "number" ? actual : Number(actual);
      if (!Number.isFinite(n)) return fail("not-a-number");
      return Math.abs(n - assertion.expected) <= (assertion.tolerance ?? 0)
        ? pass()
        : fail();
    }
    case "schemaValid": {
      let schema: z.ZodTypeAny;
      try {
        // `z.fromJSONSchema` THROWS at conversion time on an unsupported/malformed schema (verified:
        // `{type:"nonsense"}` and a non-object both throw). That is an authoring error, so it becomes
        // a visible assertion error rather than a silent pass or a failed activity.
        schema = z.fromJSONSchema(
          assertion.schema as Parameters<typeof z.fromJSONSchema>[0],
        ) as z.ZodTypeAny;
      } catch {
        return fail("invalid-schema");
      }
      const actual = valueAt(ctx, assertion.path);
      if (actual === undefined && assertion.path) return fail("missing-path");
      try {
        return schema.safeParse(actual).success ? pass() : fail();
      } catch {
        return fail("invalid-schema");
      }
    }
    case "llmJudge":
      // Not evaluable without a model call — the eval activity handles this kind separately.
      return fail("judge-unavailable");
  }
}

/** Turn a judge's 0–1 score into an outcome. */
export function judgeOutcome(
  assertion: LlmJudgeAssertion,
  index: number,
  score: number,
): AssertionOutcome {
  const clamped = Number.isFinite(score) ? Math.min(1, Math.max(0, score)) : 0;
  return buildPersistableOutcome({
    label: assertionLabel(assertion, index),
    kind: "llmJudge",
    passed: clamped >= (assertion.threshold ?? DEFAULT_JUDGE_THRESHOLD),
    score: clamped,
  });
}

export type CaseVerdict = "pass" | "fail" | "error";

/**
 * Collapse a case's assertion outcomes into a verdict + mean score.
 *   - any assertion with an ERROR code ⇒ "error" (the case could not be judged, which is NOT the
 *     same as the workflow producing a wrong answer, and a promote screen must not conflate them)
 *   - else all passed ⇒ "pass"; otherwise "fail"
 *   - NO assertions at all ⇒ "pass" with score 1: the case proved the graph runs end to end.
 */
export function aggregateVerdict(outcomes: AssertionOutcome[]): {
  verdict: CaseVerdict;
  score: number;
} {
  if (outcomes.length === 0) return { verdict: "pass", score: 1 };
  const score = outcomes.reduce((s, o) => s + o.score, 0) / outcomes.length;
  if (outcomes.some((o) => o.error !== undefined)) {
    return { verdict: "error", score };
  }
  return {
    verdict: outcomes.every((o) => o.passed) ? "pass" : "fail",
    score,
  };
}

function stringify(v: unknown): string {
  return typeof v === "string" ? v : (JSON.stringify(v) ?? String(v));
}

/** Structural deep equality (order-sensitive for arrays, key-order-insensitive for objects). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  return (
    ak.length === bk.length &&
    ak.every(
      (k) =>
        Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]),
    )
  );
}

// ---------------------------------------------------------------------------------------------
// Golden datasets
// ---------------------------------------------------------------------------------------------

/** One golden case: a trigger payload plus the properties its run must satisfy. */
export interface EvalCase {
  /** Unique within the dataset — it is the result row's key, so it must be stable across runs. */
  name: string;
  /** The trigger payload the workflow is started with. */
  input: unknown;
  /** Case-specific assertions, appended to the dataset's shared ones. */
  assertions?: Assertion[];
}

/** A named golden dataset for one workflow. */
export interface EvalDatasetBody {
  /** Assertions applied to EVERY case (a case's own are appended). */
  assertions?: Assertion[];
  cases: EvalCase[];
}

/** Cap on cases per dataset — one eval run launches one child workflow per case. */
export const MAX_EVAL_CASES = 200;
/** Cap on assertions per case (dataset-level + case-level, after merging). */
export const MAX_ASSERTIONS_PER_CASE = 50;

/** The effective assertion list for a case: dataset-level first, then the case's own. Order is the
 *  assertion INDEX used in a generated label, so it must be stable. */
export function assertionsForCase(
  dataset: EvalDatasetBody,
  c: EvalCase,
): Assertion[] {
  return [...(dataset.assertions ?? []), ...(c.assertions ?? [])].slice(
    0,
    MAX_ASSERTIONS_PER_CASE,
  );
}

// --- zod write gate (API) ---------------------------------------------------------------------

const jsonValue = z.unknown();

const assertionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("jsonPathEquals"),
    label: z.string().max(80).optional(),
    path: z.string().min(1).max(200),
    value: jsonValue,
  }),
  z.object({
    kind: z.literal("jsonPathContains"),
    label: z.string().max(80).optional(),
    path: z.string().min(1).max(200),
    value: z.string().max(2000),
  }),
  z.object({
    kind: z.literal("schemaValid"),
    label: z.string().max(80).optional(),
    path: z.string().max(200).optional(),
    schema: z.record(z.string(), z.unknown()),
  }),
  z.object({
    kind: z.literal("numericTolerance"),
    label: z.string().max(80).optional(),
    path: z.string().min(1).max(200),
    expected: z.number(),
    tolerance: z.number().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal("llmJudge"),
    label: z.string().max(80).optional(),
    path: z.string().max(200).optional(),
    criteria: z.string().min(1).max(4000),
    provider: z.string().max(40).optional(),
    model: z.string().max(120).optional(),
    threshold: z.number().min(0).max(1).optional(),
  }),
]);

export const evalDatasetBodySchema = z
  .object({
    assertions: z
      .array(assertionSchema)
      .max(MAX_ASSERTIONS_PER_CASE)
      .optional(),
    cases: z
      .array(
        z
          .object({
            name: z.string().min(1).max(120),
            input: jsonValue,
            assertions: z
              .array(assertionSchema)
              .max(MAX_ASSERTIONS_PER_CASE)
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_EVAL_CASES),
  })
  .strict()
  // Case names key the result rows (`@@unique([evalRunId, caseName])`), so a duplicate would make
  // one case silently overwrite another's verdict. Reject it at save.
  .refine(
    (d) => new Set(d.cases.map((c) => c.name)).size === d.cases.length,
    "case names must be unique within a dataset",
  );

/** A stored dataset body that does not match the schema. */
export class InvalidEvalDatasetError extends Error {
  constructor(readonly issues: { path: string; message: string }[]) {
    super(
      `Invalid eval dataset — ${issues
        .map((i) => `${i.path || "dataset"} ${i.message}`)
        .join("; ")}`,
    );
    this.name = "InvalidEvalDatasetError";
  }
}

/** Parse a stored/incoming dataset body. Throws (never degrades) on a malformed value. */
export function parseEvalDatasetBody(value: unknown): EvalDatasetBody {
  const res = evalDatasetBodySchema.safeParse(value);
  if (!res.success) {
    throw new InvalidEvalDatasetError(
      res.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    );
  }
  return res.data as EvalDatasetBody;
}
