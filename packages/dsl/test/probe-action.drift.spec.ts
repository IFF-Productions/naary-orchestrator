import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  INTEGRATION_CATALOG,
  type IntegrationAction,
  type IntegrationField,
} from "../src/integrations";
import { pickConnectionTestAction } from "../src/integration-request";
import {
  ACKNOWLEDGED_DEPRECATED,
  UNSPECIFIED,
} from "./openapi-drift-adjudications";

/**
 * Every provider's CREDENTIAL PROBE, checked for being a call the provider's own connections can
 * actually make (#1111, #1109).
 *
 * ## What went wrong, and why nothing said so
 *
 * `webflow`'s probe was `get_authorized_by` — "which OAuth app authorized this token?", a question a
 * Webflow **Site Token** has no answer to, because Webflow's site-token page says site tokens "don't
 * grant access to the following endpoints: Authorization endpoints, Custom code endpoints, Workspace
 * Activity log endpoints". So a Site Token connection failed its own **Test connection** while every
 * Webflow action in the catalog ran fine for it. That is precisely inverted from what a credential
 * check is for: the user is told a working credential is broken, which is worse than not checking.
 *
 * Three more probes are on endpoints their vendor no longer publishes (#1109): `pipedrive`'s
 * `list_deals` (out of support since 1 Aug 2026, #945), `shopify`'s `list_products` (named in
 * Shopify's own product-deprecation banner) and `vercel`'s `list_projects` (`/v9/projects`, absent
 * from Vercel's document and its docs index). A provider whose probe dies does not lose one action —
 * it loses the ability to say whether the credential works at all.
 *
 * Nothing in the repo asked any of these questions. `pickConnectionTestAction` gates a probe on
 * `write: false` + `GET` + no user-supplied required field, and the drift spec checks every action
 * against the vendor's document — but neither knows which action IS the probe, so a probe could be
 * declared on something the gate silently discards, or land on the one operation of a provider its
 * credentials cannot reach.
 *
 * ## The shape of the checks
 *
 * HARD, and unambiguous:
 *   1. every `probe` DECLARATION passes the safety gate — asserted against the raw catalog, not
 *      against `pickConnectionTestAction`'s answer. The resolver drops a bad declaration silently
 *      (its docblock: "declaring `probe` on a write is inert, not dangerous"), which is the right
 *      runtime behaviour and the wrong test: a probe declared on a write would resolve to some other
 *      action and this file would go green while the catalog said something false.
 *   2. the RESOLVED probe is a real action of that provider and passes the same gate.
 *   3. where the provider has a pinned spec, the probe's operation is IN it, is not flagged
 *      `deprecated`, and is not restricted to security schemes narrower than the ones the provider's
 *      OTHER shipped actions require — the generalisation of #1111: a probe whose credential
 *      requirements exceed those of the actions it vouches for will reject working connections.
 *   4. every probe with NO pinned spec is written down in `PROBE_NOT_SPEC_CHECKED`, with why and
 *      the issue that owns it. Otherwise check 3's coverage is invisible and "green" reads as
 *      "checked" for the four providers where it means "we can't look".
 *
 * ## What this deliberately does NOT do
 *
 * It does not read a probe's OAuth SCOPES and compare them with the other actions'. That rule reds
 * the correct fix: `list_sites` needs `sites:read`, which no other Webflow action requires, so a
 * scope-subset rule would fail the very change that fixes #1111 — and a guard that fails the right
 * answer is the check people learn to re-run without reading.
 *
 * It also cannot adjudicate #1111 itself, and saying so is the point. **Webflow declares
 * `security: [{OAuth2: […]}]` on 112 of its 117 operations**, including the CMS reads a Site Token
 * demonstrably performs — so at scheme level `get_authorized_by` looks exactly like its siblings and
 * check 3 is silent for all of them. #1109's reading (that it is "the one operation that overrides
 * the global scheme to OAuth2-only") does not hold against the currently pinned document. The
 * evidence for that fix is the vendor's own prose, which is what `docs/integrations/VERIFICATION.md`
 * §2.5 rule 2 asks for; the spec is evidence, not proof.
 */

