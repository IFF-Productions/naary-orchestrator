#!/usr/bin/env node
/**
 * Refreshes the pinned GraphQL SCHEMA snapshots in `packages/dsl/test/fixtures/graphql/`, which
 * `integration-catalog-graphql.drift.spec.ts` diffs the hand-written catalog's GraphQL documents
 * against (#943).
 *
 * ## Why this exists at all
 *
 * `linear` and `monday` are the two catalog providers whose every request body is
 * `{query, variables}`. That body is correct BY CONSTRUCTION, so the OpenAPI drift spec can never
 * say anything useful about them — §2.5 of `docs/integrations/VERIFICATION.md` said so, in those
 * words, and listed them as permanently unverifiable. All of the risk lives INSIDE the query
 * string: a renamed mutation, a changed input type, an argument that became required. A schema
 * change there surfaces as a runtime GraphQL error with no build-time signal — the #707/#811 shape
 * that #813 closed for REST.
 *
 * Only a schema can answer those questions, and both vendors serve one.
 *
 * ## No credential is needed — which is the whole reason this is a pinned fixture
 *
 * #943 flagged the credentialed refresh as the main new wrinkle versus the OpenAPI path, and asked
 * whether this should instead be a `*.live.spec.ts` gated on `~/.naary-live.env`. It should not,
 * and it does not have to be:
 *
 *   - **Linear** answers a full `__schema` introspection POST at `https://api.linear.app/graphql`
 *     with NO Authorization header (verified: HTTP 200, 1130 types).
 *   - **monday** publishes the same payload as a plain GET at `https://api.monday.com/v2/get_schema`
 *     (verified: HTTP 200, 1272 types). Its `/v2` GraphQL endpoint itself 401s unauthenticated, so
 *     it is `get_schema` — not introspection against the API — that makes this credential-free.
 *
 * So this is exactly the OpenAPI story after all: a vendored snapshot refreshed by a human, in a PR,
 * as a reviewable diff. A live-gated spec would run only for whoever holds tokens, which in practice
 * means rarely, and would protect nobody by default — the same reason the OpenAPI documents are
 * pinned rather than fetched in the test (see `extract-openapi-fixtures.mjs`: a check that fails on
 * someone else's outage gets muted, and a muted check is worth nothing).
 *
 * ## Why the snapshots are PRUNED (~50KB, not the 1.3MB upstream)
 *
 * A full introspection result is ~1.3MB per provider and mostly output-object types the drift spec
 * never reads. The pruning is guided BY THE CATALOG and keeps exactly what the three checks ask:
 *
 *   - the two ROOT types (Query/Mutation), holding only the fields some catalog `query` hint names,
 *     with their full argument list (name + type ref + default) — the "does this mutation exist,
 *     with these arguments, of these types" check;
 *   - every INPUT_OBJECT/ENUM/SCALAR named directly by one of those arguments or by a hint, WITH its
 *     full `inputFields` — the "which input fields are NON_NULL without a default" check;
 *   - one level further out, NAME AND KIND ONLY, marked `x-pruned-fields`, so a nested input type
 *     can still be shown to EXIST while the spec reports its interior as unknowable rather than
 *     confirmed. "We pruned it" must never read as "the schema doesn't have it".
 *
 * Output-object types and selection sets are deliberately out of scope: #943 asks for the mutation
 * field, the variable types and the required input fields, and vendoring 600 object types to also
 * check `{ success issue { id } }` would multiply the fixture by 20 for a strictly smaller risk.
 *
 * The seeding is textual and deliberately CONSERVATIVE — a root field is kept when its name appears
 * as an identifier anywhere in that provider's `query` hints, so a few unused fields ride along.
 * Over-keeping is harmless; under-keeping is not silent, because the drift spec fails loudly on a
 * name the fixture lacks and its message names both possible causes (a wrong catalog, or a hint
 * edited since the last refresh).
 *
 * ## Refreshing
 *
 *     pnpm refresh:graphql-fixtures                    # builds @naary/dsl first, then runs this
 *     pnpm refresh:graphql-fixtures linear             # …just one provider
 *     git diff packages/dsl/test/fixtures/graphql/     # review the drift, then run the test
 *
 * Needs network, and nothing else — no token, no `~/.naary-live.env`. A non-empty diff is the
 * interesting part: it is upstream telling you the catalog may now be wrong. Re-run `pnpm test`.
 *
 * ## Adding a provider
 *
 * Add an entry to SOURCES below. The drift spec derives its provider list from the FIXTURE
 * DIRECTORY and separately asserts that every GraphQL-shaped catalog provider has a fixture, so a
 * third GraphQL provider added to the catalog fails the suite until it is pinned here.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "test", "fixtures", "graphql");

/**
 * provider key (must exist in INTEGRATION_CATALOG) → where its schema comes from.
 *
 * `method: "POST"` sends the introspection query below; `method: "GET"` fetches a URL the vendor
 * serves the same payload from. Both must answer WITHOUT credentials — a source that needs a token
 * belongs in a different design, not in a `SOURCES` entry with a comment apologising for it.
 */
