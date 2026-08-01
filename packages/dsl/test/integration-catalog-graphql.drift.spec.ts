import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  Kind,
  type OperationDefinitionNode,
  type TypeNode,
  type ValueNode,
  parse,
} from "graphql";
import { describe, expect, it } from "vitest";
import {
  INTEGRATION_CATALOG,
  type IntegrationAction,
} from "../src/integrations";
import { parseIntrospection } from "../src/introspection";

/**
 * The catalog's GraphQL DOCUMENTS, diffed against the providers' own schemas (#943).
 *
 * ## The hole this fills
 *
 * `linear` and `monday` are the two catalog providers whose request body is `{query, variables}`.
 * That body is right BY CONSTRUCTION, so `integration-catalog-openapi.drift.spec.ts` can confirm it
 * trivially and learn nothing — which is why §2.5 of `docs/integrations/VERIFICATION.md` listed
 * their six write actions as permanently unverifiable rather than as pending work. All of the risk
 * lives INSIDE the query string: a renamed mutation, a changed input type, an argument that became
 * required. Those would surface as a runtime GraphQL error with no build-time signal at all — the
 * #707/#811 shape that #813 closed for REST and this closes for GraphQL.
 *
 * The catalog's `query` hints are not prose: they are real, complete GraphQL documents
 * (`mutation ($input: IssueCreateInput!) { issueCreate(input: $input) { … } }`), which is exactly
 * what makes them checkable against a schema.
 *
 * ## What is asserted
 *
 * Per action, from the parsed document and the pinned schema:
 *
 *   1. the root field the document selects EXISTS on the operation's root type (`Mutation.issueCreate`);
 *   2. every argument the document passes exists on that field, and where it is bound to a variable,
 *      the variable's DECLARED type is usable in that argument's position — the GraphQL spec's own
 *      "are variable usages allowed" rule, so `$id: String!` into `id: String!` passes and
 *      `$value: String!` into `value: JSON!` does not;
 *   3. every argument the schema marks NON_NULL without a default is supplied by the document;
 *   4. every declared variable's named type exists in the schema;
 *   5. where a variable's type is an INPUT_OBJECT whose fields the fixture kept, every NON_NULL
 *      input field without a default is reachable from the `variables` hint, and every key that
 *      hint does mention is a field the input type declares.
 *
 * ## Why the verdicts are tri-stated (the #813 rule, applied here)
 *
 * "Not reported" must never read as "verified". Every claim lands in one of three states:
 * CONFIRMED (the schema says so), UNKNOWABLE (the schema, or our own pruned fixture, cannot speak
 * to it), or WRONG. Only WRONG fails the build; all three are printed by the coverage summary at
 * the bottom, because an audit that reports only its failures inflates its own coverage.
 *
 * UNKNOWABLE here is mostly BY DESIGN and not a gap to be closed: `variables` is a `type: "json"`
 * field the author fills at authoring time, and its `hint` is a sketch. monday's five hints
 * (`{ boardId, itemName, columnValues }`) are not JSON at all, so nothing below them is machine-
 * readable — which costs monday nothing, because monday passes its values as plain arguments and
 * checks 1–4 cover those completely. Linear is the opposite case: its values go inside
 * `IssueCreateInput`/`CommentCreateInput`, its hints ARE JSON, and check 5 is where its coverage is.
 * Dressing either up as confirmed is the inflation the three states exist to prevent.
 *
 * ## Why upstream cannot break this build
 *
 * The schemas are VENDORED, pinned and pruned — see `scripts/extract-graphql-schema-fixtures.mjs`
 * for the refresh procedure. Nothing here touches the network, so a vendor's outage or 3am schema
 * republish cannot turn this red; upstream reaches CI only when a human runs
 * `pnpm refresh:graphql-fixtures`, in a PR, as a reviewable diff. **No credential is involved** —
 * Linear answers introspection anonymously and monday serves its schema at `/v2/get_schema` — which
 * is what let this be a pinned fixture rather than the live-gated spec #943 also floated. A
 * live-gated check runs only for whoever holds tokens, which means rarely, and protects nobody by
 * default.
 *
 * ## Reusing `parseIntrospection`
 *
 * Root-type names, field existence and argument NAMES come from `parseIntrospection`
 * (`src/introspection.ts`) rather than a second parser — the fixture is stored in introspection-
 * response shape precisely so it can. That parser deliberately flattens type refs to a readable
 * name and does not read `inputFields` at all (it serves canvas autocomplete, which needs neither),
 * so the type-compatibility and required-input-field walks below read the fixture JSON directly.
 * That is a gap in its scope, not duplication — the same split the OpenAPI drift spec makes with
 * `parseOpenApi` and request-body schemas.
 *
 * Document parsing is `graphql`'s own `parse()` (a devDependency of this package, test-only, never
 * reachable from `dist/`). Hand-rolling a GraphQL parser to check GraphQL documents would make the
 * check's own reading the thing under test.
 */

