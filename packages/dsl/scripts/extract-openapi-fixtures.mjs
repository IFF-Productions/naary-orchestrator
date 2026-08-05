#!/usr/bin/env node
/**
 * Refreshes the pinned OpenAPI snapshots in `packages/dsl/test/fixtures/openapi/`, which
 * `integration-catalog-openapi.drift.spec.ts` diffs the hand-written catalog against.
 *
 * ## Why snapshots are vendored rather than fetched in the test
 *
 * A check that fails because a third party had an outage, a rate limit, or a 3am schema
 * republish gets muted, and a muted check is worth nothing. Pinning also means upstream can
 * only reach CI through a deliberate human refresh — this script, in its own PR — so the drift
 * shows up as a reviewable diff instead of a red build somebody else caused.
 *
 * ## Why the snapshots are TINY (a few KB, not the 12MB upstream)
 *
 * GitHub's description alone is ~13MB / 805 paths. We vendor only the operations the catalog
 * actually calls, and inside those only what the drift test reads:
 *
 *   - `$ref`s are RESOLVED and inlined, then `components` is dropped entirely. (GitHub's
 *     parameters are all `$ref`s; leaving them would drag the whole component bag back in, and
 *     `parseOpenApi` drops any parameter with no `name`/`in` — i.e. every GitHub path param.)
 *   - request-body schemas are PRUNED, and the pruning is guided BY THE CATALOG (#813): at every
 *     node it keeps all immediate property NAMES (so a failure can say "upstream declares
 *     {type,title,service}, we write `severity`"), but it only RECURSES along two chains — the
 *     `required` chain, and the dotted `bodyPath` prefixes this action actually writes into.
 *     A depth number alone would explode on Stripe/Cloudflare/PostHog; this keeps the fixture
 *     answering exactly the questions the catalog asks of it, and nothing more.
 *   - a free-form node (`additionalProperties`, or an object declaring no properties at all)
 *     is marked `x-freeform`, because "we can't tell" must not read as "wrong".
 *
 * The result is still a structurally valid OpenAPI 3 document — just a lossy one. It is a test
 * fixture, never served or shipped, and nothing outside the drift spec reads it.
 *
 * ## Refreshing
 *
 *     pnpm refresh:openapi-fixtures                  # builds @naary/dsl first, then runs this
 *     pnpm refresh:openapi-fixtures notion           # …just one provider (or several)
 *     git diff packages/dsl/test/fixtures/openapi/   # review the drift, then run the test
 *
 * Needs network (it fetches each SOURCES url). A non-empty diff is the interesting part: it is
 * upstream telling you the catalog may now be wrong. Re-run `pnpm test` after refreshing.
 *
 * ## Adding a provider
 *
 * Add an entry to SOURCES below and re-run. `pathPrefix` is the part of the provider's `baseUrl`
 * that the spec puts in its paths but our `pathTemplate`s don't (Stripe's `/v1`, Twilio's date
 * stamp); the drift spec asserts `baseUrl` still ends with it, so a baseUrl edit can't silently
 * un-match every path. A `.yaml`/`.yml` url is parsed too (`format: "yaml"` is inferred from the
 * url and can be forced). Providers whose spec is unofficial, split across external `$ref` files,
 * or GraphQL are deliberately out — a bad fixture is worse than no fixture, and
 * `docs/integrations/VERIFICATION.md` §2.5 records WHY each one is out rather than leaving the
 * absence to be re-litigated.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "test", "fixtures", "openapi");

/**
 * provider key (must exist in INTEGRATION_CATALOG) → where its spec lives.
 *
 * `url` may be an ARRAY when a provider publishes one document per API area (SendGrid ships ~50).
 * They are indexed in order and the FIRST match for an operation wins, so the list is a search
 * path, not a merge.
 */