const FIXTURE_DIR = join(__dirname, "fixtures", "openapi");

/** `/repos/{owner}/{repo}` → `/repos/{}/{}` — placeholder names are ours to pick. */
const shape = (path: string): string => path.replace(/\{[^}]*\}/g, "{}");

/** A field the user must supply: required, and not injected by the catalog as a `const`. The same
 *  rule `pickConnectionTestAction` gates on — restated rather than exported, so a change there that
 *  loosens the gate shows up here as a disagreement instead of being adopted silently. */
const needsUser = (f: IntegrationField): boolean =>
  f.required && f.const === undefined;

/** Why this action cannot be a credential probe, or `null` when it can. */
function gateFailure(action: IntegrationAction): string | null {
  if (action.write)
    return `it is write:true — a credential check must not be able to change anything`;
  if (action.method !== "GET")
    return `its method is ${action.method}, and the check only ever issues a GET`;
  const need = action.fields.filter(needsUser).map((f) => f.key);
  if (need.length)
    return `it requires ${need.join(", ")} — there is nobody to ask when the check runs`;
  return null;
}

interface Fixture {
  provider: string;
  pathPrefix: string;
  /** `"GET /users/{}"` → the vendored operation entry. */
  operations: Map<string, Record<string, unknown>>;
}

function loadFixtures(): Map<string, Fixture> {
  const out = new Map<string, Fixture>();
  for (const file of readdirSync(FIXTURE_DIR).filter((f) =>
    f.endsWith(".json"),
  )) {
    const raw = JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8")) as {
      "x-naary"?: { provider?: string; pathPrefix?: string };
      paths?: Record<string, Record<string, Record<string, unknown>>>;
    };
    const provider = raw["x-naary"]?.provider ?? file.replace(/\.json$/, "");
    const operations = new Map<string, Record<string, unknown>>();
    for (const [path, item] of Object.entries(raw.paths ?? {}))
      for (const [method, op] of Object.entries(item))
        operations.set(`${method.toUpperCase()} ${shape(path)}`, op);
    out.set(provider, {
      provider,
      pathPrefix: raw["x-naary"]?.pathPrefix ?? "",
      operations,
    });
  }
  return out;
}

const fixtures = loadFixtures();

/**
 * The security schemes an operation accepts, as the fixture RESOLVED them (operation level, else the
 * document default — see `securitySchemeNames` in the extractor). Three answers, and the difference
 * between the last two is the whole point:
 *
 *   `["A","B"]` — it accepts these.
 *   `[]`        — declared and empty: explicitly public, no credential required.
 *   `null`      — the document was silent at BOTH levels. UNKNOWN, never "unrestricted".
 */
const schemesOf = (
  op: Record<string, unknown> | undefined,
): string[] | null => {
  const raw = op?.["x-security"];
  return Array.isArray(raw) ? raw.map(String) : null;
};

/**
 * Is the probe restricted to a NARROWER set of schemes than an action it vouches for?
 *
 * Returns the offending scheme names — a credential that satisfies `action` and not `probe` would
 * be reported broken while working. Compared per (probe, action) pair so the failure message can
 * name which action disagrees.
 *
 * ## Absent is UNKNOWN here, never "unrestricted"
 *
 * The first version of this returned `[]` the moment the probe had no `x-security`, on the reasoning
 * that an operation declaring nothing "inherits the default, and nothing is narrower than that".
 * That is not the OpenAPI rule: an omitted operation-level `security` inherits the DOCUMENT default,
 * which can be *more* restrictive than what a sibling declares for itself — so the silence could hide
 * exactly the #1111 shape this function exists to find. The fix is upstream, in the extractor, which
 * now resolves that fallback and records the effective schemes; `null` here therefore means the
 * document was silent at BOTH levels, which is genuinely unknowable and is reported as nothing
 * rather than as agreement.
 */