const FIXTURE_DIR = join(import.meta.dirname, "fixtures", "graphql");

/**
 * Findings a human has looked at and decided to keep — the ACKNOWLEDGED pattern from
 * `openapi-drift-adjudications.ts`, and the same bar: an entry must be a claim about the VENDOR'S
 * schema contradicting itself or its own documentation, quoted, not a place to silence a red test.
 * A catalog that is simply wrong gets fixed instead.
 *
 * EMPTY on purpose: at the time of pinning, every one of the ten documents matched its schema
 * exactly. Each entry is asserted in the OTHER direction below — it must still be produced — so an
 * acknowledgment that stops matching fails, which is either a fixed catalog or a changed schema.
 */
const ACKNOWLEDGED: { action: string; subject: string; why: string }[] = [];

// ── the fixture's shape ─────────────────────────────────────────────────────────────────────────

/** A `{kind, name?, ofType?}` chain, with `null` leaves dropped by the extractor. `kind` is a
 *  GraphQL introspection kind for a named type, or `NON_NULL`/`LIST` for a wrapper. */
interface TypeRef {
  kind: string;
  name?: string;
  ofType?: TypeRef;
}
interface FixtureArg {
  name: string;
  type: TypeRef;
  defaultValue?: string;
}
interface FixtureType {
  kind: string;
  name: string;
  fields?: { name: string; args: FixtureArg[] }[];
  inputFields?: FixtureArg[];
  /** Set by the extractor on a type it kept only the NAME of. The marker "we pruned this", which
   *  must be read as unknowable — never as "the schema doesn't declare it". */
  "x-pruned-fields"?: boolean;
}
interface Fixture {
  "x-naary": { provider: string; source: string; fetchedAt: string };
  __schema: {
    queryType: { name: string } | null;
    mutationType: { name: string } | null;
    types: FixtureType[];
  };
}

// ── type-ref helpers ────────────────────────────────────────────────────────────────────────────

const isNonNull = (r: TypeRef) => r.kind === "NON_NULL";
const isList = (r: TypeRef) => r.kind === "LIST";

/** `[Foo!]!` → `Foo`. The innermost named type of a wrapper chain. */
function namedTypeOf(ref: TypeRef | undefined): string | undefined {
  let cur = ref;
  for (let i = 0; cur && i < 8; i++) {
    if (cur.name) return cur.name;
    cur = cur.ofType;
  }
  return undefined;
}

function printRef(ref: TypeRef | undefined): string {
  if (!ref) return "?";
  if (isNonNull(ref)) return `${printRef(ref.ofType)}!`;
  if (isList(ref)) return `[${printRef(ref.ofType)}]`;
  return ref.name ?? "?";
}

/** A document's `TypeNode` in the fixture's own shape, so one comparison serves both sides. */
function refFromAst(node: TypeNode): TypeRef {
  if (node.kind === Kind.NON_NULL_TYPE)
    return { kind: "NON_NULL", ofType: refFromAst(node.type) };
  if (node.kind === Kind.LIST_TYPE)
    return { kind: "LIST", ofType: refFromAst(node.type) };
  return { kind: "NAMED", name: node.name.value };
}

