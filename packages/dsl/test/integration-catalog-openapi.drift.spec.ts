import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  INTEGRATION_CATALOG,
  type IntegrationAction,
  type IntegrationField,
  type IntegrationProvider,
} from "../src/integrations";
import { type ApiOperation, parseOpenApi } from "../src/introspection";

/**
 * The hand-written integration catalog, diffed against the providers' own OpenAPI specs.
 *
 * ## Why a drift test and not generated clients (#911)
 *
 * The catalog is hand-written, and twice in one week it was hand-written WRONG: #866 sent
 * `PUT /incidents/` because an `in:"path"` field substituted empty, and #909 shipped a header that
 * the API requires in practice as `required: false`. The obvious reaction — generate the catalog
 * from specs — is the wrong lever. A spec has no `label`, `hint`, `bodyPath`, `const` or `write`;
 * those are authoring-UI and save-gate concerns and they are most of the catalog's value. Curating
 * 38 providers down to the ~5 actions each that people actually use IS the feature, where a
 * generator would emit thousands of machine-named operations — and #910 is actively trying to get
 * this file's 161KB OUT of the deterministic workflow bundle, which generated clients would undo.
 *
 * So: leave the catalog hand-written, and make a test tell us when it stops matching upstream.
 *
 * ## What is hard-asserted vs. merely reported
 *
 * HARD (an unambiguous catalog bug, and one we caused):
 *   1. every action's `method` + `pathTemplate` resolves to a real upstream operation
 *   2. its `{placeholder}`s line up 1:1 with the upstream path's, each backed by an `in:"path"`
 *      field and declared as a path parameter upstream
 *   3. everything upstream marks REQUIRED — query, header, body, nested — exists somewhere in
 *      our `fields[]`
 *   5. every `in:"body"` field lands on a property the spec DECLARES (#813) — the check that
 *      catches a wrong `bodyPath`: a missing envelope key, a doubled one, or a `const`
 *      discriminator at the wrong depth. Tri-stated, and only WRONG is hard: see below.
 *
 * REPORTED, never failed — the #909 class:
 *   4. we model something `required: false` that upstream marks required, or our field name
 *      differs from upstream's parameter name.
 *   6. the media types upstream declares don't include the one we send (#707/#813). Advisory
 *      ONLY, and deliberately so: Slack's spec declares `application/x-www-form-urlencoded`
 *      because it is Swagger 2, yet Slack accepts JSON with a Bearer token. A spec's content map
 *      is evidence, not proof — the proof for changing an encoding is the provider's own docs.
 *
 * ## Why the body-path check is tri-stated (#813)
 *
 * "Not reported" must never be read as "verified". A `bodyPath` lands in one of three states:
 * CONFIRMED (it resolved to a property the spec declares), UNKNOWABLE (it landed inside a
 * free-form map like Notion's `properties`, or below where the fixture was pruned, so the spec
 * says nothing either way), or WRONG (the parent declares properties and this name is not among
 * them). Only WRONG fails. The counts of all three are printed by the coverage summary at the
 * bottom, because an audit that reports only its failures inflates its own coverage.
 *
 * (4) cannot be a hard failure because the honest answer is often "upstream is over-strict":
 * PagerDuty's spec marks `From` required on every write, but it is only required when the API key
 * is account-level, which no spec can express. A NEW finding therefore only warns. The
 * ACKNOWLEDGED list below is asserted in the OTHER direction — every entry must still be found —
 * so flipping `From` to `required: true` without deleting its acknowledgment, or upstream dropping
 * the requirement, does fail. That is a real assertion, and it is the review conversation worth
 * having.
 *
 * ## Why upstream cannot break this build
 *
 * The specs are VENDORED, pinned, and pruned — see `scripts/extract-openapi-fixtures.mjs` for the
 * refresh procedure and why. Nothing here touches the network, so a third party's outage, rate
 * limit or 3am republish cannot turn this red; upstream reaches CI only when a human refreshes a
 * fixture, in a PR, as a reviewable diff. Fixtures are read with `readFileSync` rather than
 * imported, so they add no runtime dependency and cannot reach the worker bundle.
 *
 * ## Reusing `parseOpenApi`
 *
 * Operation lookup + parameters come from `parseOpenApi` (`src/introspection.ts`) rather than a
 * second parser. It works here only because the fixtures are pre-dereferenced — it drops any
 * parameter lacking `name`/`in`, and GitHub's are all `$ref`s upstream. It deliberately does NOT
 * model request-body schemas (it serves httpRequest autocomplete, which needs to know only THAT a
 * body exists), so the required-body walk below reads the fixture JSON directly. That is a gap in
 * scope, not duplication.
 */