const SOURCES = {
  github: {
    url: "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json",
    pathPrefix: "",
  },
  pagerduty: {
    url: "https://raw.githubusercontent.com/PagerDuty/api-schema/main/reference/REST/openapiv3.json",
    pathPrefix: "",
  },
  stripe: {
    url: "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json",
    pathPrefix: "/v1",
  },
  twilio: {
    url: "https://raw.githubusercontent.com/twilio/twilio-oai/main/spec/json/twilio_api_v2010.json",
    pathPrefix: "/2010-04-01",
  },
  // ── added by #813, the write-body audit ────────────────────────────────────────────────────
  discord: {
    url: "https://raw.githubusercontent.com/discord/discord-api-spec/main/specs/openapi.json",
    pathPrefix: "",
  },
  slack: {
    // Slack's own spec is SWAGGER 2.0 — its payload is `in:"formData"` parameters, rewritten into
    // an OpenAPI-3 `requestBody` by `swagger2RequestBody`. Slack ALSO accepts `application/json`
    // when the token is a Bearer, which the spec has no way to say; that is why the media-type
    // comparison in the drift spec is advisory and not a hard failure.
    url: "https://raw.githubusercontent.com/slackapi/slack-api-specs/master/web-api/slack_web_openapi_v2.json",
    pathPrefix: "",
  },
  box: {
    url: "https://raw.githubusercontent.com/box/box-openapi/en/openapi.json",
    pathPrefix: "",
  },
  front: {
    url: "https://raw.githubusercontent.com/frontapp/front-api-specs/main/core-api/core-api.json",
    pathPrefix: "",
  },
  cloudflare: {
    url: "https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.json",
    pathPrefix: "",
  },
  posthog: {
    // us.posthog.com, not the legacy app.posthog.com alias (#1110). The pinned fixture still
    // records the old URL as its `source`; a refresh rewrites that, and the schema is the same
    // document either way — PostHog's regions differ in DATA, not in API shape.
    url: "https://us.posthog.com/api/schema/?format=json",
    pathPrefix: "",
  },
  sendgrid: {
    url: [
      "https://raw.githubusercontent.com/twilio/sendgrid-oai/main/spec/json/tsg_mail_v3.json",
      "https://raw.githubusercontent.com/twilio/sendgrid-oai/main/spec/json/tsg_mc_contacts_v3.json",
      "https://raw.githubusercontent.com/twilio/sendgrid-oai/main/spec/json/tsg_templates_v3.json",
    ],
    pathPrefix: "/v3",
  },
  asana: {
    url: "https://raw.githubusercontent.com/Asana/openapi/master/defs/asana_oas.yaml",
    pathPrefix: "",
  },
  intercom: {
    url: "https://raw.githubusercontent.com/intercom/Intercom-OpenAPI/main/descriptions/2.16/api.intercom.io.yaml",
    pathPrefix: "",
  },
  digitalocean: {
    url: "https://raw.githubusercontent.com/digitalocean/openapi/main/specification/DigitalOcean-public.v2.yaml",
    pathPrefix: "/v2",
    // The root document is a table of contents — `paths: {/v2/droplets: {$ref: "resources/…"}}`.
    external: true,
  },
  gitlab: {
    // NAMING TRAP: `_v2`/`_v3` here mean SWAGGER 2.0 vs OPENAPI 3, not GitLab API versions — both
    // describe API v4. Take the OpenAPI 3 one: it has 1,247 paths to the Swagger file's 863, and
    // the extra 384 include both routes we would otherwise have had to excuse (`/user` and the
    // issue Notes API). `openapi.yaml`, the hand-written file #813 looked at, no longer exists.
    url: "https://gitlab.com/gitlab-org/gitlab/-/raw/master/doc/api/openapi/openapi_v3.yaml",
    pathPrefix: "/api/v4",
    format: "yaml",
  },
  jira: {
    // NAMING TRAP, the other way round: `swagger-v3.v3.json` is the API-v3 document, while
    // `swagger.v3.json` — this one — is the API-v2 document expressed in OpenAPI 3. Our actions
    // target `/rest/api/2` deliberately (v3 takes Atlassian Document Format where v2 takes a plain
    // string), and #813 recorded "v3 spec only" because of the filename. There IS a v2 document.
    url: "https://developer.atlassian.com/cloud/jira/platform/swagger.v3.json",
    pathPrefix: "",
    format: "json",
  },
  msgraph: {
    // 38MB, and vendored anyway: it parses in ~4s and prunes to a few KB, so the cost lands on
    // whoever runs the refresh, not on CI. The per-workload slices in msgraph-sdk-powershell are
    // 21× smaller but spell the action path differently (`/users/{user-id}/microsoft.graph.sendMail`),
    // so they would compare our request against a path we do not call.
    url: "https://raw.githubusercontent.com/microsoftgraph/msgraph-metadata/master/openapi/v1.0/openapi.yaml",
    pathPrefix: "",
  },
  mattermost: {
    // The BUNDLED artifact, published by Mattermost on their docs host. The source repo
    // (mattermost/mattermost-api-reference) holds 39 split fragments that its Makefile `cat`s
    // together and validates; only this URL is pre-bundled, so vendoring the repo would mean
    // reimplementing their build.
    url: "https://developers.mattermost.com/mattermost-openapi-v4.yaml",
    pathPrefix: "",
  },
  mailchimp: {
    // `?expand` is LOAD-BEARING. Without it the document is 74KB of external `$ref`s pointing at
    // `https://us22.api.mailchimp.com/…` — one datacenter's hostname baked into every ref, which
    // would pin us to somebody else's account region. `?expand` returns the same spec inlined.
    url: "https://api.mailchimp.com/schema/3.0/Swagger.json?expand",
    pathPrefix: "",
    format: "json",
  },
  hubspot: {
    // HubSpot serves ONE document per API from its own catalog; the release id is opaque and not
    // guessable — list them with `GET https://api.hubapi.com/public/api/spec/v1/specs` to find a
    // newer one. This is the CRM Contacts v3 document. Deals is deliberately absent: see
    // UNSPECIFIED for hubspot.create_deal.
    url: "https://api.hubapi.com/public/api/spec/v2/specs/release/22150/version/3",
    pathPrefix: "",
    format: "json",
  },
  clickup: {
    // ClickUp's ReadMe project serves their own document from their own docs host. The `/v2` lives
    // in the PATH here and in our `baseUrl`, hence the prefix.
    url: "https://developer.clickup.com/openapi/clickup-api-v2-reference.json",
    pathPrefix: "/v2",
  },
  webflow: {
    // The Fern SDK input, in Webflow's own org (`x-fern-sdk-method-name` extensions are the tell).
    url: "https://raw.githubusercontent.com/webflow/openapi-spec/main/openapi/v2.yml",
    pathPrefix: "",
  },
  todoist: {
    // Todoist's own document, and the reason the catalog's base URL moved: it describes ONLY
    // `/api/v1` paths, because `/rest/v2` now answers 410 Gone. Pinning it is what stops the
    // catalog drifting back.
    url: "https://developer.todoist.com/openapi.json",
    pathPrefix: "/api/v1",
    format: "json",
  },
  calendly: {
    // Calendly's docs are a Stoplight project and this file is NOT linked from any page; it was
    // found by following a Gatsby chunk → Stoplight projectId `cHJqOjY4NTM` (base64 `prj:6853`) →
    // the project's table-of-contents API → the node uri. Recorded because it is not re-derivable
    // by guessing, and two shapes of 404 are waiting: the workspace host is load-bearing (the same
    // path on `stoplight.io` returns "Not found"), and the uri carries a DIRECTORY segment
    // (`reference/calendly-api/openapi.yaml`, not `reference/calendly-api.yaml`). A 404 whose body
    // is `{"statusCode":404,…,"message":"'/…' not found."}` means the project resolved and only the
    // path is wrong — look the uri up again rather than guessing another one.
    url: "https://calendly.stoplight.io/api/v1/projects/calendly/api-docs/nodes/reference/calendly-api/openapi.yaml",
    pathPrefix: "",
    format: "yaml",
  },
  zoom: {
    // Zoom's API Hub serves one document per PRODUCT, and no single one covers all five actions:
    // four are in `meetings`, the user read is in `users`. The array is a search path (first match
    // wins), which is exactly the shape this needs.
    url: [
      "https://developers.zoom.us/api-hub/meetings/methods/endpoints.json",
      "https://developers.zoom.us/api-hub/users/methods/endpoints.json",
    ],
    pathPrefix: "",
  },
  // ── added by #944, the Notion data-source migration ────────────────────────────────────────────
  notion: {
    // Notion DOES publish a machine-readable document — one file, openapi 3.1.0, 34 paths, no
    // external `$ref`s — which #931's row ("no official document found") had missed. It describes
    // exactly ONE API version, and says which: `Notion-Version` is declared `enum: ["2026-03-11"]`.
    // That makes the fixture a pin on the version too, so the day the catalog's provider-wide
    // header and this document disagree, every Notion action stops matching and the drift spec
    // says so — which is precisely the failure mode #944 was filed about.
    url: "https://developers.notion.com/openapi.json",
    pathPrefix: "/v1",
  },
  // ── added by #946, moving the two issue actions onto the org-scoped route ──────────────────────
  sentry: {
    // Sentry's own generated document, published as a build artifact of their API. `-derefed` is
    // the one to take: the sibling `openapi.json` is a table of contents whose `paths` are external
    // `$ref`s into per-file fragments, which would need `external: true` and a second fetch layer
    // for no gain. This file is self-contained.
    //
    // The path prefix is `/api/0` because the document spells routes in full
    // (`/api/0/organizations/{organization_id_or_slug}/issues/{issue_id}/`) while our `baseUrl`
    // already ends in `/api/0`. Pinning it is what stops `get_issue`/`update_issue` drifting back
    // to the legacy un-scoped form, which works but appears in no Sentry document (#946).
    url: "https://raw.githubusercontent.com/getsentry/sentry-api-schema/main/openapi-derefed.json",
    pathPrefix: "/api/0",
  },
};