/** `isTypeSubTypeOf`, structurally: may a value of `actual` be used where `expected` is wanted? */
function isSubType(actual: TypeRef, expected: TypeRef): boolean {
  if (isNonNull(expected))
    return (
      isNonNull(actual) &&
      !!actual.ofType &&
      !!expected.ofType &&
      isSubType(actual.ofType, expected.ofType)
    );
  if (isNonNull(actual))
    return !!actual.ofType && isSubType(actual.ofType, expected);
  if (isList(expected))
    return (
      isList(actual) &&
      !!actual.ofType &&
      !!expected.ofType &&
      isSubType(actual.ofType, expected.ofType)
    );
  if (isList(actual)) return false;
  return !!actual.name && actual.name === expected.name;
}

/**
 * The GraphQL spec's "Are variable usages allowed" rule. A NULLABLE variable may sit in a NON_NULL
 * argument only when it carries a default — which is why `$itemId: ID!` into monday's nullable
 * `item_id: ID` passes (stricter is always fine) while the reverse would not.
 */
function variableUsageAllowed(
  varType: TypeRef,
  varHasDefault: boolean,
  location: TypeRef,
): boolean {
  if (isNonNull(location) && !isNonNull(varType)) {
    if (!varHasDefault || !location.ofType) return false;
    return isSubType(varType, location.ofType);
  }
  return isSubType(varType, location);
}

/** NON_NULL with no default — the ones a caller MUST supply. */
const isRequired = (a: FixtureArg) =>
  isNonNull(a.type) && a.defaultValue == null;

// ── verdicts ────────────────────────────────────────────────────────────────────────────────────

type State = "confirmed" | "unknowable" | "wrong";
interface Verdict {
  kind: string;
  subject: string;
  state: State;
  detail: string;
}

/**
 * Hints are authoring examples and two of monday's open with a prose `e.g. `. Everything after that
 * prefix is a complete document; the prefix is stripped rather than removed from the catalog,
 * because it is UI copy that tells an author "this is an example", and the catalog's job is not to
 * be convenient for this test.
 */
const hintDocument = (hint: string) =>
  hint.replace(/^\s*e\.g\.\s*/i, "").trim();

/** The `variables` hint as an object, or WHY it is not machine-readable. Linear's are JSON with `…`
 *  placeholders; monday's are sketches (`{ boardId, itemName }`) and parse as nothing. */
function parseVariablesHint(
  hint: string | undefined,
): { ok: true; value: Record<string, unknown> } | { ok: false; why: string } {
  if (!hint)
    return { ok: false, why: "the action declares no `variables` hint" };
  try {
    const value: unknown = JSON.parse(hintDocument(hint));
    if (!value || typeof value !== "object" || Array.isArray(value))
      return { ok: false, why: "the `variables` hint is not a JSON object" };
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return {
      ok: false,
      why: "the `variables` hint is an authoring sketch, not JSON — nothing below it is machine-readable",
    };
  }
}

// ── one action, checked ─────────────────────────────────────────────────────────────────────────

interface Check {
  key: string;
  provider: string;
  action: IntegrationAction;
  verdicts: Verdict[];
  /**
   * The WRONG verdicts, STRUCTURED. Kept as verdicts rather than as formatted strings so that the
   * per-action assertion and the coverage counter excuse an acknowledgment by the same
   * `(action, subject)` key. Re-deriving a subject out of a formatted line would not survive the
   * subjects here — `create_item(board_id:)` and `$id → issueUpdate(id:)` both contain colons — and
   * an excusal path that silently matches nothing is worse than none.
   */
  wrong: Verdict[];
  /** A document that would not parse at all: fatal, and reported on its own so it cannot hide
   *  inside a pile of zero counts. */
  parseError?: string;
}

/** The one key an acknowledgment is matched on, everywhere. */
const adjudicationKey = (action: string, subject: string) =>
  `${action} ${subject}`;
const ACKNOWLEDGED_KEYS = new Set(
  ACKNOWLEDGED.map((a) => adjudicationKey(a.action, a.subject)),
);

class ActionChecker {
  readonly verdicts: Verdict[] = [];
  private readonly types: Map<string, FixtureType>;