const FIXTURE_DIR = join(__dirname, "fixtures", "openapi");

/** Headers the request builder or the provider entry supplies — never the user, so a spec marking
 *  them required says nothing about our `fields[]`. `authScheme` owns `authorization`; the HTTP
 *  layer owns the rest. Compared lower-case: header names are case-insensitive. */
const TRANSPORT_HEADERS = new Set([
  "accept",
  "authorization",
  "content-type",
  "content-length",
  "user-agent",
]);

/**
 * Per-provider parameters that ARE the credential under a different name. Swagger 2 has no
 * `bearerFormat`, so Slack's spec models its OAuth token as a required header parameter literally
 * named `token`; `planIntegrationCall` sends it as `Authorization: Bearer …`, which is what Slack
 * documents. Listed per provider rather than globally: a header called `token` on some OTHER
 * provider might genuinely be a user-supplied value, and silently excusing it everywhere would
 * hide exactly the kind of missing field this test exists to find.
 */
const AUTH_PARAMETERS: Record<string, Set<string>> = {
  slack: new Set(["token"]),
};

/**
 * Findings of class (4) we have looked at and decided to keep. Each MUST still be produced —
 * an acknowledgment that no longer matches anything is either a fixed catalog entry whose note
 * was left behind, or upstream having changed its mind. Both deserve a look.
 */
const ACKNOWLEDGED: { finding: string; why: string }[] = [
  {
    finding:
      'pagerduty.create_incident: header "From" is required upstream, catalog says required:false',
    why: "#909 — required only for an account-level (General Access) key; a user-scoped key must NOT send it. No spec can express 'conditional on the key you hold'.",
  },
  {
    finding:
      'pagerduty.acknowledge_incident: header "From" is required upstream, catalog says required:false',
    why: "#909 — same conditional-on-key-scope rule.",
  },
  {
    finding:
      'pagerduty.resolve_incident: header "From" is required upstream, catalog says required:false',
    why: "#909 — same conditional-on-key-scope rule.",
  },
  {
    finding:
      'pagerduty.add_note: header "From" is required upstream, catalog says required:false',
    why: "#909 — same conditional-on-key-scope rule.",
  },
  {
    finding:
      'stripe.get_customer: path field "customerId" ↔ upstream "customer"',
    why: 'Deliberate rename: a config panel labelled "customer" reads as the customer OBJECT, not its id. Substitution is positional, so the name is ours to choose.',
  },
  {
    finding: 'twilio.get_message: path field "messageSid" ↔ upstream "Sid"',
    why: 'Deliberate rename: Twilio calls every id "Sid"; the action already has an accountSid, so an unqualified "Sid" would be ambiguous in the UI.',
  },
  {
    finding:
      'cloudflare.delete_dns_record: path field "recordId" ↔ upstream "dns_record_id"',
    why: 'Deliberate rename: the action is already scoped to DNS records, so the "dns_record_" prefix is noise in a config panel. Substitution is positional.',
  },
  {
    finding: 'discord.add_reaction: path field "emoji" ↔ upstream "emoji_name"',
    why: 'Deliberate rename: the segment takes either a unicode emoji or a custom `name:id`, so "emoji" describes the input better than upstream\'s "emoji_name".',
  },
  {
    finding: 'posthog.get_person: path field "personId" ↔ upstream "id"',
    why: 'Deliberate rename: a bare "id" in a config panel is ambiguous when the same action also takes a projectId.',
  },
  {
    finding:
      'box.create_folder: body "parent.id" is required upstream and reaches the API only inside the free-form JSON field "parent"',
    why: 'By design: `parent` is a `type: "json"` field whose hint is `{ "id": "0" } for root`. Splitting it into a scalar `parent.id` would drop the other keys Box accepts there.',
  },
  {
    finding:
      'sendgrid.send_mail: body "from.email" is required upstream and reaches the API only inside the free-form JSON field "from"',
    why: 'By design: `from` is a `type: "json"` field hinted `{ email, name? }`. The v3 Mail Send body is deeply structured (personalizations/content are arrays), so the whole envelope is authored as JSON.',
  },
];

