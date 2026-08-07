import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  INTEGRATION_CATALOG,
  type IntegrationAction,
  type IntegrationField,
  buildIntegrationRequest,
} from "../src/integrations";

/**
 * The REQUEST we actually build, diffed against the provider's own OpenAPI document.
 *
 * ## What was missing, precisely
 *
 * `integration-catalog-openapi.drift.spec.ts` compares DECLARATIONS: our catalog entry against the
 * pinned spec. `integration-write-bodies.spec.ts` and `integration-form-encoding.spec.ts` DO call
 * `buildIntegrationRequest`, but they assert internal invariants (no leftover `{placeholder}`, no
 * `const`-only envelope, no nested value in a form body) — they never open a spec. So the step
 * between "the catalog says X" and "we send Y" had nothing looking at both ends at once. This file
 * is that: it builds the request with `buildIntegrationRequest` and asks the vendor's document
 * whether the resulting method, path, query, headers and body are things it declares.
 *
 * Two directions were genuinely unchecked before, and they are the reason this exists:
 *
 *   - **A query parameter we SEND that upstream does not declare.** The drift spec's parameter
 *     loop walks `op.parameters` looking for a catalog field; it never walks our fields looking for
 *     an upstream parameter. An undeclared query param is the quietest failure an integration has:
 *     the server ignores it, answers 200, and the author gets the unfiltered list back.
 *   - **A request header we send** (`in: "header"` fields — PagerDuty's `From`). Same gap, same
 *     direction; `staticHeaders` there only EXCUSES upstream headers, it never checks ours.
 *
 * Compared BYTE-EXACT for query, case-insensitively for headers. `normalizeName` (the drift spec's
 * `per_page` ≈ `perPage` fuzzing) would be wrong here and is deliberately not reused: placeholder
 * names are ours to pick because substitution is positional, but a query key IS the wire name —
 * `build-request.ts` encodes `field.key` straight into the query string — so `perPage` and
 * `per_page` are two different parameters to a server, one of which does nothing.
 *
 * ## WHAT A GREEN RUN DOES NOT MEAN
 *
 * **It does not mean the integrations work.** Read that twice before quoting this file's numbers.
 * It compares our request against a DOCUMENT, and every limit of that comparison is load-bearing:
 *
 *   1. **A document can be wrong.** Vendors generate these from server code, or hand-maintain them,
 *      or both; Cloudflare's marks a DELETE's request body `required: true` with an empty schema.
 *      Agreement with a spec is evidence, never proof.
 *   2. **Auth, permissions, rate limits and account state are invisible here.** No credential is
 *      used and no byte leaves the process. A perfectly-shaped request against a token missing a
 *      scope is a 403, and this file cannot see it. That is the *majority* of what breaks a live
 *      integration, and only `docs/integrations/VERIFICATION.md` (1 provider verified live, of 38)
 *      speaks to it.
 *   3. **Semantics are invisible.** A declared parameter carrying a value the API rejects
 *      (`status=nonsense`), a declared body field the API ignores unless another is set, an id from
 *      the wrong account — all pass here.
 *   4. **The response is out of scope entirely.** Nothing downstream of the request is checked.
 *   5. **We check a version we may not be calling.** See SPEC_DESCRIBES_ANOTHER_VERSION: Intercom's
 *      pinned document is 2.16 and we send `Intercom-Version: 2.11`, so every Intercom row here is
 *      a comparison against an API we do not call (#1133).
 *   6. **10 of 38 providers have no pinned document at all** and are therefore not compared. The
 *      list is computed, printed, and asserted below rather than written down.
 *
 * The honest one-line summary: this proves we are not sending a request the vendor's own document
 * says is malformed. It does not prove the call succeeds.
 *
 * ## Why it lands GREEN with adjudication lists
 *
 * Same shape as the drift spec next door, for the same reason: a guard that lands red blocks every
 * unrelated PR and gets muted within a week; one that lands green with no record of what it found
 * is a lie. So new findings fail, and the residue is written down in two lists — kept SEPARATE,
 * because "the document is over-strict" and "this is a real bug we have not fixed" are different
 * claims and collapsing them is how a real bug becomes invisible. Both are asserted in the other
 * direction: every entry must STILL be produced, so an entry that stops matching fails too.
 *
 * ## Reading the fixtures directly
 *
 * `parseOpenApi` models what httpRequest autocomplete needs and drops the rest; this file reads the
 * vendored JSON, the same deliberate gap the drift spec's required-body walk works around. The
 * fixtures are pinned, pruned and vendored (`packages/dsl/scripts/extract-openapi-fixtures.mjs`),
 * so nothing here touches the network and upstream cannot turn this red without a human refresh.
 * `pruneParameters` keeps EVERY parameter, optional ones included, which is what makes the
 * we-send-it/they-declare-it direction answerable at all.
 */