  constructor(
    private readonly fixture: Fixture,
    private readonly key: string,
  ) {
    this.types = new Map(fixture.__schema.types.map((t) => [t.name, t]));
  }

  private add(kind: string, subject: string, state: State, detail: string) {
    this.verdicts.push({ kind, subject, state, detail });
  }

  private type(name: string | undefined): FixtureType | undefined {
    return name ? this.types.get(name) : undefined;
  }

  /** Checks 1–4, plus the descent that check 5 needs. */
  check(op: OperationDefinitionNode, variablesHint: string | undefined) {
    const schema = this.fixture.__schema;
    const rootName =
      op.operation === "mutation"
        ? schema.mutationType?.name
        : schema.queryType?.name;
    const rootType = this.type(rootName);
    if (!rootType) {
      this.add(
        "root-type",
        op.operation,
        "wrong",
        `the pinned schema declares no ${op.operation} root type`,
      );
      return;
    }

    // 4 — every declared variable names a type the schema has.
    const varDefs = new Map(
      (op.variableDefinitions ?? []).map((v) => [
        v.variable.name.value,
        {
          ref: refFromAst(v.type),
          hasDefault: v.defaultValue != null,
        },
      ]),
    );
    for (const [name, def] of varDefs) {
      const named = namedTypeOf(def.ref);
      const known = this.type(named);
      this.add(
        "variable-type",
        `$${name}`,
        known ? "confirmed" : "wrong",
        known
          ? `declared ${printRef(def.ref)}, and ${named} is a ${known.kind} in the pinned schema`
          : `declares type ${named}, which the pinned schema does not have. Either the catalog ` +
              "is wrong, or the hint changed since the fixture was pinned (`pnpm refresh:graphql-fixtures`)",
      );
    }

    const vars = parseVariablesHint(variablesHint);
    if (vars.ok) {
      // The `variables` hint is what an author copies, so it has to name the variables the
      // document requires — and nothing else. Only NON_NULL-without-default ones are asserted:
      // omitting an optional variable from an example is not a bug.
      for (const [name, def] of varDefs) {
        if (!isNonNull(def.ref) || def.hasDefault) continue;
        const present = name in vars.value;
        this.add(
          "required-variable",
          `$${name}`,
          present ? "confirmed" : "wrong",
          present
            ? `named by the \`variables\` hint; declared ${printRef(def.ref)}`
            : `declared ${printRef(def.ref)} with no default, and the \`variables\` hint never names it`,
        );
      }
      for (const key of Object.keys(vars.value))
        this.add(
          "variables-hint-key",
          key,
          varDefs.has(key) ? "confirmed" : "wrong",
          varDefs.has(key)
            ? "matches a variable the document declares"
            : `the \`variables\` hint offers "${key}", which the document declares no $${key} for`,
        );
    } else {
      this.add("variables-hint", "variables", "unknowable", vars.why);
    }

    for (const sel of op.selectionSet.selections) {
      if (sel.kind !== Kind.FIELD) {
        this.add(
          "selection",
          sel.kind,
          "unknowable",
          "a fragment at the root of the document — not something the catalog's hints use",
        );
        continue;
      }
      this.checkField(rootType, sel, varDefs, vars);
    }
  }

