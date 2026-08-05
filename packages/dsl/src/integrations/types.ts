/**
 * The SHAPE of a catalog entry: provider → action → field, plus the `RetiredField` note the
 * save gate hands an author whose config still names a key that moved.
 *
 * Its own file so everything that needs only the shape — the request builder, the save gate,
 * `../docs/render`, `../integration-request` — can have it without importing a single provider.
 * Types are erased at compile time, so this module costs nothing at runtime; `./catalog` is the
 * one that pulls the ~161KB of data.
 *
 * Mind the two `types` modules from in here: `./types` is THIS file (the catalog's shapes),
 * `../types` is the DSL's node/graph types, where `IntegrationNodeConfig` lives.
 */

/** `header` = a per-REQUEST header whose wire name IS the field key (mirroring how `query`
 *  uses the key as the param name) — for APIs that require a caller-supplied header on a
 *  write, e.g. PagerDuty's `From: user@company.com`. It NEVER carries auth: auth is resolved
 *  in-activity and is merged AFTER built headers, so a header field can't clobber it. */
export type FieldLocation = "path" | "query" | "body" | "header";
/** `json` = a raw JSON value (object/array) for schema-driven payloads that a flat field can't
 *  express, e.g. Notion's `properties` or an Airtable record's `fields`. */
export type FieldType = "string" | "number" | "boolean" | "string[]" | "json";

export interface IntegrationField {
  key: string;
  label: string;
  /** Where the value goes: a `{placeholder}` in the path, a query param, a request header,
   *  or the JSON body. */
  in: FieldLocation;
  required: boolean;
  type?: FieldType;
  /**
   * A FIXED value the catalog supplies — the user never sees or sets it, and any configured
   * value is ignored. For APIs whose payload carries constant type discriminators, e.g.
   * PagerDuty's `incident.type: "incident"` / `service.type: "service_reference"`. A const
   * field is always "supplied", so the save-gate never asks for it.
   */
  const?: string | number | boolean;
  /** For `in: "body"` only — the dotted path where this value lands in the JSON body
   *  (default: the field key at the top level). Lets a flat field feed a NESTED payload,
   *  e.g. Jira's `fields.project.key`. */
  bodyPath?: string;
  /** Short help shown under the field in the config panel + docs. */
  hint?: string;
  /** Body fields only: keep the value in the payload even when it's an empty string — for APIs where
   *  `""` is meaningful (e.g. Dropbox's root folder `path: ""`). Off by default, so an empty optional
   *  field is dropped as usual. */
  keepEmpty?: boolean;
}