/**
 * Actions with no upstream operation, on purpose. Empty today — an entry here is a claim that the
 * provider's own spec omits an endpoint they document elsewhere, which needs a reason, not a
 * shrug. (Refreshing the fixture is nearly always the right fix instead.)
 */
const UNSPECIFIED: { action: string; why: string }[] = [];

/**
 * WRONG body paths (#813) we have adjudicated and decided to keep — one per (action, field), and
 * each must STILL be produced, asserted below in the same both-directions way as ACKNOWLEDGED. An
 * entry is a claim that the spec is wrong or incomplete about a field we send on purpose; it is
 * not a place to park a finding nobody wanted to read.
 */
const ACKNOWLEDGED_BODY: { action: string; field: string; why: string }[] = [];

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────

/** `/repos/{owner}/{repo}/issues/{issueNumber}` → `/repos/{}/{}/issues/{}`. Placeholder NAMES are
 *  ours to pick (see ACKNOWLEDGED), so operations are matched on path SHAPE. */
const shape = (path: string): string => path.replace(/\{[^}]*\}/g, "{}");

/** Ordered placeholder names: `["owner", "repo", "issueNumber"]`. */
function placeholders(path: string): string[] {
  return [...path.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]);
}

/** `issue_number`, `IssueNumber` and `issueNumber` are the same name wearing different clothes. */
const normalizeName = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]/g, "");

/** A field the catalog fills in itself is always supplied — the save-gate never asks for it. */
const isSupplied = (f: IntegrationField): boolean =>
  f.required || f.const !== undefined;

/** Where a body field lands in the payload (`bodyPath` if it nests, else the key). */
const bodyPathOf = (f: IntegrationField): string => f.bodyPath ?? f.key;

/**
 * Every dotted path upstream marks required, walking INTO required objects:
 * PagerDuty's create_incident yields `incident`, `incident.type`, `incident.title`,
 * `incident.service`. Reads the fixture's pruned schema (see the docblock on `parseOpenApi`).
 */
function requiredBodyPaths(
  schema: unknown,
  prefix = "",
  depth = 0,
  out: string[] = [],
): string[] {
  if (!schema || typeof schema !== "object" || depth > 6) return out;
  const s = schema as { required?: unknown; properties?: unknown };
  const required = Array.isArray(s.required) ? s.required : [];
  const properties = (s.properties ?? {}) as Record<string, unknown>;
  for (const name of required) {
    if (typeof name !== "string") continue;
    const path = prefix ? `${prefix}.${name}` : name;
    out.push(path);
    if (properties[name])
      requiredBodyPaths(properties[name], path, depth + 1, out);
  }
  return out;
}

/** Body fields that satisfy a required path — exactly it, or nested underneath it: our
 *  `incident.service.id` is how we supply upstream's required `incident.service`. */
const coveringFields = (
  action: IntegrationAction,
  requiredPath: string,
): IntegrationField[] =>
  action.fields.filter(
    (f) =>
      f.in === "body" &&
      (bodyPathOf(f) === requiredPath ||
        bodyPathOf(f).startsWith(`${requiredPath}.`)),
  );

/**
 * A `type: "json"` field ABOVE the required path — the author pastes a whole object there, so the
 * required key is reachable but not something the catalog can guarantee. Box's `parent` (hint:
 * `{ "id": "0" } for root`) is how upstream's required `parent.id` gets sent; SendGrid's `from`
 * (`{ email, name? }`) is how `from.email` does. Not a hard failure — there IS a field, and its
 * hint names the key — but reported as an advisory, because "required" here lands on the author
 * rather than on the save gate.
 */
const jsonBlobAncestor = (
  action: IntegrationAction,
  requiredPath: string,
): IntegrationField | undefined =>
  action.fields.find(
    (f) =>
      f.in === "body" &&
      f.type === "json" &&
      requiredPath.startsWith(`${bodyPathOf(f)}.`),
  );

interface Fixture {
  provider: string;
  pathPrefix: string;
  source: string;
  fetchedAt: string;
  raw: Record<string, unknown>;
}