  private checkField(
    rootType: FixtureType,
    sel: {
      name: { value: string };
      arguments?: readonly { name: { value: string }; value: ValueNode }[];
    },
    varDefs: Map<string, { ref: TypeRef; hasDefault: boolean }>,
    vars: ReturnType<typeof parseVariablesHint>,
  ) {
    const fieldName = sel.name.value;
    const field = (rootType.fields ?? []).find((f) => f.name === fieldName);
    if (!field) {
      this.add(
        "field",
        `${rootType.name}.${fieldName}`,
        "wrong",
        `the pinned schema's ${rootType.name} has no field ${fieldName}. Either upstream ` +
          "renamed/removed it (fix the catalog), or the hint changed since the fixture was pinned " +
          "(`pnpm refresh:graphql-fixtures`)",
      );
      return;
    }
    this.add(
      "field",
      `${rootType.name}.${fieldName}`,
      "confirmed",
      "declared by the pinned schema",
    );

    const passed = new Set((sel.arguments ?? []).map((a) => a.name.value));

    // 2 — each argument exists, and each variable usage is allowed in its position.
    for (const argNode of sel.arguments ?? []) {
      const argName = argNode.name.value;
      const arg = field.args.find((a) => a.name === argName);
      if (!arg) {
        this.add(
          "argument",
          `${fieldName}(${argName}:)`,
          "wrong",
          `${rootType.name}.${fieldName} declares no argument ${argName} — it takes ` +
            `[${field.args.map((a) => a.name).join(", ")}]`,
        );
        continue;
      }
      this.add(
        "argument",
        `${fieldName}(${argName}:)`,
        "confirmed",
        `declared ${printRef(arg.type)}`,
      );
      if (argNode.value.kind !== Kind.VARIABLE) continue;
      const varName = argNode.value.name.value;
      const def = varDefs.get(varName);
      if (!def) {
        this.add(
          "variable-usage",
          `$${varName}`,
          "wrong",
          `used as ${argName} but never declared by the operation`,
        );
        continue;
      }
      const ok = variableUsageAllowed(def.ref, def.hasDefault, arg.type);
      this.add(
        "variable-usage",
        `$${varName} → ${fieldName}(${argName}:)`,
        ok ? "confirmed" : "wrong",
        `declared ${printRef(def.ref)}, argument is ${printRef(arg.type)}` +
          (ok ? "" : " — not usable in that position"),
      );
      if (ok) this.descendInto(arg, varName, vars);
    }

    // 3 — everything the schema requires is supplied.
    for (const arg of field.args.filter(isRequired))
      this.add(
        "required-argument",
        `${fieldName}(${arg.name}:)`,
        passed.has(arg.name) ? "confirmed" : "wrong",
        passed.has(arg.name)
          ? `supplied; schema declares ${printRef(arg.type)}`
          : `schema declares ${printRef(arg.type)} with no default, and the document never passes it`,
      );
  }

  /** 5 — walk the `variables` hint against the INPUT_OBJECT the argument expects. */
  private descendInto(
    arg: FixtureArg,
    varName: string,
    vars: ReturnType<typeof parseVariablesHint>,
  ) {
    const inputName = namedTypeOf(arg.type);
    const input = this.type(inputName);
    if (input?.kind !== "INPUT_OBJECT") return; // a scalar/enum argument has no interior to walk
    if (!vars.ok) return; // already reported once, as the action's `variables-hint` verdict
    // Absent from the hint: for a required variable the `required-variable` verdict above already
    // says so, and for an optional one there is nothing to say. Either way there is no interior.
    if (!(varName in vars.value)) return;
    this.walkInput(input, vars.value[varName], varName);
  }

  private walkInput(input: FixtureType, value: unknown, path: string) {
    if (input["x-pruned-fields"]) {
      this.add(
        "input-object",
        `${path}: ${input.name}`,
        "unknowable",
        `${input.name} exists, but the fixture kept only its name (pruned one level out) — its ` +
          "interior is neither confirmed nor denied",
      );
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      this.add(
        "input-object",
        `${path}: ${input.name}`,
        "unknowable",
        "the hint gives a placeholder here, not an object — author-supplied by design",
      );
      return;
    }
    const declared = new Map(
      (input.inputFields ?? []).map((f) => [f.name, f] as const),
    );
    const hinted = value as Record<string, unknown>;

    for (const [key, nested] of Object.entries(hinted)) {
      const decl = declared.get(key);
      this.add(
        "input-field",
        `${path}.${key}`,
        decl ? "confirmed" : "wrong",
        decl
          ? `${input.name}.${key} is declared ${printRef(decl.type)}`
          : `${input.name} declares no field ${key}`,
      );
      if (!decl) continue;
      const nestedType = this.type(namedTypeOf(decl.type));
      if (nestedType?.kind === "INPUT_OBJECT")
        this.walkInput(nestedType, nested, `${path}.${key}`);
    }

    for (const req of (input.inputFields ?? []).filter(isRequired))
      this.add(
        "required-input-field",
        `${path}.${req.name}`,
        req.name in hinted ? "confirmed" : "wrong",
        req.name in hinted
          ? `supplied by the hint; ${input.name} declares it ${printRef(req.type)}`
          : `${input.name}.${req.name} is ${printRef(req.type)} with no default, and the ` +
              "`variables` hint never mentions it",
      );
  }
}