export interface IntegrationAction {
  key: string;
  label: string;
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** e.g. "/repos/{owner}/{repo}/issues" — every `{placeholder}` MUST be an `in:"path"` field. */
  pathTemplate: string;
  /** A side-effecting write: routed AT-MOST-ONCE (no retry) so a lost response can't
   *  duplicate the create/update (design §4). Reads are retryable. */
  write: boolean;
  fields: IntegrationField[];
  /**
   * How the body is serialized. Default `"json"`, which is what every provider added before #707
   * assumed — so an existing entry without this field is unchanged.
   *
   * `"form"` sends `application/x-www-form-urlencoded`. Required, not cosmetic, for APIs that
   * accept ONLY that: Twilio and Stripe both reject a JSON body outright, so their write actions
   * failed 100% of the time until this existed (#707). The catalog previously had no way to say
   * this, which is why they shipped broken.
   *
   * A form body is FLAT by nature. `bodyPath` nesting can't be expressed, so the planner throws
   * rather than guessing — see formEncodeBody.
   */
  bodyEncoding?: "json" | "form";
  /** Per-action request headers (non-secret), merged OVER the provider's static headers —
   *  e.g. GitHub's `Accept: application/vnd.github.diff` to fetch a PR as a unified diff
   *  instead of JSON. Never carries auth (that's resolved in-activity). */
  headers?: Record<string, string>;
  /**
   * Declares this action as the provider's CREDENTIAL PROBE — the call "Test connection" and the
   * dry run make to ask "is this token alive?" (#835).
   *
   * It NARROWS the choice, never widens it: `pickConnectionTestAction` still applies the same hard
   * gate to a declared probe as to any other candidate (`write: false`, `GET`, no user-supplied
   * required field), so declaring `probe` on a write is inert, not dangerous. What it buys is
   *
   *   1. PINNING — without it the pick is "fewest fields, catalog order wins", so adding an
   *      unrelated zero-argument list action later would silently move the probe.
   *   2. AUTH-MODE VARIANTS — `authModes` restricts a probe to connections of that kind. GitHub is
   *      the reason this exists and it is not hypothetical: verified live, `GET /user` answers 200
   *      to a PAT and **403** to a GitHub App installation token, while `GET
   *      /installation/repositories` answers 200 to the App token and 403 to the PAT. One probe for
   *      both would report a perfectly good connection as broken — worse than not probing at all.
   *
   * A probe with `authModes` is preferred for a matching connection; `probe: true` is the fallback
   * for every other (and for a caller that doesn't know the auth mode, e.g. the UI asking "is this
   * provider testable at all?").
   */
  probe?: true | { authModes: string[] };
  /**
   * Field keys this action USED to take (#944). Purely for the save gate's error message.
   *
   * A field key is what a workflow author binds to, so renaming one breaks every saved node that
   * configured it — and the generic `missing required field 'dataSourceId'` is the worst possible
   * way to say so: it names a field the author has never seen and stays silent about the value
   * they did fill in. An entry here turns that into a sentence explaining what moved and what to
   * do, which is the whole reason a rename is allowed to happen at all.
   *
   * Reported only while the replacement is still unsupplied, so a node someone has already
   * migrated does not keep failing over a leftover key that the request builder ignores anyway.
   */
  retiredFields?: RetiredField[];
  /**
   * Send `{}` rather than NO body when every body field is empty.
   *
   * A body-bearing action whose fields are all optional builds `body: undefined`, so the request
   * goes out with no payload at all. That is fine where the provider treats the body as optional,
   * and a 400 where its spec says `requestBody.required: true` — Notion's data-source query is
   * exactly that: filter/sorts/pageSize are all optional, so "query everything" produced a
   * bodyless POST against an endpoint that requires one.
   *
   * Deliberately opt-in per action rather than inferred from "the method is POST": plenty of our
   * writes legitimately send nothing (a close/complete/acknowledge with the id in the path), and
   * conjuring `{}` for those would change requests that work today. Set it where the provider's
   * own document marks the body required.
   */
  alwaysSendBody?: boolean;
  /** One-line description for the config panel + docs. */
  description: string;
}

/**
 * WHERE THE CREDENTIAL COMES FROM, structured enough for a form to render (#1063).
 *
 * `auth` above is one sentence of prose, and `docs/integrations/<key>.md` has the long form — but
 * neither reaches the person staring at an empty **Token** box in the Connect dialog, which is the
 * one moment the answer is needed. This is that answer, in the smallest shape a dialog can render:
 * a link, a scope list, a few imperatives, and what the pasted value should look like.
 *
 * ALL FOUR FIELDS ARE OPTIONAL, and an absent one is a deliberate answer, not an oversight. Only
 * `tokenFormat` is ever present for every provider, because it is DERIVED from `authScheme` when
 * unauthored (see `./credential-setup`). Everything else is authored or nothing:
 *
 *   **Never guess a console URL or a scope.** A wrong scope list is worse than none — it sends
 *   someone to mint a token that cannot do the job, and the failure arrives later, as a 403 on a
 *   run. Author `tokenUrl` only where the provider's own documentation gives that exact page, and
 *   `scopes` only where the strings are the literal identifiers their console shows. If you are
 *   working from memory, leave both off: the generated `tokenFormat` still helps, and
 *   `docs/integrations/<key>.md` still has the prose.
 *
 * This does NOT replace `INTEGRATION_PROSE` (`../docs/integration-prose`), which stays the source
 * for the generated setup guides and holds the gotchas, the token lifetimes and the area-level
 * console paths. The two overlap by design while this is a first slice; `credential-setup.drift`
 * asserts what is authored here agrees with what is written there.
 */
export interface CredentialSetup {
  /** Deep link to the EXACT page that mints the credential, e.g.
   *  `https://api.slack.com/apps`. `https` only. */
  tokenUrl?: string;
  /** The exact permissions to tick, as the provider's own console spells them
   *  (`chat:write`, not "chat write"). */
  scopes?: string[];
  /** 2–5 imperative steps. Plain text — this is rendered in a dialog, not markdown. */
  steps?: string[];
  /** What we expect PASTED, e.g. "`email:api_token` — the pair, not the token alone".
   *  Generated from `authScheme` when unauthored; an authored value always wins. */
  tokenFormat?: string;
}