function loadFixtures(): Fixture[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => {
      const raw = JSON.parse(
        readFileSync(join(FIXTURE_DIR, file), "utf8"),
      ) as Record<string, unknown>;
      const meta = (raw["x-naary"] ?? {}) as Record<string, string>;
      return {
        provider: meta.provider ?? file.replace(/\.json$/, ""),
        pathPrefix: meta.pathPrefix ?? "",
        source: meta.source ?? "(unrecorded)",
        fetchedAt: meta.fetchedAt ?? "(unrecorded)",
        raw,
      };
    });
}

/** The pruned requestBody `content` map for an operation, or undefined when it declares no body. */
function requestBodyContent(
  fixture: Fixture,
  path: string,
  method: string,
): Record<string, { schema?: unknown }> | undefined {
  const paths = (fixture.raw.paths ?? {}) as Record<string, unknown>;
  const item = (paths[path] ?? {}) as Record<string, unknown>;
  const op = (item[method.toLowerCase()] ?? {}) as Record<string, unknown>;
  const body = op.requestBody as
    { content?: Record<string, { schema?: unknown }> } | undefined;
  return body?.content;
}

/** The pruned requestBody schema, preferring JSON then form (Stripe and Twilio accept ONLY form —
 *  #707 — and their specs say so). */
function requestBodySchema(
  fixture: Fixture,
  path: string,
  method: string,
): unknown {
  const content = requestBodyContent(fixture, path, method);
  if (!content) return undefined;
  const media =
    content["application/json"] ??
    content["application/x-www-form-urlencoded"] ??
    Object.values(content)[0];
  return media?.schema;
}

// ── the body-path check (#813) ──────────────────────────────────────────────────────────────────

/** Where one `bodyPath` landed against the spec. `unknowable` is a first-class answer. */
type BodyState = "confirmed" | "unknowable" | "wrong";
interface BodyVerdict {
  state: BodyState;
  /** Present for `unknowable` and `wrong` — the sentence a reader needs. */
  why?: string;
}

interface PrunedSchema {
  required?: string[];
  properties?: Record<string, PrunedSchema>;
  items?: PrunedSchema;
  type?: string;
  "x-freeform"?: boolean;
}

/**
 * Walk a dotted `bodyPath` down the pruned schema.
 *
 * The three exits, in the order they are reached:
 *   - the node is free-form (`additionalProperties`, or an object declaring no properties) — the
 *     spec permits any key, so nothing under it can be called wrong. UNKNOWABLE.
 *   - the node was never expanded (the fixture pruned it, or the spec is silent). UNKNOWABLE.
 *   - the node declares properties and ours is not one of them. WRONG, naming what it does declare.
 */
function resolveBodyPath(schema: unknown, dotted: string): BodyVerdict {
  let node = schema as PrunedSchema | undefined;
  if (!node || typeof node !== "object")
    return {
      state: "unknowable",
      why: "the operation declares no body schema",
    };
  const segments = dotted.split(".");
  for (const [i, segment] of segments.entries()) {
    const so_far = segments.slice(0, i).join(".");
    const where = so_far ? `"${so_far}"` : "the body root";
    if (node["x-freeform"] && !node.properties?.[segment])
      return {
        state: "unknowable",
        why: `${where} is a free-form object upstream — any key is legal there`,
      };
    if (node.type === "array")
      return {
        state: "wrong",
        why: `${where} is an ARRAY upstream, so "${dotted}" cannot address it — a dotted bodyPath only builds objects`,
      };
    const properties = node.properties;
    // A name upstream REQUIRES is a name upstream declares, whether or not it also bothered to
    // give it a `properties` entry. PagerDuty's `incident.body` requires `type` and lists only
    // `details` — its own docs show `{"type": "incident_body", "details": …}`, so calling our
    // `incident.body.type` wrong there would be believing the spec over the API.
    const requiredHere = new Set(node.required ?? []);
    if (!properties)
      return requiredHere.has(segment) && i === segments.length - 1
        ? { state: "confirmed" }
        : {
            state: "unknowable",
            why: `the pinned spec says nothing about the properties of ${where}`,
          };
    const next = properties[segment];
    if (!next) {
      if (requiredHere.has(segment)) {
        node = {}; // declared by `required` alone; nothing below it is knowable
        continue;
      }
      return {
        state: "wrong",
        why: `${where} declares {${Object.keys(properties).sort().join(", ")}} upstream — not "${segment}"`,
      };
    }
    node = next;
  }
  return { state: "confirmed" };
}