/**
 * Providers deliberately NOT vendored, and why — WITH where we looked, so nobody repeats a search
 * that already came back empty. Kept next to SOURCES so "why isn't X here?" has an answer that
 * survives the person who checked; `docs/integrations/VERIFICATION.md` §2.5 carries the same list
 * for readers who never open this script.
 *
 * The bar is VENDOR-AUTHORED: their GitHub org, their docs host, an endpoint their API serves, or a
 * spec embedded in their own SDK repo. APIs.guru conversions, third-party Postman collections and
 * anything we would transform ourselves are excluded on purpose — a fixture we authored proves our
 * request matches our own reading, which is the mistake #813 caught one level down.
 *
 *   linear, monday — GraphQL, so permanently out of scope FOR THIS SCRIPT: the body is
 *                `{query, variables}`, correct by construction, and the risk is inside the query
 *                string. That risk is now covered by a sibling instrument rather than left
 *                unchecked — `extract-graphql-schema-fixtures.mjs` pins each vendor's SCHEMA and
 *                `integration-catalog-graphql.drift.spec.ts` diffs the query hints against it
 *                (#943). Neither vendor requires a credential for that.
 *   googlesheets — Google publishes a DISCOVERY document (sheets.googleapis.com/$discovery/rest
 *                ?version=v4), not OpenAPI. Checked the googleapis GitHub org for an official
 *                conversion; the ones that exist are APIs.guru's.
 *   dropbox    — Dropbox publishes its API in its own STONE IDL (github.com/dropbox/dropbox-api-spec,
 *                `.stone` files). Machine-readable, not OpenAPI, and no OpenAPI build is published.
 *   shopify    — no vendor REST document exists. The REST Admin API is legacy and Shopify publishes
 *                only the GraphQL schema; the OpenAPI files in circulation are third-party and
 *                stale (2020-era). Checked the Shopify GitHub org and shopify.dev.
 *   airtable   — the spec is real and Airtable's own, but it is only available EMBEDDED in the docs
 *                page's SSR state (an `"openApi"` key in the page JSON) with no raw URL. Scraping
 *                HTML would put a third party's page structure in the refresh path, which is what
 *                pinning exists to avoid.
 *   pipedrive  — the published v1 document no longer contains `POST /deals`, `PUT /deals/{id}` or
 *                `POST /persons`; that CRUD is v2-only, which needs a different base path, `PATCH`
 *                instead of `PUT`, and `{id}`. Vendoring v2 would diff our requests against
 *                endpoints we don't call. (A live probe can't settle it either: Pipedrive
 *                authenticates before routing, so an unknown path also answers 401.)
 *   zendesk    — real and fetchable (developer.zendesk.com/zendesk/oas.yaml) but canonicalises paths
 *                WITHOUT the `.json` suffix our catalog uses (`/api/v2/tickets` vs `/tickets.json`).
 *                #813 deferred the rewrite seam until a second provider needed it and named Shopify
 *                as that provider — but Shopify publishes no spec at all, so the condition can no
 *                longer be met, and 3 actions don't justify a transform duplicated across this
 *                script and the drift spec where a desync silently stops matching.
 * `notion` was on that last row and should not have been: `developers.notion.com/openapi.json` is
 * vendor-published, fetchable, and self-contained. It is in SOURCES as of #944. The lesson is that
 * "not found" is a statement about a search, so it belongs next to the search that came back
 * empty — and it expires the moment somebody looks again.
 *
 * `sentry` came off this list the same way, and for a sharper reason (#946). Its row read "documents
 * only the org-scoped issue route; ours is the legacy un-scoped one" — which was true, and was a
 * finding about OUR CATALOG rather than about Sentry's document. The un-scoped path works, so the
 * row had quietly become a reason not to look, when the actual fix was to call the route the vendor
 * documents. A provider whose spec exists and is fetchable does not belong here just because our
 * request doesn't match it; that is the case the drift spec is FOR.
 */