const SOURCES = {
  linear: {
    method: "POST",
    url: "https://api.linear.app/graphql",
    // Linear serves introspection to anonymous callers. Its API is otherwise fully authenticated —
    // `query { viewer { id } }` 401s — so this is a deliberate choice on Linear's part, and it is
    // what lets the refresh stay credential-free. If it ever stops, the fallback is Linear's own
    // SDK repo (`linear/linear`, `packages/sdk/src/schema.graphql`), which is vendor-authored and
    // therefore still meets the bar; it would need an SDL→introspection step this script does not have.
    note: "unauthenticated __schema introspection",
  },
  monday: {
    method: "GET",
    url: "https://api.monday.com/v2/get_schema",
    // NOT the API endpoint. `POST https://api.monday.com/v2` with an introspection query answers
    // 401 `NOT_AUTHENTICATED`; this sibling path serves the identical introspection JSON to anyone.
    // Getting that backwards is the one way to conclude "monday needs a token" and build the wrong
    // thing, so it is written down rather than left to be rediscovered.
    note: "vendor-served introspection JSON, no auth (the /v2 API endpoint itself 401s)",
  },
};

/**
 * The introspection query. Full type refs (`ofType` four deep — enough for `[[Foo!]!]!`), argument
 * and input-field defaults, and enough per type to prune with. `includeDeprecated` is on so a field
 * we still call that upstream has deprecated is present rather than silently missing.
 */
const INTROSPECTION_QUERY = `query NaaryIntrospection {
  __schema {
    queryType { name }
    mutationType { name }
    types {
      kind
      name
      fields(includeDeprecated: true) {
        name
        args { name defaultValue type { ...TypeRef } }
      }
      inputFields { name defaultValue type { ...TypeRef } }
    }
  }
}
fragment TypeRef on __Type {
  kind
  name
  ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } }
}`;

const { INTEGRATION_CATALOG } = await import(
  join(here, "..", "dist", "integrations.js")
);

/** The innermost named type of a `{kind, name, ofType}` chain (`[Foo!]!` → `Foo`). */
function namedTypeOf(ref) {
  let cur = ref;
  for (let i = 0; cur && i < 8; i++) {
    if (cur.name) return cur.name;
    cur = cur.ofType;
  }
  return undefined;
}

/** A type ref with its `null` leaves dropped — same information, a third of the bytes and a diff a
 *  human can read. */
function compactRef(ref) {
  if (!ref) return undefined;
  const out = { kind: ref.kind };
  if (ref.name) out.name = ref.name;
  const inner = compactRef(ref.ofType);
  if (inner) out.ofType = inner;
  return out;
}

const compactArg = (a) => ({
  name: a.name,
  type: compactRef(a.type),
  ...(a.defaultValue == null ? {} : { defaultValue: a.defaultValue }),
});

async function fetchSchema(source) {
  const res =
    source.method === "GET"
      ? await fetch(source.url)
      : await fetch(source.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: INTROSPECTION_QUERY }),
        });
  if (!res.ok)
    throw new Error(`${res.status} ${res.statusText} — ${source.url}`);
  const body = await res.json();
  if (body.errors)
    throw new Error(
      `${source.url} answered GraphQL errors: ${JSON.stringify(body.errors).slice(0, 400)}`,
    );
  const schema = body?.data?.__schema ?? body?.__schema;
  if (!schema?.types?.length)
    throw new Error(`${source.url} returned no __schema.types`);
  return schema;
}