// ── load the fixtures, run every action ─────────────────────────────────────────────────────────

const fixtures = new Map<string, Fixture>(
  readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => [
      f.replace(/\.json$/, ""),
      JSON.parse(readFileSync(join(FIXTURE_DIR, f), "utf8")) as Fixture,
    ]),
);

/** A catalog provider is GraphQL-shaped when EVERY action posts a `query` body field. Derived, not
 *  listed: adding a third GraphQL provider must fail the suite until its schema is pinned. */
const graphqlProviders = Object.entries(INTEGRATION_CATALOG)
  .filter(([, entry]) =>
    entry.actions.every((a) =>
      a.fields.some((f) => f.key === "query" && f.in === "body"),
    ),
  )
  .map(([key]) => key)
  .sort();

const checks: Check[] = [];
for (const [provider, fixture] of [...fixtures].sort(([a], [b]) =>
  a.localeCompare(b),
)) {
  const entry = INTEGRATION_CATALOG[provider];
  if (!entry) continue; // asserted below — a fixture for a provider the catalog dropped
  for (const action of entry.actions) {
    const key = `${provider}.${action.key}`;
    const queryHint = action.fields.find((f) => f.key === "query")?.hint;
    if (!queryHint) {
      checks.push({
        key,
        provider,
        action,
        verdicts: [],
        wrong: [],
        parseError: "the action has no `query` hint to check",
      });
      continue;
    }
    const checker = new ActionChecker(fixture, key);
    let parseError: string | undefined;
    try {
      const doc = parse(hintDocument(queryHint));
      const ops = doc.definitions.filter(
        (d): d is OperationDefinitionNode =>
          d.kind === Kind.OPERATION_DEFINITION,
      );
      if (ops.length !== 1)
        parseError = `expected exactly one operation in the hint, found ${ops.length}`;
      else
        checker.check(
          ops[0],
          action.fields.find((f) => f.key === "variables")?.hint,
        );
    } catch (e) {
      parseError = `the \`query\` hint is not a parseable GraphQL document: ${String(e).split("\n")[0]}`;
    }
    checks.push({
      key,
      provider,
      action,
      verdicts: checker.verdicts,
      wrong: checker.verdicts.filter((v) => v.state === "wrong"),
      parseError,
    });
  }
}

describe("catalog GraphQL documents vs the pinned schemas (#943)", () => {
  it("pins a schema for every GraphQL-shaped catalog provider", () => {
    expect(graphqlProviders).toEqual(["linear", "monday"]);
    expect(
      graphqlProviders.filter((p) => !fixtures.has(p)),
      "a GraphQL provider with no pinned schema — add it to SOURCES in " +
        "packages/dsl/scripts/extract-graphql-schema-fixtures.mjs and run `pnpm refresh:graphql-fixtures`",
    ).toEqual([]);
  });

  it("has a catalog provider for every pinned schema", () => {
    expect(
      [...fixtures.keys()].filter((p) => !INTEGRATION_CATALOG[p]),
      "a pinned schema for a provider the catalog no longer has — delete the fixture",
    ).toEqual([]);
  });

  it("checked something", () => {
    // A fixture directory that stopped loading, or a hint shape the loader no longer recognises,
    // would otherwise print a tidy table of zeroes and pass.
    expect(checks.length).toBe(10);
    expect(checks.flatMap((c) => c.verdicts).length).toBeGreaterThan(50);
  });
});