/** Placeholders differ in name between us and upstream, so match on SHAPE. */
const shape = (path) => path.replace(/\{[^}]*\}/g, "{}");

const { INTEGRATION_CATALOG } = await import(
  join(here, "..", "dist", "integrations.js")
);

/** Resolve a local `#/…` `$ref` (specs mix inline and referenced nodes freely). */
function makeDeref(root) {
  return function deref(node, depth = 0) {
    if (!node || typeof node !== "object" || depth > 20) return node;
    if (typeof node.$ref === "string" && node.$ref.startsWith("#/")) {
      const parts = node.$ref
        .slice(2)
        .split("/")
        .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
      let cur = root;
      for (const p of parts) cur = cur?.[p];
      return deref(cur, depth + 1);
    }
    return node;
  };
}

// ── external `$ref`s ────────────────────────────────────────────────────────────────────────────
//
// DigitalOcean and GitLab publish a ROOT document that is little more than a table of contents:
// `paths: { /v2/droplets: { $ref: "resources/droplets/droplets.yml" } }`. `makeDeref` only ever
// resolved `#/` refs, so those path items arrived with no `get`/`post` key at all and every action
// looked "removed upstream" — which is why #813 filed them as unvendorable rather than wrong.
//
// The fix is deliberately DEMAND-DRIVEN, not a bundler. Fetching the transitive closure of a
// multi-file spec is hundreds of requests for a catalog that calls four operations; instead the
// path index is keyed by path SHAPE alone (no method — that is only knowable after resolving), and
// a path item is materialized ONLY when an action matches its shape. Resolution is memoized per
// path, so two actions on one path (`GET`/`POST /droplets`) fetch once.