const only = process.argv.slice(2);
const providers = Object.keys(SOURCES).filter(
  (p) => only.length === 0 || only.includes(p),
);
if (!providers.length) {
  process.stderr.write(
    `no such GraphQL provider: ${only.join(", ")} (have: ${Object.keys(SOURCES).join(", ")})\n`,
  );
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
let totalTypes = 0;

for (const provider of providers) {
  const source = SOURCES[provider];
  const catalogEntry = INTEGRATION_CATALOG[provider];
  if (!catalogEntry)
    throw new Error(`${provider} is not in INTEGRATION_CATALOG`);
  process.stdout.write(`${provider}: ${source.method} ${source.url}\n`);

  const schema = await fetchSchema(source);
  const byName = new Map(schema.types.map((t) => [t.name, t]));

  // Every identifier appearing in any `query` hint. The seed set for pruning — over-inclusive on
  // purpose (see the docblock): `id`/`name`/`title` are in here too and simply match nothing.
  const hintWords = new Set(
    catalogEntry.actions
      .map((a) => a.fields.find((f) => f.key === "query")?.hint ?? "")
      .join(" ")
      .match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [],
  );

  const rootNames = [schema.queryType?.name, schema.mutationType?.name].filter(
    Boolean,
  );
  const rootTypes = rootNames.map((name) => {
    const t = byName.get(name);
    const fields = (t?.fields ?? []).filter((f) => hintWords.has(f.name));
    return {
      kind: "OBJECT",
      name,
      fields: fields.map((f) => ({
        name: f.name,
        args: (f.args ?? []).map(compactArg),
      })),
    };
  });

  // DETAILED: types named by a kept root field's argument, or named literally in a hint (a variable
  // declaration's type). These keep their full `inputFields`, which is what the required-input-field
  // check reads.
  const detailed = new Set();
  for (const rt of rootTypes)
    for (const f of rt.fields)
      for (const a of f.args) {
        const n = namedTypeOf(a.type);
        if (n) detailed.add(n);
      }
  for (const w of hintWords) if (byName.has(w)) detailed.add(w);
  for (const r of rootNames) detailed.delete(r);

  // NAMED ONLY: one hop further — the types a detailed input type's own fields reference. Present so
  // "does this type exist" stays answerable, absent their fields so the spec reports their interior
  // as UNKNOWABLE rather than confirming or denying it.
  const nameOnly = new Set();
  for (const n of detailed) {
    const t = byName.get(n);
    if (t?.kind !== "INPUT_OBJECT") continue;
    for (const f of t.inputFields ?? []) {
      const m = namedTypeOf(f.type);
      if (m && !detailed.has(m) && !rootNames.includes(m)) nameOnly.add(m);
    }
  }

  const types = [...rootTypes];
  for (const name of [...detailed].sort()) {
    const t = byName.get(name);
    if (!t) continue;
    types.push({
      kind: t.kind,
      name,
      ...(t.kind === "INPUT_OBJECT"
        ? {
            inputFields: (t.inputFields ?? []).map((f) => ({
              name: f.name,
              type: compactRef(f.type),
              ...(f.defaultValue == null
                ? {}
                : { defaultValue: f.defaultValue }),
            })),
          }
        : {}),
    });
  }
  for (const name of [...nameOnly].sort()) {
    const t = byName.get(name);
    if (!t) continue;
    types.push({
      kind: t.kind,
      name,
      // The marker the spec keys "unknowable" off. Only meaningful for INPUT_OBJECTs — an ENUM or
      // SCALAR at this depth has nothing the spec would have read anyway.
      ...(t.kind === "INPUT_OBJECT" ? { "x-pruned-fields": true } : {}),
    });
  }

  const fixture = {
    "x-naary": {
      provider,
      source: `${source.method} ${source.url}`,
      auth: "none",
      note:
        `PRUNED introspection snapshot (${source.note}) — see ` +
        "packages/dsl/scripts/extract-graphql-schema-fixtures.mjs. Do not hand-edit.",
      fetchedAt: new Date().toISOString().slice(0, 10),
      upstreamTypes: schema.types.length,
    },
    // Introspection-response shape on purpose: `parseIntrospection` (src/introspection.ts) reads it
    // directly, so the drift spec reuses the repo's own parser instead of growing a second one.
    __schema: {
      queryType: schema.queryType ? { name: schema.queryType.name } : null,
      mutationType: schema.mutationType
        ? { name: schema.mutationType.name }
        : null,
      types,
    },
  };
  const file = join(outDir, `${provider}.json`);
  writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);
  totalTypes += types.length;
  process.stdout.write(
    `  wrote ${types.length} types (of ${schema.types.length} upstream), ` +
      `${rootTypes.map((t) => `${t.name}:${t.fields.length}`).join(" ")} → ` +
      `${file.split("/packages/")[1]}\n`,
  );
}

process.stdout.write(`\n${totalTypes} types vendored.\n`);