/** The media type `planIntegrationCall` will actually send for this action. */
const sentMediaType = (action: IntegrationAction): string =>
  action.bodyEncoding === "form"
    ? "application/x-www-form-urlencoded"
    : "application/json";

// ── analysis ────────────────────────────────────────────────────────────────────────────────────

/**
 * One catalog action, already compared against the pinned spec. Every comparison happens HERE, at
 * module load, and the `it`s below only assert on the result — so nothing depends on the order
 * vitest happens to run tests in. (The advisory report aggregates across providers; collecting it
 * inside the per-action tests would quietly under-report the moment someone ran this file with a
 * `-t` filter or an `it.only`.)
 */
interface ActionCheck {
  /** `"pagerduty.add_note"` — how every message names the action. */
  key: string;
  provider: string;
  action: IntegrationAction;
  /** The upstream operation, or undefined when nothing matched. */
  op?: ApiOperation;
  /** Set when UNSPECIFIED excuses the action from needing an upstream operation. */
  excused?: string;
  /** The `${METHOD} ${path-shape}` we looked up, for the failure message. */
  lookup: string;
  /** HARD failures, one message each. Empty = the check passed. */
  pathProblems: string[];
  paramProblems: string[];
  bodyProblems: string[];
  /** WRONG body paths (#813) — hard, unless ACKNOWLEDGED_BODY excuses one. */
  bodyPathProblems: string[];
  /** One entry per `in:"body"` field, so the coverage summary can count what was NOT proven. */
  bodyPathVerdicts: { field: string; path: string; verdict: BodyVerdict }[];
  /** Class-(4) differences: reported, never failed. */
  advisories: string[];
}