const FIXTURE_DIR = join(__dirname, "fixtures", "openapi");

// ── adjudications ───────────────────────────────────────────────────────────────────────────────

/**
 * Findings where the DOCUMENT is the thing that is wrong or over-strict, and our request is fine.
 *
 * Not a to-do list: nothing here is expected to change on our side. `why` is the argument, and it
 * has to be one a reviewer can disagree with.
 */
const SPEC_OVERSTRICT: { finding: string; why: string }[] = [
  {
    finding:
      "cloudflare.delete_dns_record: upstream marks the request body required and we send none",
    why:
      "Cloudflare's generated document declares `requestBody: {required: true, content: {application/json: {schema: {}}}}` on a DELETE — a required body with NO schema and therefore no property " +
      "anyone could fill. The action takes only the two path ids by design, so there is nothing to " +
      "put in it. Sending `{}` to satisfy a generator artifact would change a request that works " +
      "today for no stated gain.",
  },
];

/**
 * Findings that are REAL, unfixed, and owned somewhere else. Every entry is a defect we are
 * choosing not to fix in this PR, with the reason the fix does not belong here.
 *
 * The distinction from SPEC_OVERSTRICT is the whole point of having two lists: an entry here is an
 * admission, not a rebuttal.
 */
const KNOWN_DEFECT: { finding: string; why: string }[] = [
  {
    finding:
      "asana.update_task: upstream marks the request body required and we send none",
    why:
      "Every body field on this action is optional, so an author who configures only the task id " +
      "builds a bodyless PUT and gets a provider 400 instead of a save-time 'nothing to update'. " +
      "`alwaysSendBody` does NOT fix it — Asana wants `{data: {…}}`, and `{}` fails the same way. " +
      "The real fix is an at-least-one-of rule in the save gate, which is a catalog/validation " +
      "change, not a request-builder one.",
  },
  {
    finding:
      "clickup.update_task: upstream marks the request body required and we send none",
    why: "Same shape as asana.update_task: all body fields optional, so an empty update builds a bodyless PUT.",
  },
  {
    finding:
      "mailchimp.update_member: upstream marks the request body required and we send none",
    why: "Same shape as asana.update_task: all body fields optional, so an empty update builds a bodyless PATCH.",
  },
];

/**
 * Providers whose PINNED DOCUMENT describes a different API version from the one we call (#1133).
 *
 * This is a limitation of the instrument, not a finding about a single action: every row for such a
 * provider is a comparison against a document for an API we do not ask for. Recorded as data and
 * asserted in both directions — the catalog must still send `weSend`, the fixture must still be
 * `specVersion` — so the day either moves, somebody re-reads instead of the caveat quietly aging.
 *
 * Why it is not simply "bump the header": a version pin is a compatibility promise. Intercom cut 5
 * minor versions between 2.11 and 2.16, and moving the pin means re-reading every Intercom action
 * against the new document, which is its own change with its own risk.
 */
const SPEC_DESCRIBES_ANOTHER_VERSION: {
  provider: string;
  header: string;
  weSend: string;
  specVersion: string;
  issue: string;
}[] = [
  {
    provider: "intercom",
    header: "Intercom-Version",
    weSend: "2.11",
    specVersion: "2.16",
    issue: "#1133",
  },
];

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────

/** `/repos/{owner}/{repo}/issues/{n}` → `/repos/{}/{}/issues/{}`. Placeholder names are ours. */
const shape = (path: string): string => path.replace(/\{[^}]*\}/g, "{}");

interface RawParameter {
  name: string;
  in: string;
  required?: boolean;
}
interface RawOperation {
  operationId?: string;
  parameters?: RawParameter[];
  requestBody?: { required?: boolean; content?: Record<string, unknown> };
}
interface Fixture {
  provider: string;
  /** The part of `baseUrl` the spec puts in its paths and our `pathTemplate`s don't (Stripe's
   *  `/v1`). The built path carries NO prefix, so every comparison prepends this. */
  pathPrefix: string;
  /** `info.version` — what API version this document describes. */
  version: string;
  operations: Map<string, { path: string; method: string; op: RawOperation }>;
}