function narrowerThan(
  probe: Record<string, unknown> | undefined,
  action: Record<string, unknown> | undefined,
): string[] {
  const probeSchemes = schemesOf(probe);
  const actionSchemes = schemesOf(action);
  // The document says nothing about one side or the other. No verdict is available — and a check
  // that cannot see must say nothing rather than say "fine". The coverage line below is where that
  // gap is made visible instead.
  if (probeSchemes === null || actionSchemes === null) return [];
  // The ACTION needs no credential at all (`security: []`). That is not evidence about credentials,
  // so a probe requiring one is not "narrower" than it in any sense a user would feel.
  if (actionSchemes.length === 0) return [];
  return actionSchemes.filter((s) => !probeSchemes.includes(s));
}

/**
 * Probes with NO pinned OpenAPI document, and therefore no answer to "does this endpoint still
 * exist?". Each entry is a claim that we know, and what would settle it.
 *
 * This list is the honest half of check 3: without it, seven providers pass by being unexaminable,
 * and a green run would read as "31 probes verified" when it means 24. Asserted in BOTH directions
 * below — adding a `SOURCES` entry for one of these makes its line here fail, which is exactly the
 * moment somebody should delete it.
 */
const PROBE_NOT_SPEC_CHECKED: { provider: string; why: string }[] = [
  {
    provider: "pipedrive",
    why:
      "BLOCKED, not unchecked. `list_deals` → `GET /v1/deals` is out of support since 1 Aug 2026 " +
      "and gone from Pipedrive's own published v1 document (#945), so this provider's probe dies " +
      "with the rest of its v1 CRUD. Moving to v2 is a breaking change — different base path, " +
      "`PATCH` for `PUT`, `{id}`, and an unknown output-shape delta that saved workflows bind to — " +
      "so it is #945's decision to make, not a chore to slip into a guard PR. No fixture because " +
      "vendoring v2 would diff our requests against endpoints we do not call.",
  },
  {
    provider: "shopify",
    why:
      "BLOCKED. `list_products` → `GET /products.json` is named in Shopify's own product-" +
      "deprecation banner (#1109 finding 1). Shopify publishes NO machine-readable REST document " +
      "at all — the REST Admin API is legacy and only the GraphQL schema is published — so there " +
      "is nothing to pin either way. Repointing the probe at another endpoint is a catalog change " +
      "with #945's output-shape risk; it needs the same decision Pipedrive does.",
  },
  {
    provider: "vercel",
    why:
      "BLOCKED. `list_projects` → `GET /v9/projects` is absent from Vercel's own document and its " +
      "docs index; the published route is `GET /v10/projects` (#1109 finding 2). It answers today " +
      "(403 missingToken, where a nonsense path 404s), and Vercel publishes no versioning or " +
      "deprecation policy at all, so 'still works' carries no promise. Bumping the version changes " +
      "the response body authors bind to — #945 §4 again. No fixture: `openapi.vercel.sh` is " +
      "fetchable and would be a legitimate SOURCES entry, which is what should happen when the " +
      "version question is settled rather than before.",
  },
  {
    provider: "airtable",
    why:
      "No fetchable document. Airtable's spec is real and vendor-authored but exists only EMBEDDED " +
      "in its docs page's SSR state (an `openApi` key in the page JSON); scraping HTML would put a " +
      "third party's page structure in the refresh path. `whoami` (`GET /v0/meta/whoami`) was " +
      "checked live when it landed (#835) and Airtable's deprecation-guidelines page says 'No " +
      "upcoming deprecations at this time' (#1109).",
  },
  {
    provider: "netlify",
    why:
      "Netlify's `swagger.yml` (netlify/open-api) IS vendor-authored and fetchable — this provider " +
      "is a candidate for SOURCES rather than a blocked one. `list_sites` was confirmed present in " +
      "that document by the #1109 audit (4/4 actions), just not pinned here.",
  },
  {
    provider: "zendesk",
    why:
      "Spec exists (developer.zendesk.com/zendesk/oas.yaml) but canonicalises paths WITHOUT the " +
      "`.json` suffix our catalog uses, so matching needs a path-rewrite seam this repo decided not " +
      "to build for three actions (#813, restated in VERIFICATION.md §2.5). `list_tickets` was " +
      "confirmed present in that document by the #1109 audit.",
  },
  {
    provider: "deepl",
    why:
      "DeepL publishes an OpenAPI document and #1109 read it: `get_usage` (`/v2/usage`) carries no " +
      "deprecation, while `/v2/languages` — an action, not the probe — is flagged `deprecated: " +
      "true`. Another SOURCES candidate rather than a blocked provider; pinning it would bring this " +
      "probe under check 3 and the languages action under the deprecation check.",
  },
];

