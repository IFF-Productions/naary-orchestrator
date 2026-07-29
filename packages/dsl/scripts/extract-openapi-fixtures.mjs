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
 *   - request-body schemas are PRUNED along `required` chains: a required property keeps its own
 *     `required`/`properties`, a non-required one collapses to `{}` so only its NAME survives.
 *     Bounded by construction, and it keeps exactly the fact the test needs (which fields upstream
 *     insists on) without the descriptions/examples/enums that make specs enormous.
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
 * un-match every path. Providers whose spec is YAML-only, unofficial, or GraphQL are deliberately
 * out — a bad fixture is worse than no fixture.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "test", "fixtures", "openapi");

/** provider key (must exist in INTEGRATION_CATALOG) → where its spec lives. */
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
};

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
 * Keep a schema's `required` list and its property NAMES, recursing only into required
 * properties. `allOf` branches are merged. Depth-capped so a self-referential schema (PagerDuty
 * has several) can't run away.
 */
function pruneSchema(schema, deref, depth = 0) {
  const s = deref(schema);
  if (!s || typeof s !== "object" || depth > 4) return {};
  const branches = Array.isArray(s.allOf) ? s.allOf.map((b) => deref(b)) : [s];
  const required = [];
  const properties = {};
  for (const b of branches) {
    if (!b || typeof b !== "object") continue;
    for (const r of Array.isArray(b.required) ? b.required : [])
      if (typeof r === "string" && !required.includes(r)) required.push(r);
    for (const name of Object.keys(b.properties ?? {}))
      properties[name] ??= b.properties[name];
  }
  const out = {};
  if (required.length) out.required = required;
  const kept = {};
  for (const [name, sub] of Object.entries(properties))
    kept[name] = required.includes(name)
      ? pruneSchema(sub, deref, depth + 1)
      : {};
  if (Object.keys(kept).length) out.properties = kept;
  return out;
}

/** Parameters, `$ref`s inlined, trimmed to what the drift test reads. */
function pruneParameters(raw, deref) {
  return (Array.isArray(raw) ? raw : [])
    .map((p) => deref(p))
    .filter((p) => p && typeof p.name === "string" && typeof p.in === "string")
    .map((p) => ({ name: p.name, in: p.in, required: p.required === true }));
}

function pruneRequestBody(raw, deref) {
  const rb = deref(raw);
  if (!rb || typeof rb !== "object" || !rb.content) return undefined;
  const content = {};
  for (const [mediaType, entry] of Object.entries(rb.content))
    content[mediaType] = { schema: pruneSchema(deref(entry)?.schema, deref) };
  return { required: rb.required === true, content };
}

let total = 0;
mkdirSync(outDir, { recursive: true });

for (const [provider, { url, pathPrefix }] of Object.entries(SOURCES)) {
  const catalogEntry = INTEGRATION_CATALOG[provider];
  if (!catalogEntry) throw new Error(`no catalog provider "${provider}"`);

  process.stdout.write(`${provider}: fetching ${url}\n`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${provider}: ${res.status} ${res.statusText}`);
  const spec = await res.json();
  const deref = makeDeref(spec);

  // Index upstream by METHOD + path-shape, the same key the drift spec matches on.
  const index = new Map();
  for (const [path, itemRaw] of Object.entries(spec.paths ?? {})) {
    const item = deref(itemRaw);
    for (const method of HTTP_METHODS)
      if (item?.[method])
        index.set(`${method.toUpperCase()} ${shape(path)}`, {
          path,
          method,
          item,
        });
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
    const op = deref(hit.item[hit.method]);
    const entry = (paths[hit.path] ??= {});
    // Path-level params merge into every operation; fold them in so the fixture entry is
    // self-contained and `parseOpenApi`'s own merge stays a no-op.
    const parameters = [
      ...pruneParameters(hit.item.parameters, deref),
      ...pruneParameters(op.parameters, deref),
    ];
    entry[hit.method] = {
      ...(op.operationId ? { operationId: op.operationId } : {}),
      ...(parameters.length ? { parameters } : {}),
      ...(op.requestBody
        ? { requestBody: pruneRequestBody(op.requestBody, deref) }
        : {}),
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
      title: spec.info?.title ?? provider,
      version: String(spec.info?.version ?? "unknown"),
    },
    "x-naary": {
      provider,
      pathPrefix,
      source: url,
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