function loadFixtures(): Fixture[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => {
      const raw = JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8")) as {
        info?: { version?: string };
        paths?: Record<string, Record<string, RawOperation>>;
        "x-naary"?: Record<string, string>;
      };
      const meta = raw["x-naary"] ?? {};
      const operations = new Map<
        string,
        { path: string; method: string; op: RawOperation }
      >();
      for (const [path, item] of Object.entries(raw.paths ?? {}))
        for (const [method, op] of Object.entries(item))
          operations.set(`${method.toUpperCase()} ${shape(path)}`, {
            path,
            method: method.toUpperCase(),
            op,
          });
      return {
        provider: meta.provider ?? file.replace(/\.json$/, ""),
        pathPrefix: meta.pathPrefix ?? "",
        version: raw.info?.version ?? "(unrecorded)",
        operations,
      };
    });
}

// ── the node config an author would have written ────────────────────────────────────────────────

/**
 * A type-appropriate value for a field, matching `integration-write-bodies.spec.ts` so the two
 * files build the same requests from the same inputs.
 */
function sampleValue(field: IntegrationField): unknown {
  switch (field.type) {
    case "number":
      return 42;
    case "boolean":
      return true;
    case "string[]":
      return ["one", "two"];
    case "json":
      return { sample: "value" };
    default:
      return `${field.key}-value`;
  }
}

/**
 * FULL answers "is everything we CAN send declared upstream?" — maximum surface, so a query
 * parameter that only appears when an optional field is filled still gets compared.
 *
 * REQUIRED answers a different and stronger question than the drift spec's: not "does a field exist
 * for this required parameter" but "does the parameter reach the WIRE in the smallest legal call".
 * A `required: false` field the author leaves blank has a catalog entry and is still absent from the
 * request.
 *
 * `const` fields are never caller-supplied — the catalog injects them and a supplied value is
 * ignored — so they are excluded from the input in both shapes. Path fields are always supplied:
 * an empty path segment is a deliberate hard error in the builder (#866), not a case to sample.
 */
type Shape = "FULL" | "REQUIRED";
function valuesFor(
  action: IntegrationAction,
  shape_: Shape,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of action.fields) {
    if (field.const !== undefined) continue;
    if (
      field.in === "path" ||
      shape_ === "FULL" ||
      (shape_ === "REQUIRED" && field.required)
    )
      out[field.key] = sampleValue(field);
  }
  return out;
}

/** Read a dotted path off a built body. Own-property walk only — the body is ours, but a dotted
 *  path that reached `constructor` would read a function and call it "present". */