function checkAction(
  fixture: Fixture,
  provider: IntegrationProvider,
  action: IntegrationAction,
  operations: Map<string, ApiOperation>,
): ActionCheck {
  const key = `${fixture.provider}.${action.key}`;
  const lookup = `${action.method} ${shape(fixture.pathPrefix + action.pathTemplate)}`;
  const check: ActionCheck = {
    key,
    provider: fixture.provider,
    action,
    op: operations.get(lookup),
    excused: UNSPECIFIED.find((u) => u.action === key)?.why,
    lookup,
    pathProblems: [],
    paramProblems: [],
    bodyProblems: [],
    bodyPathProblems: [],
    bodyPathVerdicts: [],
    advisories: [],
  };
  const op = check.op;
  if (!op) return check; // nothing else is knowable; "resolves to an operation" reports it

  // (2) path placeholders ------------------------------------------------------------------------
  const ours = placeholders(action.pathTemplate);
  const theirs = placeholders(op.path);
  if (ours.length !== theirs.length)
    check.pathProblems.push(
      `we substitute ${ours.length} segment(s) into ${action.pathTemplate}, upstream's ${op.path} has ${theirs.length}`,
    );
  // Every placeholder we substitute must be a declared `in:"path"` field, and vice versa — the
  // #866 shape, where a placeholder with nothing behind it resolved to `PUT /incidents/`.
  const pathFields = action.fields
    .filter((f) => f.in === "path")
    .map((f) => f.key);
  for (const name of ours)
    if (!pathFields.includes(name))
      check.pathProblems.push(
        `${action.pathTemplate} substitutes {${name}} but no in:"path" field declares it`,
      );
  for (const name of pathFields)
    if (!ours.includes(name))
      check.pathProblems.push(
        `in:"path" field "${name}" lands nowhere — ${action.pathTemplate} has no {${name}}`,
      );
  // …and upstream must still declare that segment as a path parameter of the operation.
  const upstreamPathParams = op.parameters
    .filter((p) => p.in === "path")
    .map((p) => p.name);
  for (const name of theirs)
    if (!upstreamPathParams.includes(name))
      check.pathProblems.push(
        `upstream path ${op.path} no longer declares {${name}} as a path parameter`,
      );
  // Names are OURS to pick (substitution is positional) — a difference is worth a look, not a red
  // build. See the ACKNOWLEDGED entries for customerId↔customer and messageSid↔Sid.
  for (const [i, name] of ours.entries())
    if (theirs[i] && normalizeName(name) !== normalizeName(theirs[i]))
      check.advisories.push(
        `${key}: path field "${name}" ↔ upstream "${theirs[i]}"`,
      );

  // (3) required query + header parameters --------------------------------------------------------
  const staticHeaders = new Set(
    [
      ...Object.keys(provider.headers ?? {}),
      ...Object.keys(action.headers ?? {}),
      // A custom `authScheme` header is resolved IN-ACTIVITY from the connection (#655), so the
      // user never fills a field for it. Derived rather than listed, because the next provider
      // added to SOURCES may well be one of these (Shopify's X-Shopify-Access-Token, Monday,
      // ClickUp) and a hardcoded list would demand a `fields[]` entry for a header we already send.
      ...(typeof provider.authScheme === "object"
        ? [provider.authScheme.header]
        : []),
    ].map((h) => h.toLowerCase()),
  );
  const authParams = AUTH_PARAMETERS[fixture.provider];
  for (const param of op.parameters) {
    if (!param.required) continue;
    if (param.in !== "query" && param.in !== "header") continue;
    if (authParams?.has(param.name)) continue; // it IS the credential — see AUTH_PARAMETERS
    if (
      param.in === "header" &&
      (TRANSPORT_HEADERS.has(param.name.toLowerCase()) ||
        staticHeaders.has(param.name.toLowerCase()))
    )
      continue; // the transport or the catalog supplies it — no field needed
    const field = action.fields.find(
      (f) =>
        f.in === param.in && normalizeName(f.key) === normalizeName(param.name),
    );
    if (!field)
      check.paramProblems.push(
        `upstream requires ${param.in} "${param.name}" and the catalog has no ${param.in} field for it`,
      );
    else if (!isSupplied(field))
      check.advisories.push(
        `${key}: ${param.in} "${param.name}" is required upstream, catalog says required:false`,
      );
  }

  // (3) required body fields, nested included ------------------------------------------------------
  const schema = requestBodySchema(fixture, op.path, op.method);
  for (const required of requiredBodyPaths(schema)) {
    const covering = coveringFields(action, required);
    if (covering.length === 0) {
      const blob = jsonBlobAncestor(action, required);
      if (blob) {
        check.advisories.push(
          `${key}: body "${required}" is required upstream and reaches the API only inside the free-form JSON field "${blob.key}"`,
        );
        continue;
      }
      check.bodyProblems.push(
        `upstream requires body "${required}" and no catalog field writes there (none whose bodyPath is it, or nests under it)`,
      );
      continue;
    }
    // A required PARENT is satisfied by any guaranteed child — upstream's `incident` is present
    // because our `incident.title` is. Only flag when nothing underneath is guaranteed.
    if (!covering.some(isSupplied))
      check.advisories.push(
        `${key}: body "${required}" is required upstream, catalog says required:false`,
      );
  }

  // (5) every body field lands on a declared property (#813) ---------------------------------------
  for (const field of action.fields) {
    if (field.in !== "body") continue;
    const dotted = bodyPathOf(field);
    const verdict = resolveBodyPath(schema, dotted);
    check.bodyPathVerdicts.push({ field: field.key, path: dotted, verdict });
    if (verdict.state === "wrong")
      check.bodyPathProblems.push(
        `field "${field.key}" writes body "${dotted}": ${verdict.why}`,
      );
  }

  // (6) media type — advisory, never a failure -----------------------------------------------------
  const content = requestBodyContent(fixture, op.path, op.method);
  const declared = Object.keys(content ?? {});
  const sent = sentMediaType(action);
  // Only when the action HAS body fields: an upstream body we never populate says nothing.
  if (
    declared.length > 0 &&
    action.fields.some((f) => f.in === "body") &&
    !declared.some((m) => m.split(";")[0].trim() === sent)
  )
    check.advisories.push(
      `${key}: we send ${sent}, upstream declares only {${declared.sort().join(", ")}}`,
    );
  return check;
}

const fixtures = loadFixtures();