/** Every provider whose connection can be probed at all, with the action the route would call. */
const probes = Object.entries(INTEGRATION_CATALOG).flatMap(
  ([provider, entry]) => {
    const picked = pickConnectionTestAction(provider);
    if (picked.kind !== "read") return [];
    const action = entry.actions.find((a) => a.key === picked.action);
    return [{ provider, key: `${provider}.${picked.action}`, action }];
  },
);

/** Every `probe` DECLARATION in the catalog — including ones the resolver would discard. */
const declarations = Object.entries(INTEGRATION_CATALOG).flatMap(
  ([provider, entry]) =>
    entry.actions
      .filter((a) => a.probe)
      .map((action) => ({
        provider,
        key: `${provider}.${action.key}`,
        action,
      })),
);

describe("credential probes (#1111)", () => {
  it("finds probes at all — an empty survey must fail, not pass", () => {
    // Non-vacuity floor. `pickConnectionTestAction` returning `unknown` for everything (a resolver
    // regression, or a catalog that failed to load) would otherwise make every assertion below
    // trivially true, and this file would report a broken product as healthy.
    expect(probes.length).toBeGreaterThan(20);
    expect(declarations.length).toBeGreaterThan(10);
  });

  it.each(declarations)(
    "$key is declared as a probe and can actually be one",
    ({ action }) => {
      // Check 1 — against the raw declaration. See the docblock: the resolver drops a bad one
      // silently, so asking IT would pass while the catalog said something false.
      expect(
        gateFailure(action),
        `${action.key} carries \`probe\`, but the connection check can never call it`,
      ).toBeNull();
      if (typeof action.probe === "object")
        expect(
          action.probe.authModes.length,
          `${action.key} declares \`probe.authModes: []\` — a probe for no connection type is a probe for nothing`,
        ).toBeGreaterThan(0);
    },
  );

  it.each(probes)("$key resolves to a real, safe action", ({ action, key }) => {
    // Check 2. `pickConnectionTestAction` names an action key; that key must exist on the provider
    // it was resolved for, and must still pass the gate when read from the catalog directly.
    expect(action, `${key}: no such action on that provider`).toBeDefined();
    if (action) expect(gateFailure(action), key).toBeNull();
  });

  it.each(probes.filter((p) => fixtures.has(p.provider)))(
    "$key is an operation the vendor still publishes",
    ({ provider, key, action }) => {
      // Check 3a. The pipedrive/shopify/vercel failure mode — a probe on an endpoint the vendor
      // dropped — for the providers where a pinned document can answer.
      const excused = UNSPECIFIED.find((u) => u.action === key);
      if (excused || !action) return; // documented as absent upstream, with live 401-vs-404 evidence
      const fixture = fixtures.get(provider);
      const lookup = `GET ${shape((fixture?.pathPrefix ?? "") + action.pathTemplate)}`;
      expect(
        fixture?.operations.has(lookup),
        `${key}: ${lookup} is in no operation of the pinned spec. A provider whose probe is gone ` +
          "does not lose one action — it loses the ability to say whether the credential works at " +
          "all. Either upstream moved it (fix the catalog and pick another probe), the fixture is " +
          "stale (`pnpm refresh:openapi-fixtures`), or it genuinely is not in the published " +
          "document (add it to UNSPECIFIED with live 401-vs-404 evidence).",
      ).toBe(true);
    },
  );

  it.each(probes.filter((p) => fixtures.has(p.provider)))(
    "$key is not an operation the vendor deprecated",
    ({ provider, key, action }) => {
      // Check 3b. Same flag the catalog-wide check reads (#1109) — asserted separately here because
      // a deprecated PROBE is the worse case: it takes credential verification with it.
      if (!action || ACKNOWLEDGED_DEPRECATED.some((a) => a.action === key))
        return;
      const fixture = fixtures.get(provider);
      const op = fixture?.operations.get(
        `GET ${shape((fixture?.pathPrefix ?? "") + action.pathTemplate)}`,
      );
      expect(op?.deprecated, `${key} is flagged deprecated upstream`).not.toBe(
        true,
      );
    },
  );

  it.each(probes.filter((p) => fixtures.has(p.provider)))(
    "$key is no more auth-restricted than the actions it vouches for",
    ({ provider, key, action }) => {
      // Check 3c — the #1111 class, generalised: a probe that demands credentials the provider's
      // own actions do not is a probe that rejects working connections.
      if (!action) return;
      const fixture = fixtures.get(provider);
      const at = (a: IntegrationAction) =>
        fixture?.operations.get(
          `${a.method} ${shape((fixture?.pathPrefix ?? "") + a.pathTemplate)}`,
        );
      const probeOp = at(action);
      if (!probeOp) return; // absence is check 3a's finding, not this one's
      const problems = INTEGRATION_CATALOG[provider].actions
        .filter((a) => a.key !== action.key && at(a))
        .flatMap((a) => {
          const missing = narrowerThan(probeOp, at(a));
          return missing.length
            ? [
                `${a.key} accepts {${missing.join(", ")}} and the probe does not — a connection ` +
                  `that can run ${a.key} would be reported broken`,
              ]
            : [];
        });
      expect(problems, key).toEqual([]);
    },
  );

  it("writes down every probe a spec cannot check — and nothing else", () => {
    // Check 4, both directions. Left: a probe with no pinned document must be adjudicated. Right:
    // an adjudication for a provider that HAS one is a note somebody forgot to delete, and it would
    // quietly excuse a real finding the day that provider's probe breaks.
    const unchecked = probes
      .filter((p) => !fixtures.has(p.provider))
      .map((p) => p.provider)
      .sort();
    const written = PROBE_NOT_SPEC_CHECKED.map((p) => p.provider).sort();
    expect(
      unchecked,
      "a probe with no pinned spec is unexaminable, and silence about that reads as coverage. " +
        "Add it to PROBE_NOT_SPEC_CHECKED with why, and the issue that owns it.",
    ).toEqual(written);
    for (const { provider } of PROBE_NOT_SPEC_CHECKED)
      expect(
        fixtures.has(provider),
        `${provider} now HAS a pinned spec — delete its PROBE_NOT_SPEC_CHECKED entry so check 3 ` +
          "starts being the thing that answers for it.",
      ).toBe(false);
  });

  it("reports how many probes a spec can actually vouch for", () => {
    // Printed, not asserted — the same honesty the #813 coverage line buys: "no failures" is not
    // "all verified", and VERIFICATION.md §2.4 quotes these numbers.
    const withSpec = probes.filter((p) => fixtures.has(p.provider));
    const excused = withSpec.filter((p) =>
      UNSPECIFIED.some((u) => u.action === p.key),
    );
    process.stderr.write(
      `\n#1111 credential probes — ${probes.length} probeable provider(s):\n` +
        `    ${withSpec.length - excused.length} checked against a pinned vendor document\n` +
        `    ${excused.length} excused as UNSPECIFIED (a documented \`me\` sentinel, live-verified): ` +
        `${excused.map((p) => p.key).join(", ")}\n` +
        `    ${probes.length - withSpec.length} with no pinned document at all: ` +
        `${PROBE_NOT_SPEC_CHECKED.map((p) => p.provider).join(", ")}\n\n`,
    );
    expect(withSpec.length).toBeGreaterThan(0);
  });
});