function valueAt(root: unknown, dotted: string): unknown {
  let cur: unknown = root;
  for (const key of dotted.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, key)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

// ── check 1: the round trip (needs no spec, so it covers the WHOLE catalog) ─────────────────────

/**
 * Every value an author supplied must be findable in the built request, at the location the field
 * declares.
 *
 * This is the one check here that needs no vendor document, so it runs across all 38 providers
 * rather than the 28 with a pinned spec — including the 10 that can never be spec-checked at all.
 *
 * It catches what a declaration diff structurally cannot: SILENT LOSS during assembly. `setPath`
 * overwrites, so a `type: "json"` field whose `bodyPath` is the PREFIX of another field's
 * (`data` and `data.name`) means one of the two survives and which one depends on catalog order.
 * Nothing about either field's declaration is wrong; the request is still missing a value the
 * author typed in, and the API answers with a message about a field they never heard of.
 */
interface LostField {
  key: string;
  shape: Shape;
  message: string;
}
function roundTrip(
  providerKey: string,
  action: IntegrationAction,
  shape_: Shape,
): { lost: LostField[]; built?: ReturnType<typeof buildIntegrationRequest> } {
  const key = `${providerKey}.${action.key}`;
  const values = valuesFor(action, shape_);
  let built: ReturnType<typeof buildIntegrationRequest>;
  try {
    built = buildIntegrationRequest(providerKey, action.key, values);
  } catch (error) {
    return {
      lost: [
        {
          key,
          shape: shape_,
          message: `[${shape_}] threw while building: ${(error as Error).message}`,
        },
      ],
    };
  }
  const [pathOnly, queryString] = built.path.split("?");
  const query = new URLSearchParams(queryString ?? "");
  const lost: LostField[] = [];
  for (const field of action.fields) {
    if (field.const !== undefined) continue;
    const value = values[field.key];
    if (value === undefined) continue;
    let present: boolean;
    if (field.in === "path")
      present = pathOnly.includes(encodeURIComponent(String(value)));
    else if (field.in === "query") present = query.has(field.key);
    else if (field.in === "header")
      present = (built.headers ?? {})[field.key] !== undefined;
    else
      // Compared by VALUE, not just presence: a later field writing an object over an earlier
      // field's leaf leaves the key present and the value gone.
      present =
        JSON.stringify(valueAt(built.body, field.bodyPath ?? field.key)) ===
        JSON.stringify(value);
    if (!present)
      lost.push({
        key,
        shape: shape_,
        message:
          `[${shape_}] field "${field.key}" (in:"${field.in}"` +
          `${field.bodyPath ? `, bodyPath "${field.bodyPath}"` : ""}) was supplied but is not in ` +
          "the built request — something later in assembly overwrote it, or it lands nowhere",
      });
  }
  // A placeholder that survived assembly is #866 one layer up: the URL goes out malformed.
  // `integration-write-bodies.spec.ts` asserts this for body-bearing WRITES only, so reads have
  // never had it.
  if (/[{}]/.test(pathOnly))
    lost.push({
      key,
      shape: shape_,
      message: `[${shape_}] the built path still carries a placeholder: ${pathOnly}`,
    });
  return { lost, built };
}

// ── check 2..6: the built request against the pinned operation ──────────────────────────────────

interface RequestCheck {
  key: string;
  provider: string;
  /** Set when the action's path+method matched a pinned operation. Unmatched actions are the
   *  drift spec's business ("resolves to an operation"), not this file's — it would be the same
   *  failure reported twice. */
  matched: boolean;
  pathProblems: string[];
  /** A query parameter we emit that upstream does not declare as a query parameter. HARD. */
  queryProblems: string[];
  /** A request header we emit that upstream does not declare. HARD. */
  headerProblems: string[];
  /** A body key upstream declares as a query/path/header parameter — right name, wrong place. */
  placementProblems: string[];
  /** Upstream requires a body and the built request has none. Adjudicated. */
  bodyProblems: string[];
  advisories: string[];
  /** Positive evidence, so "0 problems" can be told apart from "0 compared". */
  confirmed: { query: number; header: number; body: number };
  unknowable: { query: number; header: number };
}

function checkRequest(
  fixture: Fixture,
  providerKey: string,
  action: IntegrationAction,
): RequestCheck {
  const key = `${providerKey}.${action.key}`;
  const check: RequestCheck = {
    key,
    provider: providerKey,
    matched: false,
    pathProblems: [],
    queryProblems: [],
    headerProblems: [],
    placementProblems: [],
    bodyProblems: [],
    advisories: [],
    confirmed: { query: 0, header: 0, body: 0 },
    unknowable: { query: 0, header: 0 },
  };
  const hit = fixture.operations.get(
    `${action.method} ${shape(fixture.pathPrefix + action.pathTemplate)}`,
  );
  if (!hit) return check;
  check.matched = true;

  const parameters = hit.op.parameters ?? [];
  const declaredQuery = new Set(
    parameters.filter((p) => p.in === "query").map((p) => p.name),
  );
  const declaredHeaders = new Set(
    parameters
      .filter((p) => p.in === "header")
      .map((p) => p.name.toLowerCase()),
  );
  const declaredWhere = new Map(parameters.map((p) => [p.name, p.in]));

  for (const shape_ of ["FULL", "REQUIRED"] as Shape[]) {
    let built: ReturnType<typeof buildIntegrationRequest>;
    try {
      built = buildIntegrationRequest(
        providerKey,
        action.key,
        valuesFor(action, shape_),
      );
    } catch {
      continue; // the round-trip check owns build failures; reporting them twice helps nobody
    }
    const [pathOnly, queryString] = built.path.split("?");
    const query = new URLSearchParams(queryString ?? "");

    // (1) the RESOLVED path, segment by segment ---------------------------------------------------
    // Segment-wise rather than a brace scan: this also catches a value that introduced a `/` (a
    // path parameter is `encodeURIComponent`d, so it should not be able to — asserting it is how we
    // find out if that ever stops being true) and an upstream template whose literal segments moved.
    const ours = (fixture.pathPrefix + pathOnly).split("/");
    const theirs = hit.path.split("/");
    if (ours.length !== theirs.length)
      check.pathProblems.push(
        `[${shape_}] built ${fixture.pathPrefix + pathOnly} has ${ours.length} segment(s), upstream ${hit.path} has ${theirs.length}`,
      );
    else
      for (const [i, segment] of theirs.entries())
        if (!segment.startsWith("{") && segment !== ours[i])
          check.pathProblems.push(
            `[${shape_}] segment ${i} of the built path is "${ours[i]}", upstream's is "${segment}"`,
          );

    if (shape_ === "FULL") {
      // (2) every query parameter we EMIT is one upstream declares -------------------------------
      for (const name of new Set(query.keys())) {
        if (declaredQuery.size === 0) {
          // The operation declares no query parameters at all. Absence is not denial: a pruned or
          // thin document says nothing, and calling our parameter wrong on that basis would be
          // believing silence. UNKNOWABLE, and counted as such.
          check.unknowable.query++;
          continue;
        }
        if (declaredQuery.has(name)) {
          check.confirmed.query++;
          continue;
        }
        const elsewhere = declaredWhere.get(name);
        check.queryProblems.push(
          `we send ?${name}=, and upstream ` +
            (elsewhere
              ? `declares "${name}" as in:"${elsewhere}", not a query parameter`
              : `declares only {${[...declaredQuery].sort().join(", ")}}`) +
            ". A query key IS the wire name, so this parameter is being ignored by the server " +
            "(or rejected) — check the field key against the vendor's document.",
        );
      }

      // (3) every header we EMIT is one upstream declares -----------------------------------------
      for (const name of Object.keys(built.headers ?? {})) {
        if (declaredHeaders.size === 0) {
          check.unknowable.header++;
          continue;
        }
        if (declaredHeaders.has(name.toLowerCase())) {
          check.confirmed.header++;
          continue;
        }
        check.headerProblems.push(
          `we send the header "${name}", upstream declares only {${[...declaredHeaders].sort().join(", ")}}`,
        );
      }

      // (4) nothing in the body that upstream declares somewhere ELSE -----------------------------
      // The "right place" question, asked of the built payload: a name the spec knows as a query or
      // path parameter, arriving in the JSON body, is a field whose `in` is wrong — and it fails in
      // the quiet way, because the body is usually accepted and the parameter simply never applied.
      for (const name of Object.keys(built.body ?? {})) {
        const where = declaredWhere.get(name);
        if (where === undefined) continue;
        check.placementProblems.push(
          `we put "${name}" in the request body, upstream declares it as in:"${where}"`,
        );
      }
      if (built.body) check.confirmed.body++;

      // (6) the media type we will send, advisory only (#707/#813) --------------------------------
      // Advisory for the reason the drift spec's is: Slack's Swagger-2 document declares only
      // form-encoding and accepts JSON with a Bearer token. A content map is evidence, not proof.
      const declaredMedia = Object.keys(hit.op.requestBody?.content ?? {});
      const sending =
        action.bodyEncoding === "form"
          ? "application/x-www-form-urlencoded"
          : "application/json";
      if (
        built.body &&
        declaredMedia.length > 0 &&
        !declaredMedia.some((m) => m.split(";")[0].trim() === sending)
      )
        check.advisories.push(
          `${key}: the built request carries a body as ${sending}, upstream declares only {${declaredMedia.sort().join(", ")}}`,
        );
    }

    if (shape_ === "REQUIRED") {
      // (5) a parameter upstream REQUIRES must reach the wire, not merely exist in the catalog ----
      for (const parameter of parameters) {
        if (!parameter.required) continue;
        if (parameter.in === "query" && !query.has(parameter.name))
          check.queryProblems.push(
            `upstream requires ?${parameter.name}= and the smallest legal call omits it — ` +
              "either no field supplies it, or the field that does is `required: false` so an " +
              "author who leaves it blank sends a request the vendor's document rejects",
          );
      }
      if (hit.op.requestBody?.required === true && !built.body)
        check.bodyProblems.push(
          "upstream marks the request body required and we send none",
        );
    }
  }
  return check;
}

// ── run everything at module load ───────────────────────────────────────────────────────────────

const fixtures = loadFixtures();
const pinned = new Set(fixtures.map((f) => f.provider));

/** The round trip, across the WHOLE catalog. */
const roundTrips = Object.entries(INTEGRATION_CATALOG).flatMap(
  ([providerKey, provider]) =>
    provider.actions.flatMap((action) =>
      (["FULL", "REQUIRED"] as Shape[]).flatMap(
        (shape_) => roundTrip(providerKey, action, shape_).lost,
      ),
    ),
);

/** The spec comparison, for the 28 providers that have a pinned document. */
const checks: RequestCheck[] = fixtures.flatMap((fixture) => {
  const provider = INTEGRATION_CATALOG[fixture.provider];
  if (!provider) return [];
  return provider.actions.map((action) =>
    checkRequest(fixture, fixture.provider, action),
  );
});
const matched = checks.filter((c) => c.matched);
const advisories = [...new Set(matched.flatMap((c) => c.advisories))].sort();
/** Every adjudicable finding, in the `provider.action: sentence` form both lists use. */
const bodyFindings = matched
  .flatMap((c) => c.bodyProblems.map((p) => `${c.key}: ${p}`))
  .sort();

// ── the tests ───────────────────────────────────────────────────────────────────────────────────

describe("the harness compares something", () => {
  it("loaded fixtures, and matched most of the catalog to an operation", () => {
    // Guards every assertion below: a fixture directory that stopped loading, or a matcher that
    // stopped matching, would otherwise make this whole file pass having compared nothing.
    expect(fixtures.length).toBeGreaterThan(20);
    expect(matched.length).toBeGreaterThan(100);
  });

  it("actually compared query parameters and headers, not zero of them", () => {
    // The counts that stop "0 problems" being read as "0 compared". Both are positive evidence and
    // both are cheap to lose — a `pathPrefix` regression alone would take them to zero.
    const query = matched.reduce((n, c) => n + c.confirmed.query, 0);
    const header = matched.reduce((n, c) => n + c.confirmed.header, 0);
    expect(query).toBeGreaterThan(30);
    expect(header).toBeGreaterThan(0);
  });
});

describe("every supplied field reaches the built request", () => {
  // Catalog-wide: the one check here that needs no vendor document.
  it("loses nothing during assembly, in either shape", () => {
    expect(roundTrips.map((l) => `${l.key} ${l.message}`)).toEqual([]);
  });
});

for (const check of matched) {
  describe(check.key, () => {
    it("builds a path the pinned spec declares", () => {
      expect(check.pathProblems, check.key).toEqual([]);
    });

    it("sends only query parameters the pinned spec declares", () => {
      expect(check.queryProblems, check.key).toEqual([]);
    });

    it("sends only headers the pinned spec declares", () => {
      expect(check.headerProblems, check.key).toEqual([]);
    });

    it("puts every value where the pinned spec declares it", () => {
      expect(check.placementProblems, check.key).toEqual([]);
    });

    it("sends a body when the pinned spec requires one", () => {
      const adjudicated = new Set(
        [...SPEC_OVERSTRICT, ...KNOWN_DEFECT].map((a) => a.finding),
      );
      expect(
        check.bodyProblems.filter(
          (p) => !adjudicated.has(`${check.key}: ${p}`),
        ),
        check.key,
      ).toEqual([]);
    });
  });
}

describe("the adjudication lists still describe reality", () => {
  it("every SPEC_OVERSTRICT entry is still produced", () => {
    for (const { finding, why } of SPEC_OVERSTRICT)
      expect(
        bodyFindings,
        `no longer reported: "${finding}"\n  it was adjudicated because: ${why}\n  Either the ` +
          "catalog changed (delete the entry) or the vendor's document did (worth a look).",
      ).toContain(finding);
  });

  it("every KNOWN_DEFECT entry is still produced", () => {
    for (const { finding, why } of KNOWN_DEFECT)
      expect(
        bodyFindings,
        `no longer reported: "${finding}"\n  it was excused because: ${why}\n  If it was fixed, ` +
          "delete the entry — an excuse for a bug that no longer exists hides the next one.",
      ).toContain(finding);
  });

  it("the two lists do not overlap", () => {
    // They make opposite claims about the same finding, so an entry in both means nobody decided.
    const overstrict = new Set(SPEC_OVERSTRICT.map((a) => a.finding));
    for (const { finding } of KNOWN_DEFECT)
      expect(overstrict, `"${finding}" is in both lists`).not.toContain(
        finding,
      );
  });

  it("every version caveat still holds, on both sides", () => {
    // #1133. Asserted in BOTH directions so the caveat cannot quietly go stale: if we bump the
    // header, or a fixture refresh moves the document, this fails and somebody re-reads the
    // provider instead of trusting a comment.
    for (const entry of SPEC_DESCRIBES_ANOTHER_VERSION) {
      const provider = INTEGRATION_CATALOG[entry.provider];
      expect(provider, `${entry.provider} left the catalog`).toBeDefined();
      expect(
        provider?.headers?.[entry.header],
        `${entry.provider} no longer pins ${entry.header}: "${entry.weSend}" — if it moved, this ` +
          `caveat (${entry.issue}) needs re-reading, not editing.`,
      ).toBe(entry.weSend);
      const fixture = fixtures.find((f) => f.provider === entry.provider);
      expect(fixture, `${entry.provider} has no pinned fixture`).toBeDefined();
      expect(
        fixture?.version,
        `the pinned ${entry.provider} document is no longer ${entry.specVersion}`,
      ).toBe(entry.specVersion);
      expect(
        entry.weSend,
        `${entry.provider}: we now send the version the document describes — delete this entry, ` +
          "the caveat is over.",
      ).not.toBe(entry.specVersion);
    }
  });
});

describe("the checks themselves, on hand-built inputs", () => {
  /**
   * Each exit pinned on synthetic input, for the reason the drift spec pins `resolveBodyPath`: with
   * the catalog currently clean, several of these checks produce NOTHING against all 28 pinned
   * providers, and a check that has never been seen to fire is a comment rather than a test.
   */
  const fixtureWith = (
    op: RawOperation,
    upstreamPath = "/thing/{id}",
  ): Fixture => ({
    provider: "github",
    pathPrefix: "",
    version: "test",
    // Keyed by the shape the action will look up, but carrying `upstreamPath` — which is how a
    // pathPrefix regression looks from in here, and the only way the path arm is reachable at all.
    operations: new Map([
      ["GET /thing/{}", { path: upstreamPath, method: "GET", op }],
    ]),
  });
  const action = (fields: IntegrationField[]): IntegrationAction => ({
    key: "get_thing",
    label: "Get thing",
    description: "…",
    method: "GET",
    pathTemplate: "/thing/{id}",
    write: false,
    fields: [{ key: "id", label: "Id", in: "path", required: true }, ...fields],
  });
  /** `checkRequest` builds through the real catalog, so the synthetic action is compared by hand
   *  against a stub provider registered under a key the catalog does not use. */
  const run = (
    op: RawOperation,
    fields: IntegrationField[],
    upstreamPath?: string,
  ): RequestCheck => {
    const key = "__synthetic__";
    const built = action(fields);
    INTEGRATION_CATALOG[key] = {
      key,
      label: "Synthetic",
      description: "…",
      auth: "…",
      actions: [built],
    };
    try {
      return checkRequest(fixtureWith(op, upstreamPath), key, built);
    } finally {
      delete INTEGRATION_CATALOG[key];
    }
  };

  it("flags a query parameter the spec does not declare", () => {
    const check = run(
      {
        parameters: [
          { name: "id", in: "path", required: true },
          { name: "per_page", in: "query" },
        ],
      },
      [{ key: "perPage", label: "Per page", in: "query", required: false }],
    );
    expect(check.queryProblems).toHaveLength(1);
    expect(check.queryProblems[0]).toContain("?perPage=");
    expect(check.queryProblems[0]).toContain("{per_page}");
  });

  it("accepts a query parameter spelled exactly as the spec declares it", () => {
    const check = run(
      {
        parameters: [
          { name: "id", in: "path", required: true },
          { name: "per_page", in: "query" },
        ],
      },
      [{ key: "per_page", label: "Per page", in: "query", required: false }],
    );
    expect(check.queryProblems).toEqual([]);
    expect(check.confirmed.query).toBe(1);
  });

  it("says nothing when the spec declares no query parameters, and counts it unknowable", () => {
    // Silence must read as "cannot say", never as "agrees" — the same rule the drift spec's
    // tri-state body check follows.
    const check = run(
      { parameters: [{ name: "id", in: "path", required: true }] },
      [{ key: "anything", label: "Anything", in: "query", required: false }],
    );
    expect(check.queryProblems).toEqual([]);
    expect(check.unknowable.query).toBe(1);
  });

  it("flags a required query parameter the smallest legal call omits", () => {
    const check = run(
      {
        parameters: [
          { name: "id", in: "path", required: true },
          { name: "scope", in: "query", required: true },
        ],
      },
      [{ key: "scope", label: "Scope", in: "query", required: false }],
    );
    expect(check.queryProblems).toHaveLength(1);
    expect(check.queryProblems[0]).toContain("upstream requires ?scope=");
  });

  it("flags a header the spec does not declare", () => {
    const check = run(
      {
        parameters: [
          { name: "id", in: "path", required: true },
          { name: "From", in: "header" },
        ],
      },
      [{ key: "X-Made-Up", label: "Made up", in: "header", required: false }],
    );
    expect(check.headerProblems).toHaveLength(1);
    expect(check.headerProblems[0]).toContain("X-Made-Up");
  });

  it("accepts a header the spec declares, ignoring case", () => {
    const check = run(
      {
        parameters: [
          { name: "id", in: "path", required: true },
          { name: "from", in: "header" },
        ],
      },
      [{ key: "From", label: "From", in: "header", required: false }],
    );
    expect(check.headerProblems).toEqual([]);
    expect(check.confirmed.header).toBe(1);
  });

  it("flags a body key the spec declares as a query parameter", () => {
    const check = run(
      {
        parameters: [
          { name: "id", in: "path", required: true },
          { name: "filter", in: "query" },
        ],
      },
      [{ key: "filter", label: "Filter", in: "body", required: false }],
    );
    expect(check.placementProblems).toHaveLength(1);
    expect(check.placementProblems[0]).toContain('in:"query"');
  });

  it("flags a required body the built request does not carry", () => {
    const check = run(
      {
        parameters: [{ name: "id", in: "path", required: true }],
        requestBody: { required: true },
      },
      [{ key: "note", label: "Note", in: "body", required: false }],
    );
    expect(check.bodyProblems).toHaveLength(1);
  });

  /**
   * The path arm is NARROW, and saying how narrow is more useful than implying it is broad.
   *
   * Operations are looked up by path SHAPE, so a literal segment that differed would simply not
   * match and the drift spec's "resolves to an operation" would report it instead. What is left
   * reachable from here is the seam: the built path carries no `pathPrefix` and this file prepends
   * the fixture's, so a prefix that stops agreeing with the document — Stripe's `/v1`, Sentry's
   * `/api/0` — surfaces as a segment-count difference on every action at once. That is the case
   * below.
   */
  it("flags a built path whose segments do not line up with upstream's", () => {
    const check = run(
      { parameters: [{ name: "id", in: "path", required: true }] },
      [],
      "/v2/thing/{id}",
    );
    expect(check.pathProblems).toHaveLength(2); // one per shape
    expect(check.pathProblems[0]).toContain(
      "segment(s), upstream /v2/thing/{id}",
    );
  });

  it("passes a path that lines up", () => {
    const check = run(
      { parameters: [{ name: "id", in: "path", required: true }] },
      [],
    );
    expect(check.pathProblems).toEqual([]);
  });
});

describe("the round trip, on hand-built inputs", () => {
  /** The silent-loss shape, built through the real builder: a `json` field and a dotted field
   *  sharing a prefix. Whichever runs last wins, and no declaration is wrong. */
  it("catches a field overwritten by a sibling that shares its bodyPath prefix", () => {
    const key = "__synthetic_rt__";
    const clobbering: IntegrationAction = {
      key: "create",
      label: "Create",
      description: "…",
      method: "POST",
      pathTemplate: "/things",
      write: true,
      fields: [
        {
          key: "name",
          label: "Name",
          in: "body",
          required: true,
          bodyPath: "data.name",
        },
        {
          key: "data",
          label: "Data",
          in: "body",
          required: true,
          type: "json",
        },
      ],
    };
    INTEGRATION_CATALOG[key] = {
      key,
      label: "Synthetic",
      description: "…",
      auth: "…",
      actions: [clobbering],
    };
    try {
      const { lost } = roundTrip(key, clobbering, "FULL");
      expect(lost).toHaveLength(1);
      expect(lost[0].message).toContain('field "name"');
    } finally {
      delete INTEGRATION_CATALOG[key];
    }
  });
});

describe("coverage — what this run could and could not check", () => {
  it("reports it, including the providers no document can speak to", () => {
    const uncheckable = Object.keys(INTEGRATION_CATALOG).filter(
      (p) => !pinned.has(p),
    );
    const actions = Object.values(INTEGRATION_CATALOG).reduce(
      (n, p) => n + p.actions.length,
      0,
    );
    const unmatchedKeys = checks.filter((c) => !c.matched).map((c) => c.key);
    process.stderr.write(
      "\nrequest-contract coverage — what a GREEN run above actually compared:\n" +
        `    ${matched.length} of ${actions} catalog actions were built and compared against a pinned document\n` +
        `    ${matched.reduce((n, c) => n + c.confirmed.query, 0)} query parameter(s) confirmed declared upstream, ` +
        `${matched.reduce((n, c) => n + c.unknowable.query, 0)} unknowable (the operation declares none)\n` +
        `    ${matched.reduce((n, c) => n + c.confirmed.header, 0)} request header(s) confirmed declared upstream, ` +
        `${matched.reduce((n, c) => n + c.unknowable.header, 0)} unknowable\n` +
        `    ${roundTrips.length} field(s) lost during assembly, across ALL ${Object.keys(INTEGRATION_CATALOG).length} providers\n` +
        `    ${SPEC_OVERSTRICT.length} adjudicated as an over-strict document, ${KNOWN_DEFECT.length} as a known defect\n` +
        `    NOT compared — no pinned document (${uncheckable.length} provider(s)): ${uncheckable.join(", ")}\n` +
        `    NOT compared — no matching operation (${unmatchedKeys.length}, the drift spec's UNSPECIFIED list): ${unmatchedKeys.join(", ")}\n` +
        (advisories.length ? `    advisory: ${advisories.join("; ")}\n` : "") +
        "    NONE of this proves a call succeeds — see the file docblock, item 2.\n\n",
    );
    // The summary must be summarizing something.
    expect(matched.length).toBeGreaterThan(100);
    // Every uncheckable provider is a real catalog provider with no fixture — computed, never a
    // hand-written list, so adding a provider without a spec updates this by itself.
    for (const provider of uncheckable)
      expect(INTEGRATION_CATALOG[provider]).toBeDefined();
  });
});
