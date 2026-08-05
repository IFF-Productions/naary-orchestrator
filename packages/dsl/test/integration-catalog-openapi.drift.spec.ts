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
import {
  ACKNOWLEDGED,
  ACKNOWLEDGED_BODY,
  ACKNOWLEDGED_DEPRECATED,
  ACKNOWLEDGED_REQUIRED_BODY,
  UNSPECIFIED,
} from "./openapi-drift-adjudications";

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
 *   3b. a static header the catalog PINS carries a value the spec still lists (#944) — the check
 *      that catches a stale API-version pin, where every path can still match while the document
 *      describes a different API from the one we are asking for
 *   3c. the operation is not flagged `deprecated: true` (#1109) — the check that reads the one
 *      thing a vendor says about an endpoint's FUTURE rather than its shape. Adjudicated through
 *      ACKNOWLEDGED_DEPRECATED, so a known deprecation is a written decision and only a NEW one is
 *      red: see that list's docblock for why an un-adjudicated version of this check would be worse
 *      than none.
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
 * ## Where the adjudications live
 *
 * The four lists of looked-at-and-kept findings — `ACKNOWLEDGED`, `UNSPECIFIED`,
 * `ACKNOWLEDGED_BODY`, `ACKNOWLEDGED_REQUIRED_BODY` — are in `./openapi-drift-adjudications`. They
 * are prose, and they are what a reviewer argues with; the CHECKS are here. Every one of them is
 * asserted in the other direction below (it must still be produced), so moving them out cannot
 * silence anything.
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
 * A body key the PROTOCOL owns, not the author. `@odata.type` and its siblings are OData control
 * annotations: Microsoft Graph's generated document marks `@odata.type` required on every entity
 * because it is the discriminator of the CSDL base type, and no `fields[]` entry could sensibly
 * ask a user for it. Excluded by SHAPE (`@`-prefixed) rather than by name, and only in the
 * required walk — the same reasoning `TRANSPORT_HEADERS` applies to `content-type`.
 */
const isProtocolBodyKey = (name: string): boolean => name.startsWith("@");

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
    if (typeof name !== "string" || isProtocolBodyKey(name)) continue;
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

/** The fixture's raw entry for one operation. `parseOpenApi` models only what httpRequest
 *  autocomplete needs, so everything else here reads the vendored JSON directly. */
function rawOperation(
  fixture: Fixture,
  path: string,
  method: string,
): Record<string, unknown> {
  const paths = (fixture.raw.paths ?? {}) as Record<string, unknown>;
  const item = (paths[path] ?? {}) as Record<string, unknown>;
  return (item[method.toLowerCase()] ?? {}) as Record<string, unknown>;
}

/** The pruned requestBody `content` map for an operation, or undefined when it declares no body. */
function requestBodyContent(
  fixture: Fixture,
  path: string,
  method: string,
): Record<string, { schema?: unknown }> | undefined {
  const op = rawOperation(fixture, path, method);
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
  /** Names the spec marks `readOnly` — declared, but declared as response-only. */
  "x-readonly"?: string[];
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
 *
 * And one more on the way out: a name the spec marks `readOnly` is declared, so writing to it is
 * not wrong — but the spec is also saying it is response-only, so landing there is not
 * confirmation. UNKNOWABLE. PagerDuty forces the distinction: it marks a service reference's `id`
 * readOnly while its own docs require `incident.service.id` on every create.
 */
function resolveBodyPath(schema: unknown, dotted: string): BodyVerdict {
  const root = schema as PrunedSchema | undefined;
  if (!root || typeof root !== "object")
    return {
      state: "unknowable",
      why: "the operation declares no body schema",
    };
  // Non-optional from here on. Typed as `PrunedSchema | undefined` it went back to "possibly
  // undefined" on every loop iteration (the `node = next` reassignment), which also made
  // `properties`/`next` below implicitly `any` through a circular inference.
  let node: PrunedSchema = root;
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
    if (node["x-readonly"]?.includes(segment))
      return {
        state: "unknowable",
        why: `upstream declares "${segment}" on ${where} as readOnly — the spec calls it response-only, so it can neither confirm nor deny that we may send it`,
      };
    node = next;
  }
  return { state: "confirmed" };
}

/**
 * Declared value sets for an operation's HEADER parameters, read straight from the fixture and
 * keyed lower-case (header names are case-insensitive). `parseOpenApi` serves httpRequest
 * autocomplete and keeps only name/in/required, so this is the same deliberate gap the required-body
 * walk works around — not a second parser.
 */
function headerEnums(
  fixture: Fixture,
  path: string,
  method: string,
): Map<string, string[]> {
  const op = rawOperation(fixture, path, method);
  const params = Array.isArray(op.parameters) ? op.parameters : [];
  const out = new Map<string, string[]>();
  for (const raw of params) {
    const p = raw as { name?: unknown; in?: unknown; enum?: unknown };
    if (p.in !== "header" || typeof p.name !== "string") continue;
    if (!Array.isArray(p.enum) || p.enum.length === 0) continue;
    out.set(p.name.toLowerCase(), p.enum.map(String));
  }
  return out;
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
  /** A static header we send whose value the pinned spec does not list (#944). Hard. */
  headerValueProblems: string[];
  /** The vendor flags this operation `deprecated: true` (#1109). Hard, unless
   *  ACKNOWLEDGED_DEPRECATED carries a written decision to keep calling it. */
  deprecationProblems: string[];
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
    headerValueProblems: [],
    deprecationProblems: [],
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

  // (3b) a PINNED header VALUE must be one the spec accepts (#944) --------------------------------
  // #944's whole lesson, turned into a check. A version header is not decoration: Notion cuts a
  // version only for a backwards-INCOMPATIBLE change, so `Notion-Version` decides which request
  // shapes are legal — and we sent `2022-06-28` while the published document described a different
  // API, for a year, with a spec-diff test already in the repo. It could say nothing because it only
  // ever asked whether SOME field existed for a required header, never what value we put in it.
  //
  // Hard, and safe to be hard: fixtures are pinned, so this can only turn red when a human refreshes
  // one — at which point stale-pin and stale-fixture are the only two possibilities and both want a
  // person. Silent for every provider whose spec declares no value set, which is most of them.
  const enums = headerEnums(fixture, op.path, op.method);
  for (const [name, value] of Object.entries({
    ...(provider.headers ?? {}),
    ...(action.headers ?? {}),
  })) {
    const allowed = enums.get(name.toLowerCase());
    if (!allowed || allowed.includes(value)) continue;
    check.headerValueProblems.push(
      `we send ${name}: "${value}", the pinned spec declares only {${allowed.join(", ")}} — ` +
        "either the pin is stale (bump it, then re-read EVERY action against that version) or the " +
        "fixture is (`pnpm refresh:openapi-fixtures`)",
    );
  }

  // (3c) the vendor has not DEPRECATED this operation (#1109) --------------------------------------
  // The one thing a document says about an endpoint's future rather than its shape, and it used to
  // be thrown away: the extractor emitted `{operationId, parameters, requestBody}` and nothing else,
  // so there was not one `"deprecated": true` across 27 pinned providers and this file was
  // structurally blind to it. `sentry.list_issues` sat flagged inside a document already pinned here
  // while #946 moved its two siblings off the legacy route.
  //
  // Read from the fixture rather than from `parseOpenApi`, which models what httpRequest
  // autocomplete needs. Absence means the vendor said nothing — most never set the flag — so this is
  // positive evidence only, never a clean bill of health.
  if (rawOperation(fixture, op.path, op.method).deprecated === true)
    check.deprecationProblems.push(
      `upstream flags ${op.method} ${op.path} (${op.operationId ?? "?"}) deprecated:true — the ` +
        "vendor is telling us this endpoint is on its way out. Migrate to the successor their " +
        "document names, or add it to ACKNOWLEDGED_DEPRECATED with what the migration costs and " +
        "the issue that owns it.",
    );

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

/**
 * The classifier itself, on hand-built schemas.
 *
 * Necessary because the pinned providers happen to produce `confirmed` for almost everything, and
 * a tri-state classifier whose other two states have never been observed is a classifier being
 * trusted on the strength of its comments. These pin each exit with a schema shaped exactly like
 * what `extract-openapi-fixtures.mjs` emits — so a coverage line reading "0 unknowable" means
 * "checked, and none", not "that branch never ran".
 */
describe("resolveBodyPath — every exit", () => {
  it("confirms a declared property", () => {
    expect(resolveBodyPath({ properties: { title: {} } }, "title").state).toBe(
      "confirmed",
    );
  });

  it("confirms a nested property the spec declares", () => {
    const schema = {
      properties: { incident: { properties: { title: {} } } },
    };
    expect(resolveBodyPath(schema, "incident.title").state).toBe("confirmed");
  });

  it("calls an undeclared name WRONG, and says what upstream declares", () => {
    const verdict = resolveBodyPath(
      { properties: { incident: { properties: { title: {} } } } },
      "incident.severity",
    );
    expect(verdict.state).toBe("wrong");
    expect(verdict.why).toContain("declares {title}");
  });

  it("calls a path MISSING its envelope wrong", () => {
    // The #813 headline shape: `title` at the root when upstream wants `incident.title`.
    const verdict = resolveBodyPath(
      { properties: { incident: { properties: { title: {} } } } },
      "title",
    );
    expect(verdict.state).toBe("wrong");
  });

  it("calls a DOUBLED envelope wrong", () => {
    const verdict = resolveBodyPath(
      { properties: { incident: { properties: { title: {} } } } },
      "incident.incident.title",
    );
    expect(verdict.state).toBe("wrong");
  });

  it("calls nesting INTO an array wrong", () => {
    const verdict = resolveBodyPath(
      { properties: { contacts: { type: "array" } } },
      "contacts.email",
    );
    expect(verdict.state).toBe("wrong");
    expect(verdict.why).toContain("ARRAY");
  });

  it("is unknowable inside a free-form map", () => {
    // Notion's `properties`, Airtable's `fields`: upstream permits any key.
    const verdict = resolveBodyPath(
      { properties: { fields: { "x-freeform": true } } },
      "fields.Anything",
    );
    expect(verdict.state).toBe("unknowable");
    expect(verdict.why).toContain("free-form");
  });

  it("is unknowable where the fixture stopped expanding", () => {
    const verdict = resolveBodyPath({ properties: { data: {} } }, "data.name");
    expect(verdict.state).toBe("unknowable");
  });

  it("is unknowable when the operation declares no body at all", () => {
    expect(resolveBodyPath(undefined, "title").state).toBe("unknowable");
  });

  it("is unknowable on a readOnly property — declared, but response-only", () => {
    const verdict = resolveBodyPath(
      { properties: { id: {} }, "x-readonly": ["id"] },
      "id",
    );
    expect(verdict.state).toBe("unknowable");
    expect(verdict.why).toContain("readOnly");
  });

  it("accepts a name declared by `required` alone", () => {
    // PagerDuty's `incident.body`: `required: ["type"]`, `properties: {details}`.
    const schema = {
      properties: {
        body: { required: ["type"], properties: { details: {} } },
      },
    };
    expect(resolveBodyPath(schema, "body.type").state).toBe("confirmed");
  });
});

/**
 * The header-value pin (#944), on a hand-built fixture — for the same reason the classifier above
 * is: with the catalog now correct, this check produces NOTHING against all 14 pinned providers, and
 * a check that has never been seen to fire is a comment, not a test. These pin both directions and
 * the silence, so "0 problems" means "compared, and they agree".
 */
describe("the pinned-header-value check (#944)", () => {
  const withEnum = (values?: string[]): Fixture => ({
    provider: "notion",
    pathPrefix: "",
    source: "(hand-built)",
    fetchedAt: "(hand-built)",
    raw: {
      paths: {
        "/thing": {
          get: {
            parameters: [
              {
                name: "Notion-Version",
                in: "header",
                required: true,
                ...(values ? { enum: values } : {}),
              },
            ],
          },
        },
      },
    },
  });
  const action: IntegrationAction = {
    key: "get_thing",
    label: "Get thing",
    description: "…",
    method: "GET",
    pathTemplate: "/thing",
    write: false,
    fields: [],
  };
  const provider = (pinned: string): IntegrationProvider => ({
    key: "notion",
    label: "Notion",
    headers: { "Notion-Version": pinned },
    description: "…",
    auth: "…",
    actions: [action],
  });
  const operations = new Map<string, ApiOperation>([
    [
      "GET /thing",
      {
        method: "GET",
        path: "/thing",
        parameters: [{ name: "Notion-Version", in: "header", required: true }],
        hasBody: false,
      },
    ],
  ]);
  const problems = (pinned: string, values?: string[]): string[] =>
    checkAction(withEnum(values), provider(pinned), action, operations)
      .headerValueProblems;

  it("fails a stale pin, and names what the spec does accept", () => {
    // Exactly the #944 shape: the path matches, the required header has a value, and the value is
    // for an API version the pinned document no longer describes.
    const found = problems("2022-06-28", ["2026-03-11"]);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('we send Notion-Version: "2022-06-28"');
    expect(found[0]).toContain("{2026-03-11}");
  });

  it("passes the value the spec declares", () => {
    expect(problems("2026-03-11", ["2026-03-11"])).toEqual([]);
  });

  it("says nothing when the spec declares no value set", () => {
    // Most specs don't — silence must read as "cannot say", never as "agrees".
    expect(problems("2022-06-28", undefined)).toEqual([]);
  });
});

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

    it("pins a header value the spec still accepts", () => {
      expect(check.headerValueProblems, check.key).toEqual([]);
    });

    it("calls an operation the vendor has not deprecated", () => {
      // Safe to be HARD for the same reason (3b) is: fixtures are pinned, so this can only turn red
      // when a human refreshes one — never on an unrelated PR because a vendor republished at 3am.
      const excused = ACKNOWLEDGED_DEPRECATED.some(
        (a) => a.action === check.key,
      );
      expect(excused ? [] : check.deprecationProblems, check.key).toEqual([]);
    });

    it("has a field for every required body property", () => {
      const excused = new Set(
        ACKNOWLEDGED_REQUIRED_BODY.filter((a) => a.action === check.key).map(
          (a) => a.path,
        ),
      );
      expect(
        check.bodyProblems.filter(
          (p) => !excused.has(p.match(/body "([^"]+)"/)?.[1] ?? ""),
        ),
        check.key,
      ).toEqual([]);
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

  it("still finds every acknowledged DEPRECATED operation", () => {
    // The other direction, and the one that keeps the list from becoming a graveyard: an entry that
    // no longer matches anything means either the catalog migrated (delete it) or the vendor
    // un-flagged the endpoint (worth a look). Neither should pass silently.
    for (const { action, why } of ACKNOWLEDGED_DEPRECATED) {
      const check = checks.find((c) => c.key === action);
      expect(check, `${action} is no longer a checked action`).toBeDefined();
      expect(
        check?.deprecationProblems.length,
        `${action} is no longer reported as deprecated upstream.\n  it was acknowledged ` +
          `because: ${why}\n  Either the catalog moved to the successor (delete the entry) or the ` +
          "vendor dropped the flag (worth a look).",
      ).toBeGreaterThan(0);
    }
  });

  it("still finds every acknowledged MISSING required body property", () => {
    for (const { action, path, why } of ACKNOWLEDGED_REQUIRED_BODY) {
      const check = checks.find((c) => c.key === action);
      expect(check, `${action} is no longer a checked action`).toBeDefined();
      expect(
        check?.bodyProblems.some((p) => p.includes(`body "${path}"`)),
        `${action}: "${path}" is no longer reported as a missing required body property.\n  it ` +
          `was acknowledged because: ${why}\n  Either the catalog now supplies it (delete the ` +
          "entry) or upstream dropped the requirement (worth a look).",
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
    // The DENOMINATOR is computed from the whole catalog, not from the fixtures (#813 follow-up).
    // §2.5 of docs/integrations/VERIFICATION.md quotes an "X of Y" — counting Y by hand is how a
    // coverage claim goes stale silently the next time somebody adds a provider.
    const bodyBearing = (a: IntegrationAction) =>
      a.write === true && a.fields.some((f) => f.in === "body");
    const universe = Object.entries(INTEGRATION_CATALOG).flatMap(
      ([provider, entry]) =>
        entry.actions.filter(bodyBearing).map((a) => `${provider}.${a.key}`),
    );
    const writes = checks.filter((c) => c.action.write);
    const covered = new Set(
      writes.filter((c) => bodyBearing(c.action) && c.op).map((c) => c.key),
    );
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
    const providersWithBodyWrites = new Set(
      universe.map((k) => k.split(".")[0]),
    );
    // A `wrong` verdict still COUNTS in the total when it is acknowledged, so the table can print a
    // non-zero `wrong` on a green build. Saying how many are adjudicated is the difference between
    // that reading as "CI is red" and as "we looked, and wrote down why".
    const acknowledgedWrong = ACKNOWLEDGED_BODY.length;
    process.stderr.write(
      `\n#813 spec-verified write bodies — ${writes.length} write action(s) across ` +
        `${new Set(writes.map((c) => c.provider)).size} pinned provider(s):\n` +
        `${rows.join("\n")}\n` +
        `    ${"TOTAL body fields".padEnd(34)} ${confirmed} confirmed, ${unknowable} unknowable, ${wrong} wrong` +
        `${wrong ? ` (${acknowledgedWrong} acknowledged — see ACKNOWLEDGED_BODY)` : ""}\n` +
        `\n    COVERAGE  ${covered.size} of ${universe.length} body-bearing write actions, ` +
        `${new Set([...covered].map((k) => k.split(".")[0])).size} of ` +
        `${providersWithBodyWrites.size} providers.\n` +
        `    NOT covered: ${universe
          .filter((k) => !covered.has(k))
          .join(", ")}\n\n`,
    );
    // The summary must be summarizing something — a fixture directory that stopped loading would
    // otherwise print a tidy table of zeroes.
    expect(writes.length).toBeGreaterThan(0);
    expect(confirmed).toBeGreaterThan(0);
    // …and the numerator must be drawn from the same population as the denominator. `covered ⊆
    // universe` is true by construction TODAY; it stops being true the moment the two `bodyBearing`
    // computations drift apart, which is the only way this line can fail and the reason it is here.
    for (const key of covered) expect(universe).toContain(key);
    // Every `wrong` on a green build is adjudicated; a NEW one fails its own action's test above,
    // so this pins the printed number to the acknowledgment list rather than to nothing.
    expect(wrong).toBeLessThanOrEqual(acknowledgedWrong);
  });
});