/** One renamed-or-removed field key, and the sentence the save gate hands the author. */
export interface RetiredField {
  /** The old key, exactly as it appears in an existing node's `fields`/`fieldBindings`. */
  key: string;
  /** The key that took over, when one did. */
  replacedBy?: string;
  /** What changed and what to do about it — reaches the user verbatim, so write it for them. */
  note: string;
}

export interface IntegrationProvider {
  key: string;
  label: string;
  /** Static API base, e.g. "https://api.github.com". */
  baseUrl?: string;
  /** When true, the base URL is the CONNECTION's serverUrl (e.g. an Atlassian site). */
  baseUrlFromConnection?: boolean;
  /**
   * The host to call when a `baseUrlFromConnection` provider's connection stores NO serverUrl
   * (#1110). Only meaningful together with that flag.
   *
   * **Never route a request off this field.** Base-URL resolution goes through
   * `resolveIntegrationBaseUrl` — that is the whole point of the function, and a caller that
   * reached for the default itself would silently ignore the host the tenant actually set.
   * Reading it to DESCRIBE the provider is fine and expected (the connect form prefills it, the
   * generated guide names it); reading it to decide where bytes go is not.
   *
   * It exists for exactly one situation: a provider that USED to have a fixed `baseUrl` and
   * turns out to be per-tenant after all. Connections made before the change stored no host
   * (nothing asked for one), and a `Connection` row carries no provider key — it is a `custom`
   * connection with a user-chosen label — so no migration can find those rows to backfill them.
   * Without a fallback, fixing the per-tenant case would break every connection that works today.
   *
   * It is therefore a COMPATIBILITY FALLBACK, not a user-facing option: both the Connect form
   * and the create-connection DTO reject an empty Server URL, so no new connection can reach it.
   */
  defaultBaseUrl?: string;
  /**
   * A concrete example Server URL, e.g. "https://your-site.atlassian.net". DISPLAY ONLY — the
   * connect form's placeholder and the "this connection needs a Server URL" error, never used to
   * build a request. Required of every `baseUrlFromConnection` provider (asserted in
   * integrations.spec): "set a Server URL" without a shape is advice nobody can act on, and the
   * alternative — a hand-written switch per surface — is a list that goes stale silently.
   */
  serverUrlExample?: string;
  /**
   * How the connection token becomes the auth header (default "bearer").
   * - "bearer" — `Authorization: Bearer <token>` (GitHub etc.).
   * - "basic"  — HTTP Basic; the stored token is `email:api_token`, sent as
   *   `Basic base64(email:api_token)` (Jira Cloud + an Atlassian API token; Bearer is
   *   only for its OAuth access tokens).
   * - `{ header, prefix? }` — a CUSTOM header form (#655). The raw token is placed in
   *   `header` with an optional literal `prefix`, e.g. Shopify
   *   `{ header: "X-Shopify-Access-Token" }`, Discord `{ header: "Authorization", prefix: "Bot " }`,
   *   Monday/ClickUp `{ header: "Authorization" }` (no `Bearer ` prefix). Only applies to
   *   api_token/pat connections; an OAuth access token stays a normal Bearer.
   */
  authScheme?: "bearer" | "basic" | { header: string; prefix?: string };
  /** Provider-required static headers (non-secret), e.g. GitHub's Accept/version. */
  headers?: Record<string, string>;
  /** One-line description + setup note surfaced in the palette + docs. */
  description: string;
  /** How a user authenticates (shown in docs). */
  auth: string;
  /**
   * Where to GET that credential — the structured form the Connect dialog renders (#1063).
   * Optional per provider; read it through `resolveCredentialSetup`, never raw, so the
   * derived `tokenFormat` is applied.
   */
  credentialSetup?: CredentialSetup;
  /**
   * Why this provider has NO credential probe — shown verbatim instead of the generated
   * "no zero-argument read" reason when `pickConnectionTestAction` finds nothing (#835).
   *
   * For the handful where the generated sentence would be true but unhelpful, or actively
   * misleading: Slack HAS a zero-argument identity call (`auth.test`), but it answers **HTTP 200
   * with `{"ok":false}`** for a dead token, and the probe verdicts on the HTTP status — so probing
   * it would report every dead Slack token as working. Saying that is the honest answer; silently
   * reporting "no zero-argument read" is not.
   *
   * Only ever read on the `unknown` path. It cannot suppress a probe that the rule would otherwise
   * select — a provider that gains a safe read starts being probed and this string goes unused.
   */
  unprobeableReason?: string;
  actions: IntegrationAction[];
}