/** Every (fixture, action) pair, already compared. */
const checks: ActionCheck[] = fixtures.flatMap((fixture) => {
  const provider = INTEGRATION_CATALOG[fixture.provider];
  if (!provider) return [];
  const operations = new Map(
    parseOpenApi(fixture.raw).operations.map((op) => [
      `${op.method} ${shape(op.path)}`,
      op,
    ]),
  );
  return provider.actions.map((action) =>
    checkAction(fixture, provider, action, operations),
  );
});

const advisories = [...new Set(checks.flatMap((c) => c.advisories))].sort();

// ── the tests ───────────────────────────────────────────────────────────────────────────────────

describe("vendored spec fixtures", () => {
  it("exist, and each names a provider still in the catalog", () => {
    // Guards everything below: a lost fixture directory or a renamed provider would otherwise make
    // every describe() vanish and the suite go green having compared nothing at all.
    expect(fixtures.length).toBeGreaterThan(0);
    for (const fixture of fixtures)
      expect(
        INTEGRATION_CATALOG[fixture.provider],
        `${fixture.provider}.json has no INTEGRATION_CATALOG["${fixture.provider}"]`,
      ).toBeDefined();
  });

  it("contain no operation the catalog stopped calling", () => {
    // The extractor vendors ONLY the operations the catalog references, so an orphan means the two
    // have diverged — an action was renamed or deleted without refreshing. Checked in this
    // direction on purpose: the other direction (a NEW action with no vendored operation) is not a
    // second test, it is `resolves to an operation in the pinned spec` failing, as it should.
    for (const fixture of fixtures) {
      const referenced = new Set(
        checks
          .filter((c) => c.provider === fixture.provider)
          .map((c) => c.lookup),
      );
      for (const op of parseOpenApi(fixture.raw).operations)
        expect(
          referenced,
          `${fixture.provider}.json pins ${op.method} ${op.path} (${op.operationId ?? "?"}) but no ` +
            "catalog action calls it — re-run `pnpm refresh:openapi-fixtures` to drop it.",
        ).toContain(`${op.method} ${shape(op.path)}`);
    }
  });

  it("declare a pathPrefix the provider's baseUrl still ends with", () => {
    // The spec puts Stripe's `/v1` and Twilio's date stamp IN the path; our pathTemplates put it in
    // baseUrl. Move that boundary and every path below silently stops matching — so check the seam
    // itself rather than letting N operations all report "removed upstream".
    for (const fixture of fixtures) {
      const baseUrl = INTEGRATION_CATALOG[fixture.provider]?.baseUrl ?? "";
      expect(
        baseUrl.endsWith(fixture.pathPrefix),
        `${fixture.provider}: baseUrl "${baseUrl}" no longer ends with the fixture's pathPrefix "${fixture.pathPrefix}"`,
      ).toBe(true);
    }
  });
});

for (const check of checks) {
  describe(`${check.key}`, () => {
    it("resolves to an operation in the pinned spec", () => {
      if (check.excused) return; // documented as absent upstream — see UNSPECIFIED
      expect(
        check.op,
        `${check.key}: ${check.lookup} matches no operation in the pinned spec. Either upstream ` +
          "removed/renamed it (fix the catalog), or the action is new/changed and the fixture is " +
          "stale (`pnpm refresh:openapi-fixtures`), or it genuinely is not in the published spec " +
          "(add it to UNSPECIFIED with a reason).",
      ).toBeDefined();
    });

    it("substitutes only real path parameters", () => {
      expect(check.pathProblems, check.key).toEqual([]);
    });

    it("has a field for every required query/header parameter", () => {
      expect(check.paramProblems, check.key).toEqual([]);
    });

    it("has a field for every required body property", () => {
      expect(check.bodyProblems, check.key).toEqual([]);
    });

    it("writes every body field to a property the spec declares", () => {
      // #813. The envelope check: a missing `incident.` prefix, a doubled one, or a `const`
      // discriminator hung at the wrong depth all surface here as a name upstream doesn't have.
      const excused = new Set(
        ACKNOWLEDGED_BODY.filter((a) => a.action === check.key).map(
          (a) => a.field,
        ),
      );
      expect(
        check.bodyPathProblems.filter(
          (p) => !excused.has(p.match(/^field "([^"]+)"/)?.[1] ?? ""),
        ),
        check.key,
      ).toEqual([]);
    });
  });
}