/** Absolute url → parsed document. Shared across providers: a `$ref` chain revisits files. */
const documents = new Map();

async function loadDocument(url, format) {
  const cached = documents.get(url);
  if (cached) return cached;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  const isYaml =
    (format ?? (/\.ya?ml($|\?)/.test(url) ? "yaml" : "json")) === "yaml";
  // `yaml` is a devDependency of this package and imported LAZILY, so a JSON-only refresh still
  // runs if it isn't installed — and nothing here is reachable from `dist/`, which apps/web bundles.
  const doc = isYaml
    ? (await import("yaml")).parse(await res.text())
    : await res.json();
  documents.set(url, doc);
  return doc;
}

/** A JSON-Pointer fragment (`/components/schemas/Foo`, or "" for the whole document). */
function pointerInto(doc, pointer) {
  if (!pointer || pointer === "/") return doc;
  let cur = doc;
  for (const raw of pointer.replace(/^\//, "").split("/")) {
    const part = decodeURIComponent(raw)
      .replace(/~1/g, "/")
      .replace(/~0/g, "~");
    cur = cur?.[part];
  }
  return cur;
}

/**
 * Inline every `$ref` under `node` — local (`#/…`) and external (`shared/models/x.yml#/foo`),
 * the latter resolved as a URL RELATIVE to the document that contained it, which is what makes a
 * split spec resolvable from one entry point.
 *
 * `hops` counts REF FOLLOWS, not object depth: a plain nested object costs nothing, so a legitimate
 * schema is never truncated for being deep, while a `$ref` chain is bounded. Cycles — a schema that
 * references itself, which both DigitalOcean and GitLab have — are caught by `stack`, the set of
 * refs already being resolved ON THIS PATH; a depth counter alone cannot tell a cycle from a deep
 * chain, and the marker left behind says which it was.
 */
async function materialize(node, docUrl, stack = new Set(), hops = 0) {
  if (!node || typeof node !== "object") return node;
  if (Array.isArray(node))
    return Promise.all(node.map((n) => materialize(n, docUrl, stack, hops)));
  if (typeof node.$ref === "string") {
    if (hops > 12) return { "x-ref-depth-exceeded": node.$ref };
    const [file, pointer = ""] = node.$ref.split("#");
    const targetUrl = file ? new URL(file, docUrl).href : docUrl;
    const key = `${targetUrl}#${pointer}`;
    if (stack.has(key)) return { "x-circular-ref": node.$ref };
    const target = pointerInto(await loadDocument(targetUrl), pointer);
    if (target === undefined) return { "x-unresolved-ref": node.$ref };
    // ONE stack for both descents. The target and the siblings are both reached THROUGH this
    // `$ref`, so `key` is on the path for both — giving the siblings the un-extended `stack`
    // meant a sibling pointing back at this same key wasn't seen as a cycle and re-resolved the
    // chain, bounded only by the `hops > 12` backstop rather than caught as circular. OpenAPI 3.1
    // permits `$ref` siblings, so that shape is legal input, not a malformed spec.
    const stackWithKey = new Set(stack).add(key);
    const resolved = await materialize(
      target,
      targetUrl,
      stackWithKey,
      hops + 1,
    );
    // OpenAPI 3.1 allows keys beside `$ref` (a `description` override, most often). Ours win.
    // `hops` is NOT incremented: siblings sit at this node's level, not one indirection deeper.
    const { $ref: _ignored, ...siblings } = node;
    return Object.keys(siblings).length
      ? {
          ...resolved,
          ...(await materialize(siblings, docUrl, stackWithKey, hops)),
        }
      : resolved;
  }
  const out = {};
  for (const [k, v] of Object.entries(node))
    out[k] = await materialize(v, docUrl, stack, hops);
  return out;
}

/**
 * Flatten a schema's composition keywords into one view.
 *
 * `required` comes from `allOf` + the node itself ONLY. A `oneOf`/`anyOf` branch's `required` is
 * conditional on picking that branch, and the drift spec HARD-fails on a missing required body
 * field — so unioning them would manufacture failures for fields nobody has to send. Property
 * NAMES are unioned across every branch, in the other direction: the name check is what flags a
 * wrong `bodyPath`, and a name that is legal in any branch is a name we must not call wrong.
 */
function mergeBranches(schema, deref) {
  const s = deref(schema);
  if (!s || typeof s !== "object") return null;
  const required = [];
  const properties = {};
  const readOnly = new Set();
  let freeform = false;
  const visit = (node, takeRequired) => {
    const b = deref(node);
    if (!b || typeof b !== "object") return;
    if (takeRequired)
      for (const r of Array.isArray(b.required) ? b.required : [])
        if (typeof r === "string" && !required.includes(r)) required.push(r);
    for (const [name, sub] of Object.entries(b.properties ?? {})) {
      // `readOnly` is noted but the NAME is kept, and the asymmetry is deliberate. Dropping it
      // from `required` is safe: a spec that reuses one serializer for request and response
      // (PostHog's drf-spectacular marks `id`, `created_at`, `created_by`, `insight_name`…
      // required AND readOnly) would otherwise demand catalog fields for a dozen response
      // columns. Dropping the name is NOT safe: PagerDuty marks a service reference's `id`
      // readOnly, and `incident.service.id` is exactly what a create_incident must send — losing
      // the name would have the body-path check call our own correct field wrong.
      if (deref(sub)?.readOnly === true) readOnly.add(name);
      properties[name] ??= sub;
    }
    // `additionalProperties: true|{schema}` — an arbitrary map (Notion's `properties`, Airtable's
    // `fields`). Anything we write there is UNKNOWABLE, never wrong.
    if (b.additionalProperties && b.additionalProperties !== false)
      freeform = true;
    for (const branch of Array.isArray(b.allOf) ? b.allOf : [])
      visit(branch, takeRequired);
    for (const branch of [
      ...(Array.isArray(b.oneOf) ? b.oneOf : []),
      ...(Array.isArray(b.anyOf) ? b.anyOf : []),
    ])
      visit(branch, false);
  };
  visit(s, true);
  // A `readOnly` name stays out of `required` too — "required" on a server-generated column means
  // "always present in the RESPONSE", never "you must send it".
  return {
    raw: s,
    required: required.filter((r) => !readOnly.has(r)),
    properties,
    readOnly,
    freeform,
  };
}

/**
 * Prune a request-body schema down to what the drift spec reads: `required`, immediate property
 * NAMES, and — only along the `required` chain and the catalog's own `bodyPath` prefixes — the
 * same again one level deeper. `keep` is the set of dotted paths worth recursing into; see the
 * file docblock for why a plain depth limit is not enough.
 *
 * Depth-capped as a backstop so a self-referential schema (PagerDuty has several) can't run away.
 */
function pruneSchema(schema, deref, keep, prefix = "", depth = 0) {
  const merged = mergeBranches(schema, deref);
  if (!merged || depth > 5) return {};
  const { raw, required, properties, readOnly, freeform } = merged;
  const out = {};
  // An ARRAY's properties live under `items`. Kept so the spec can tell "you nested into a list"
  // from "that name doesn't exist" — different findings with different fixes.
  if (raw.type === "array" || raw.items) {
    out.type = "array";
    const items = pruneSchema(raw.items, deref, keep, prefix, depth + 1);
    if (Object.keys(items).length) out.items = items;
    return out;
  }
  if (required.length) out.required = required;
  const names = Object.keys(properties);
  if (names.length) {
    const kept = {};
    for (const name of names) {
      const path = prefix ? `${prefix}.${name}` : name;
      kept[name] =
        required.includes(name) || keep.has(path)
          ? pruneSchema(properties[name], deref, keep, path, depth + 1)
          : {};
    }
    out.properties = kept;
    // The names the spec marks `readOnly`. Kept as a LIST rather than dropped, because the two
    // things a reader wants to know are different: the name exists (so a bodyPath onto it is not
    // wrong), and the spec says it is response-only (so landing there is not confirmation
    // either). The drift spec reports those as UNKNOWABLE.
    const readOnlyHere = names.filter((n) => readOnly.has(n));
    if (readOnlyHere.length) out["x-readonly"] = readOnlyHere;
  } else if (freeform || raw.type === "object" || !raw.type) {
    // No declared properties: a free-form map, or a schema too loose to say anything. Marked so
    // the drift spec reports UNKNOWABLE rather than inventing a verdict from an empty object.
    out["x-freeform"] = true;
  }
  if (freeform && names.length) out["x-freeform"] = true;
  return out;
}

/** Every dotted PREFIX of every `bodyPath` the action writes — the second chain `pruneSchema`
 *  recurses along. `incident.service.id` yields `incident` and `incident.service`. */
function catalogBodyPrefixes(action) {
  const keep = new Set();
  for (const f of action.fields ?? []) {
    if (f.in !== "body") continue;
    const parts = (f.bodyPath ?? f.key).split(".");
    for (let i = 1; i < parts.length; i++)
      keep.add(parts.slice(0, i).join("."));
  }
  return keep;
}

/**
 * Parameters, `$ref`s inlined, trimmed to what the drift test reads.
 *
 * A parameter also keeps its declared value set when it is a HEADER THE CATALOG PINS — and only
 * then. That is what makes a pinned header CHECKABLE rather than merely believed: Notion declares
 * `Notion-Version` as `enum: ["2026-03-11"]`, so the fixture can prove the provider-wide header we
 * send is a value the pinned document accepts. The #944 failure was sending `2022-06-28` for years
 * against a document describing a different API, with a spec-diff test in the repo that could say
 * nothing. Swagger 2 puts `enum` on the parameter, OpenAPI 3 on its schema.
 *
 * Restricted to pinned headers (rather than every header, or everything) for the same reason
 * everything else here is pruned: the fixture vendors what the drift spec READS, and it reads a
 * declared value set only to compare it with a value we send. Still capped and string-only as a
 * backstop — Notion declares 1 value, Intercom 22 (`1.0` … `2.16`), so a header listing more than
 * 64 is a vocabulary rather than a pin and goes unchecked. Which is the thing to remember about this
 * whole mechanism: a fixture carrying no `enum` means "the spec did not say", never "we agree".
 */
function pruneParameters(raw, deref, pinnedHeaders = new Set()) {
  return (
    (Array.isArray(raw) ? raw : [])
      .map((p) => deref(p))
      .filter(
        (p) => p && typeof p.name === "string" && typeof p.in === "string",
      )
      // Swagger 2's `body`/`formData` parameters ARE the request body; they are folded into a
      // `requestBody` by `swagger2RequestBody` and must not also show up as parameters, where the
      // drift spec would look for an `in:"formData"` catalog field that cannot exist.
      .filter((p) => p.in !== "body" && p.in !== "formData")
      .map((p) => {
        const values =
          p.in === "header" && pinnedHeaders.has(p.name.toLowerCase())
            ? (deref(p.schema)?.enum ?? p.enum)
            : undefined;
        const keep =
          Array.isArray(values) &&
          values.length > 0 &&
          values.length <= 64 &&
          values.every((v) => typeof v === "string");
        return {
          name: p.name,
          in: p.in,
          required: p.required === true,
          ...(keep ? { enum: values } : {}),
        };
      })
  );
}

function pruneRequestBody(raw, deref, keep) {
  const rb = deref(raw);
  if (!rb || typeof rb !== "object" || !rb.content) return undefined;
  const content = {};
  // Every declared media type is kept, INCLUDING the ones we don't send: "this operation offers
  // only `application/x-www-form-urlencoded`" is the #707 finding, and it is only visible as the
  // ABSENCE of a JSON entry.
  for (const [mediaType, entry] of Object.entries(rb.content))
    content[mediaType] = {
      schema: pruneSchema(deref(entry)?.schema, deref, keep),
    };
  return { required: rb.required === true, content };
}

/**
 * Swagger 2.0 (Slack ships one) has no `requestBody`: the payload is either a single
 * `in: "body"` parameter carrying a schema, or a set of `in: "formData"` parameters, and the
 * accepted media types live in the operation's `consumes`. Rewritten into the OpenAPI 3 shape so
 * the fixture format — and therefore the drift spec — stays single.
 */
function swagger2RequestBody(op, pathItem, root, deref, keep) {
  const params = [
    ...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []),
    ...(Array.isArray(op.parameters) ? op.parameters : []),
  ].map((p) => deref(p));
  const bodyParam = params.find((p) => p?.in === "body");
  const formParams = params.filter((p) => p?.in === "formData");
  if (!bodyParam && formParams.length === 0) return undefined;
  const consumes = Array.isArray(op.consumes)
    ? op.consumes
    : Array.isArray(root.consumes)
      ? root.consumes
      : bodyParam
        ? ["application/json"]
        : ["application/x-www-form-urlencoded"];
  const schema = bodyParam
    ? pruneSchema(bodyParam.schema, deref, keep)
    : {
        ...(formParams.some((p) => p.required === true)
          ? {
              required: formParams
                .filter((p) => p.required === true)
                .map((p) => p.name),
            }
          : {}),
        properties: Object.fromEntries(formParams.map((p) => [p.name, {}])),
      };
  const content = {};
  for (const mediaType of consumes) content[mediaType] = { schema };
  return {
    required: bodyParam ? bodyParam.required === true : false,
    content,
  };
}

