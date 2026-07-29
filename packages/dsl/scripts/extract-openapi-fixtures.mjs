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
    url: "https://app.posthog.com/api/schema/?format=json",
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
};

/**
 * Providers deliberately NOT vendored, and why. Kept next to SOURCES so "why isn't X here?" has an
 * answer that survives the person who checked. `docs/integrations/VERIFICATION.md` §2.5 carries the
 * same list for readers who never open this script.
 *
 *   pipedrive  — the published v1 spec no longer documents `POST /deals`, `POST /persons` or
 *                `GET/PUT /deals/{id}`; that CRUD moved to the v2 API (a different base path from
 *                the one our catalog uses). Vendoring v2 would compare our requests against
 *                endpoints we don't call.
 *   sentry     — the spec documents only the org-scoped `/api/0/organizations/{org}/issues/{id}/`;
 *                our `/api/0/issues/{id}/` is the legacy un-scoped route, which still works but is
 *                not in the published document.
 *   zendesk    — the spec is real and fetchable (developer.zendesk.com/zendesk/oas.yaml) but
 *                canonicalises paths WITHOUT the `.json` format suffix our catalog uses
 *                (`/api/v2/tickets` vs `/tickets.json`). Matching would need a path-rewrite seam
 *                in both this script and the drift spec; worth doing when a second provider needs
 *                the same seam (Shopify's paths have the suffix too).
 *   msgraph    — 38MB of YAML with external refs; deferred on cost, not on principle.
 *   digitalocean, gitlab — split across external `$ref` files, so a single fetch can't deref.
 *   notion, airtable, dropbox, todoist, calendly, webflow, zoom, mailchimp, hubspot, clickup,
 *   mattermost, shopify, googlesheets — no official machine-readable OpenAPI document found
 *                (Google Sheets publishes a Discovery document, not OpenAPI).
 *   linear, monday — GraphQL; there are no per-operation request schemas to diff.
 */

const HTTP_METHODS = ["get", "put", "post", "delete", "patch"];
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
  const { raw, required, properties, freeform } = merged;
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

/** Parameters, `$ref`s inlined, trimmed to what the drift test reads. */
function pruneParameters(raw, deref) {
  return (Array.isArray(raw) ? raw : [])
    .map((p) => deref(p))
    .filter((p) => p && typeof p.name === "string" && typeof p.in === "string")
    // Swagger 2's `body`/`formData` parameters ARE the request body; they are folded into a
    // `requestBody` by `swagger2RequestBody` and must not also show up as parameters, where the
    // drift spec would look for an `in:"formData"` catalog field that cannot exist.
    .filter((p) => p.in !== "body" && p.in !== "formData")
    .map((p) => ({ name: p.name, in: p.in, required: p.required === true }));
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

for (const [provider, { url, pathPrefix, format }] of Object.entries(SOURCES)) {
  const catalogEntry = INTEGRATION_CATALOG[provider];
  if (!catalogEntry) throw new Error(`no catalog provider "${provider}"`);

  // Index upstream by METHOD + path-shape, the same key the drift spec matches on. Each entry
  // carries its OWN spec + deref, so a multi-document provider (SendGrid) resolves each `$ref`
  // against the document it came from.
  const urls = Array.isArray(url) ? url : [url];
  const index = new Map();
  let firstSpec;
  for (const one of urls) {
    process.stdout.write(`${provider}: fetching ${one}\n`);
    const res = await fetch(one);
    if (!res.ok)
      throw new Error(`${provider}: ${res.status} ${res.statusText} — ${one}`);
    // `yaml` is a devDependency of this package and is imported LAZILY, so a JSON-only refresh
    // still runs if it isn't installed — and nothing here is reachable from `dist/`, which is
    // what apps/web bundles.
    const isYaml = (format ?? (/\.ya?ml($|\?)/.test(one) ? "yaml" : "json")) === "yaml";
    const spec = isYaml
      ? (await import("yaml")).parse(await res.text())
      : await res.json();
    firstSpec ??= spec;
    const deref = makeDeref(spec);
    const isSwagger2 = typeof spec.swagger === "string";
    for (const [path, itemRaw] of Object.entries(spec.paths ?? {})) {
      const item = deref(itemRaw);
      for (const method of HTTP_METHODS) {
        const key = `${method.toUpperCase()} ${shape(path)}`;
        if (item?.[method] && !index.has(key))
          index.set(key, { path, method, item, spec, deref, isSwagger2 });
      }
    }
  }

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
    const hit = index.get(key);
    if (!hit) {
      unmatched.push(`${action.key} (${key})`);
      continue;
    }
    const { deref, spec, isSwagger2 } = hit;
    const op = deref(hit.item[hit.method]);
    const entry = (paths[hit.path] ??= {});
    // Path-level params merge into every operation; fold them in so the fixture entry is
    // self-contained and `parseOpenApi`'s own merge stays a no-op.
    const parameters = [
      ...pruneParameters(hit.item.parameters, deref),
      ...pruneParameters(op.parameters, deref),
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