describe("advisory drift — reported, never failed", () => {
  it("still finds every acknowledged difference", () => {
    for (const { finding, why } of ACKNOWLEDGED)
      expect(
        advisories,
        `no longer reported: "${finding}"\n  it was acknowledged because: ${why}\n  Either the ` +
          "catalog was fixed (delete the acknowledgment) or upstream changed its mind (worth a look).",
      ).toContain(finding);
  });

  it("reports differences nobody has looked at yet", async ({ annotate }) => {
    const known = new Set(ACKNOWLEDGED.map((a) => a.finding));
    const fresh = advisories.filter((a) => !known.has(a));
    // Reported TWICE, on purpose. `annotate` is the structured channel — it attaches the finding to
    // the test result, which is what CI reporters and `--reporter=verbose` surface. But the DEFAULT
    // reporter, the one `pnpm test` runs, prints neither annotations nor `console.warn` from a
    // PASSING test (both verified), and a report nobody sees is the same as no report — so the
    // human-readable copy goes straight to stderr, which the default reporter passes through.
    for (const finding of fresh) await annotate(finding, "warning");
    if (fresh.length)
      process.stderr.write(
        `\n⚠ ${fresh.length} new catalog/spec difference(s) — the #909 class. NOT a failure: a ` +
          "spec cannot say 'required only when…'. Judge each, then either fix the catalog or add\n" +
          "  it to ACKNOWLEDGED in packages/dsl/test/integration-catalog-openapi.drift.spec.ts.\n" +
          `${fresh.map((a) => `    • ${a}`).join("\n")}\n\n`,
      );
    // Deliberately NOT an assertion on `fresh` — see the file docblock. The report is the output.
    expect(advisories.length).toBeGreaterThanOrEqual(ACKNOWLEDGED.length);
  });

  it("still finds every acknowledged WRONG body path", () => {
    for (const { action, field, why } of ACKNOWLEDGED_BODY) {
      const check = checks.find((c) => c.key === action);
      expect(check, `${action} is no longer a checked action`).toBeDefined();
      expect(
        check?.bodyPathProblems.some((p) => p.startsWith(`field "${field}"`)),
        `${action}.${field} is no longer reported as a wrong body path.\n  it was ` +
          `acknowledged because: ${why}\n  Either the catalog was fixed (delete the entry) or ` +
          "upstream changed the schema (worth a look).",
      ).toBe(true);
    }
  });
});

/**
 * The honest coverage number for #813, printed rather than asserted.
 *
 * The audit's whole point is that "not reported" ≠ "verified", so the count that matters is how
 * many body fields were CONFIRMED against a spec versus how many the spec simply cannot speak to.
 * Printed from the same data the assertions above run on, so the table in the PR body cannot drift
 * from what the test actually checked.
 */
describe("body-encoding coverage (#813)", () => {
  it("reports how much of the catalog a spec can actually vouch for", () => {
    const writes = checks.filter((c) => c.action.write);
    const rows: string[] = [];
    let confirmed = 0;
    let unknowable = 0;
    let wrong = 0;
    for (const check of writes) {
      const counts = { confirmed: 0, unknowable: 0, wrong: 0 };
      for (const v of check.bodyPathVerdicts) counts[v.verdict.state]++;
      confirmed += counts.confirmed;
      unknowable += counts.unknowable;
      wrong += counts.wrong;
      rows.push(
        `    ${check.key.padEnd(34)} ${String(counts.confirmed).padStart(2)} confirmed  ` +
          `${String(counts.unknowable).padStart(2)} unknowable  ${String(counts.wrong).padStart(2)} wrong`,
      );
    }
    process.stderr.write(
      `\n#813 spec-verified write bodies — ${writes.length} write action(s) across ` +
        `${new Set(writes.map((c) => c.provider)).size} pinned provider(s):\n` +
        `${rows.join("\n")}\n` +
        `    ${"TOTAL body fields".padEnd(34)} ${confirmed} confirmed, ${unknowable} unknowable, ${wrong} wrong\n\n`,
    );
    // The only assertion: the summary must be summarizing something. A fixture directory that
    // stopped loading would otherwise print a tidy table of zeroes.
    expect(writes.length).toBeGreaterThan(0);
    expect(confirmed).toBeGreaterThan(0);
  });
});