let total = 0;
mkdirSync(outDir, { recursive: true });

// Optional provider filter: `pnpm refresh:openapi-fixtures notion`. Without it every fixture is
// refetched, which rewrites 13 `fetchedAt` stamps and drags any unrelated upstream drift into a PR
// about one provider — two changes in one diff, and the reviewer can't tell which was intended.
// With it, adding a provider is a one-file diff and a deliberate whole-catalog refresh is still the
// default when you want it.
const only = new Set(process.argv.slice(2));
for (const name of only)
  if (!SOURCES[name])
    throw new Error(
      `unknown provider "${name}" — SOURCES has: ${Object.keys(SOURCES).join(", ")}`,
    );

for (const [provider, { url, pathPrefix, format, external }] of Object.entries(
  SOURCES,
)) {
  if (only.size && !only.has(provider)) continue;
  const catalogEntry = INTEGRATION_CATALOG[provider];
  if (!catalogEntry) throw new Error(`no catalog provider "${provider}"`);

  // Index upstream by path SHAPE. Deliberately not by method+shape: in a split spec the path item
  // is itself a `$ref` to another file, so which methods it carries is not knowable without a
  // fetch. Candidates keep source order, so a multi-document provider (SendGrid) still resolves
  // FIRST-match-wins, and each carries its OWN document + deref so a `$ref` resolves against the
  // file it came from.
  const urls = Array.isArray(url) ? url : [url];
  const candidates = new Map();
  let firstSpec;
  for (const one of urls) {
    process.stdout.write(`${provider}: fetching ${one}\n`);
    const spec = await loadDocument(one, format).catch((e) => {
      throw new Error(`${provider}: ${e.message}`);
    });
    firstSpec ??= spec;
    const deref = makeDeref(spec);
    const isSwagger2 = typeof spec.swagger === "string";
    for (const [path, itemRaw] of Object.entries(spec.paths ?? {})) {
      const key = shape(path);
      const list = candidates.get(key) ?? [];
      list.push({ path, itemRaw, docUrl: one, spec, deref, isSwagger2 });
      candidates.set(key, list);
    }
  }

  /** The path item with its `$ref`s inlined — fetched at most once per path, and only for a path
   *  some catalog action actually names. */
  const resolveItem = async (candidate) =>
    (candidate.item ??= external
      ? await materialize(candidate.itemRaw, candidate.docUrl)
      : candidate.deref(candidate.itemRaw));

  /** The first candidate for this shape that declares this method. */
  const findOperation = async (method, shapeKey) => {
    for (const candidate of candidates.get(shapeKey) ?? []) {
      const item = await resolveItem(candidate);
      if (item?.[method]) return { ...candidate, item, method };
    }
    return undefined;
  };

  // Two catalog actions can share ONE upstream operation (a create and an "upsert" on the same
  // POST). The fixture holds one entry per operation, so the recursion set is the UNION of every
  // action's `bodyPath` prefixes — otherwise whichever action was written last would silently
  // decide how deep the other one's paths got expanded.
  const keepByOp = new Map();
  for (const action of catalogEntry.actions) {
    const key = `${action.method} ${shape(pathPrefix + action.pathTemplate)}`;
    const set = keepByOp.get(key) ?? new Set();
    for (const p of catalogBodyPrefixes(action)) set.add(p);
    keepByOp.set(key, set);
  }

  const paths = {};
  const unmatched = [];
  for (const action of catalogEntry.actions) {
    const key = `${action.method} ${shape(pathPrefix + action.pathTemplate)}`;
    const hit = await findOperation(
      action.method.toLowerCase(),
      shape(pathPrefix + action.pathTemplate),
    );
    if (!hit) {
      unmatched.push(`${action.key} (${key})`);
      continue;
    }
    const { deref, spec, isSwagger2 } = hit;
    const op = deref(hit.item[hit.method]);
    const entry = (paths[hit.path] ??= {});
    // Headers this action sends with a FIXED value, so `pruneParameters` knows which declared value
    // sets are worth vendoring — see its docblock. Lower-cased: header names are case-insensitive.
    const pinnedHeaders = new Set(
      [
        ...Object.keys(catalogEntry.headers ?? {}),
        ...Object.keys(action.headers ?? {}),
      ].map((h) => h.toLowerCase()),
    );
    // Path-level params merge into every operation; fold them in so the fixture entry is
    // self-contained and `parseOpenApi`'s own merge stays a no-op.
    const parameters = [
      ...pruneParameters(hit.item.parameters, deref, pinnedHeaders),
      ...pruneParameters(op.parameters, deref, pinnedHeaders),
    ];
    const keep = keepByOp.get(key) ?? catalogBodyPrefixes(action);
    const requestBody = isSwagger2
      ? swagger2RequestBody(op, hit.item, spec, deref, keep)
      : op.requestBody
        ? pruneRequestBody(op.requestBody, deref, keep)
        : undefined;
    entry[hit.method] = {
      ...(op.operationId ? { operationId: op.operationId } : {}),
      ...(parameters.length ? { parameters } : {}),
      ...(requestBody ? { requestBody } : {}),
    };
    total++;
  }
  if (unmatched.length)
    process.stdout.write(
      `  !! no upstream operation for: ${unmatched.join(", ")}\n` +
        "     (left OUT of the fixture — the drift spec will fail on it, which is the point)\n",
    );

  const fixture = {
    openapi: "3.0.3",
    info: {
      title: firstSpec?.info?.title ?? provider,
      version: String(firstSpec?.info?.version ?? "unknown"),
    },
    "x-naary": {
      provider,
      pathPrefix,
      source: urls.join(", "),
      fetchedAt: new Date().toISOString().slice(0, 10),
      note: "PRUNED snapshot — see packages/dsl/scripts/extract-openapi-fixtures.mjs. Do not hand-edit.",
    },
    paths,
  };
  const file = join(outDir, `${provider}.json`);
  writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);
  process.stdout.write(
    `  wrote ${Object.keys(paths).length} paths → ${file.split("/packages/")[1]}\n`,
  );
}

process.stdout.write(`\n${total} operations vendored.\n`);