/**
 * The scheme-narrowing classifier, on hand-built operations.
 *
 * Necessary for the reason the drift spec's `resolveBodyPath` suite is: against today's fixtures
 * check 3c produces NOTHING — no pinned provider restricts its probe more tightly than its actions —
 * and a check that has never been seen to fire is a comment, not a test. These pin both directions
 * and the silence, so "0 problems" reads as "compared, and they agree".
 */
describe("narrowerThan — the auth-mode comparison", () => {
  it("flags a probe that accepts fewer schemes than an action", () => {
    // The #1111 shape as a spec CAN express it: the action takes an API key or OAuth, the probe
    // takes only OAuth, so an api_token connection runs the action and fails the check.
    expect(
      narrowerThan(
        { "x-security": ["OAuth2"] },
        { "x-security": ["ApiKey", "OAuth2"] },
      ),
    ).toEqual(["ApiKey"]);
  });

  it("is silent when both accept the same schemes", () => {
    // Webflow today: `security: [{OAuth2: […]}]` on the probe AND on every action.
    expect(
      narrowerThan({ "x-security": ["OAuth2"] }, { "x-security": ["OAuth2"] }),
    ).toEqual([]);
  });

  it("is silent when the probe accepts MORE than the action", () => {
    // Discord: `get_my_user` takes a bot token or OAuth, the rest take only a bot token. Wider is
    // never a problem — every credential that runs an action can still run the probe.
    expect(
      narrowerThan(
        { "x-security": ["BotToken", "OAuth2"] },
        { "x-security": ["BotToken"] },
      ),
    ).toEqual([]);
  });

  // The three tests below pin ABSENCE, and they are the ones the first version of this file got
  // wrong. `x-security` is now RESOLVED by the extractor (operation level, else the document
  // default), so a missing key means the document was silent at both levels — unknown, not public.
  // A verdict invented from that silence is how a probe restricted by the document default would
  // have passed while rejecting working connections.
  it("says nothing when the document is silent about the probe", () => {
    expect(narrowerThan({}, { "x-security": ["OAuth2"] })).toEqual([]);
  });

  it("says nothing when the document is silent about the action", () => {
    // Previously reported "(the document default)" — a finding manufactured out of not knowing.
    expect(narrowerThan({ "x-security": ["OAuth2"] }, {})).toEqual([]);
  });

  it("says nothing when the ACTION is explicitly public", () => {
    // `security: []` on the action: it needs no credential at all, so it is no evidence about one.
    // Distinct from absence — which is why the extractor must keep the empty array rather than
    // dropping it.
    expect(
      narrowerThan({ "x-security": ["OAuth2"] }, { "x-security": [] }),
    ).toEqual([]);
  });

  it("still flags a narrower probe when the ACTION inherits a wider document default", () => {
    // The case the old "absent ⇒ unrestricted" branch could not see, now visible because the
    // extractor resolves the fallback: the action's `["ApiKey","OAuth2"]` here IS the document
    // default, copied down at extraction time.
    expect(
      narrowerThan(
        { "x-security": ["OAuth2"] },
        { "x-security": ["ApiKey", "OAuth2"] },
      ),
    ).toEqual(["ApiKey"]);
  });
});