for (const check of checks) {
  describe(`${check.key}`, () => {
    it("parses as a single GraphQL operation", () => {
      expect(check.parseError, check.key).toBeUndefined();
    });

    it("matches the pinned schema", () => {
      expect(
        check.wrong
          .filter(
            (v) =>
              !ACKNOWLEDGED_KEYS.has(adjudicationKey(check.key, v.subject)),
          )
          .map((v) => `${v.kind} ${v.subject}: ${v.detail}`),
        `${check.key}: the document and the pinned schema disagree. Either the catalog is wrong ` +
          "(fix it), or the vendor changed the schema and the fixture is stale " +
          "(`pnpm refresh:graphql-fixtures`, then read the diff).",
      ).toEqual([]);
    });
  });
}

describe("acknowledged GraphQL findings", () => {
  it("still finds every acknowledged difference", () => {
    for (const { action, subject, why } of ACKNOWLEDGED) {
      const check = checks.find((c) => c.key === action);
      expect(check, `${action} is no longer a checked action`).toBeDefined();
      expect(
        check?.verdicts.some(
          (v) => v.state === "wrong" && v.subject === subject,
        ),
        `${action} / ${subject} is no longer reported as wrong.\n  it was acknowledged because: ` +
          `${why}\n  Either the catalog was fixed (delete the entry) or the vendor changed the ` +
          "schema (worth a look).",
      ).toBe(true);
    }
  });
});

/**
 * The honest coverage number for #943, printed rather than asserted — the same instrument #813
 * added for REST write bodies, and pasted into §2.5 of `docs/integrations/VERIFICATION.md` from a
 * real run so the doc cannot drift from what the test actually checked.
 */
describe("GraphQL document coverage (#943)", () => {
  it("reports how much of each document a schema can vouch for", () => {
    const rows: string[] = [];
    const total = { confirmed: 0, unknowable: 0, wrong: 0 };
    for (const check of checks) {
      const counts = { confirmed: 0, unknowable: 0, wrong: 0 };
      for (const v of check.verdicts) counts[v.state]++;
      for (const k of ["confirmed", "unknowable", "wrong"] as const)
        total[k] += counts[k];
      rows.push(
        `    ${check.key.padEnd(30)} ${check.action.write ? "WRITE" : "read "}  ` +
          `${String(counts.confirmed).padStart(2)} confirmed  ` +
          `${String(counts.unknowable).padStart(2)} unknowable  ` +
          `${String(counts.wrong).padStart(2)} wrong`,
      );
    }
    const writes = checks.filter((c) => c.action.write);
    const writeConfirmed = writes
      .flatMap((c) => c.verdicts)
      .filter((v) => v.state === "confirmed").length;
    // A `wrong` verdict STAYS in the printed total once adjudicated — #813's rule, so the table can
    // show a non-zero `wrong` on a green build. Saying how many are adjudicated is the difference
    // between that reading as "CI is red" and as "we looked, and wrote down why".
    const adjudicated = checks
      .flatMap((c) => c.wrong.map((v) => adjudicationKey(c.key, v.subject)))
      .filter((k) => ACKNOWLEDGED_KEYS.has(k)).length;
    process.stderr.write(
      `\n#943 schema-verified GraphQL documents — ${checks.length} action(s) across ` +
        `${fixtures.size} pinned schema(s), no credential involved:\n${rows.join("\n")}\n` +
        `    ${"TOTAL claims".padEnd(30)}         ${total.confirmed} confirmed, ` +
        `${total.unknowable} unknowable, ${total.wrong} wrong` +
        `${total.wrong ? ` (${adjudicated} acknowledged — see ACKNOWLEDGED)` : ""}\n` +
        `\n    The six #943 WRITE actions carry ${writeConfirmed} confirmed claims. Every ` +
        "unknowable is a\n    `variables` hint the author fills in — author-supplied by design, " +
        "never a silent pass.\n\n",
    );
    expect(total.confirmed).toBeGreaterThan(0);
    // Every `wrong` on a green build is adjudicated; a NEW one fails its own action's test above.
    // Counted against the acknowledgments that MATCHED, never against the length of the list — the
    // two are the same only by luck, and keying the summary off the list length would make the first
    // legitimate adjudication fail here while passing its own action's test.
    expect(total.wrong).toBe(adjudicated);
  });
});
