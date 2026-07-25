# Design — Native integration nodes (GitHub, Jira, …) via a declarative catalog

> **Status: slice 1 (GitHub + Jira) implemented.** This doc is the frozen design + the
> prioritized backlog of integrations to add. Adding an integration is a *data* change
> (a catalog entry), not new node types.

## 0. The decision — one `integration` node + a catalog, NOT N node types

An integration action ("create a GitHub issue", "add a Jira comment") is a **curated
authenticated REST call**: resolve auth from a connection, map an *action* to an HTTP
method + path + body, return the structured response. That is exactly what the
`httpRequest` node does — only with the URL/verb/shape pre-baked per action instead of
typed by the user.

So rather than a new node **type** per provider (a new zod schema + interpreter case +
activity + config panel across the four hottest files, *per integration*), there is **one
`integration` node type** backed by a **declarative catalog**:

```
provider → action → { method, pathTemplate, write, fields[] }
```

Adding an integration = **a catalog entry + a palette tile**. This is Tier-1 *"interpreter,
not codegen"* applied to integrations: the interpreter walks catalog data; it does not grow
a branch per provider.

**The user still sees "specific nodes."** The palette shows a **GitHub** tile and a **Jira**
tile (group: *Integrations*); each instantiates the one `integration` node with its
`provider` preset. Per-provider discoverability, without N types.

**Trade-off (accepted):** per-action strictness moves out of zod and into a **catalog-aware
save-gate validator** (required-fields-per-action, path-placeholder coverage) — the same
"strictness in a validator, not the schema" move the items-region model already makes.

### Native node vs `mcpTool` (so we don't ship a redundant path)
- **`integration`** — a *direct*, curated REST call to the provider's public API, authed by a
  connection. No MCP server needed. Fixed, discoverable action set with typed fields.
- **`mcpTool`** — an *arbitrary* tool on a user-run MCP server. Open-ended; the tool set is
  whatever that server exposes.

Use `integration` for first-class providers we curate; `mcpTool` for anything else.

## 1. The node model

```ts
interface IntegrationNodeConfig {
  provider: string;      // "github" | "jira" | …  (catalog key)
  action: string;        // "create_issue" | …     (catalog action key)
  connectionId: string;  // supplies auth (PAT/OAuth) + (Jira) the site base URL
  fields?: Record<string, unknown>;           // static field values
  fieldBindings?: Record<string, ArgBinding>; // {from,path} per field — same as mcpTool
}
```

Fields are resolved in the **workflow** (graph-traversal, deterministic) exactly like
`resolveMcpArguments`: static `fields` are the base, each `fieldBindings` entry overrides its
key with `getByPath(ctx[from], path)`. The activity receives a plain resolved-fields object —
no ctx, no secrets.

## 2. The catalog (`packages/dsl/src/integrations.ts`)

```ts
interface IntegrationField {
  key: string; label: string;
  in: "path" | "query" | "body" | "header"; // "header": wire name = the key (PagerDuty's `From`)
  required: boolean;
  type?: "string" | "number" | "boolean" | "string[]" | "json";
  bodyPath?: string;   // dotted target in the JSON body (Jira's fields.project.key)
  const?: string | number | boolean; // catalog-fixed value (PagerDuty's incident.type) — the
                                     // user never sets it; always counts as "supplied"
}
interface IntegrationAction {
  key: string; label: string;
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  pathTemplate: string;   // "/repos/{owner}/{repo}/issues"  — {placeholders} are path fields
  write: boolean;         // true → at-most-once (no retry); see §4
  fields: IntegrationField[];
}
interface IntegrationProvider {
  key: string; label: string;
  baseUrl?: string;              // static, e.g. "https://api.github.com"
  baseUrlFromConnection?: boolean; // Jira: the connection's serverUrl is the site base
  actions: IntegrationAction[];
}
```

The catalog is the single source of truth for: the config panel's action/field UI, the
activity's request construction, the save-gate validator, the per-node docs, and the tests.
Nothing else encodes an action's shape → nothing can drift.

## 3. Request construction (activity `callIntegration`)

Structurally a curated `callHttpRequest`, reusing its **seams** (`__httpDeps.resolveAuthHeader`,
`__httpDeps.assertEgressAllowed`, `__httpDeps.fetch`, the timeout) so it inherits SSRF, secret
hygiene (auth resolved in-activity, never returned/logged), and testability:

1. Look up `provider`+`action` in the catalog (unknown → non-retryable fail).
2. `base` = `provider.baseUrl` **or** the connection's `serverUrl` (`baseUrlFromConnection`).
3. Fill `{placeholders}` in `pathTemplate` from `in:"path"` fields; append `in:"query"` fields
   as the query string; assemble `in:"body"` fields into a JSON body (write verbs only); build
   `in:"header"` fields into per-request headers, merged **under** the resolved auth headers so
   a field (whose value may come from run data) can never clobber `Authorization` — a CR/LF in
   such a value is rejected as a non-retryable config fault. `const` fields are injected last,
   and a `const` nested deeper than the payload envelope is only sent when its sub-object
   already carries data (so no `{ type: … }`-only wrapper is invented).
4. `authHeaders = resolveAuthHeader(tenantId, connectionId)` (Bearer; PAT/api_token/OAuth).
5. `assertEgressAllowed(url)` → `fetch` with the deadline → parse JSON.
6. Return `{ status, ok, body }` — a non-2xx is **returned, not thrown** (branch on `.status`),
   matching the httpRequest contract. Transport/timeout throws (retryable, subject to §4);
   blocked egress throws non-retryable.

## 4. Retry idempotency — the landmine (writes must not duplicate)

`callHttpRequest` throws **retryable** on transport/timeout. A `create_issue` whose response is
lost *after* the provider created the issue would be retried → **duplicate issue**. Precedent:
`callSqlExec` / `callSendEmail` run **at-most-once** (`maximumAttempts: 1`) for exactly this.

So the interpreter routes by the action's `write` flag:
- **`write: false`** (reads: `get_issue`, `search`) → the normal retrying proxy.
- **`write: true`** (`create_issue`, `add_comment`, transitions) → an **at-most-once** proxy:
  a transient failure **fails the node** rather than risk a duplicate. Where a provider supports
  an idempotency key, a later iteration can add one to re-enable safe retries; v1 fails closed.

## 5. Region batchability — deferred to a follow-up (slice 1 is top-level only)

Integration nodes run at the **top level** in slice 1. Using one *inside* a `splitOut…loopEnd`
region ("create a Jira ticket per row") is deliberately **out of scope** here: the A3
node-major path dispatches per-item work through `mapNode`, which is keyed by node type
(`agent`/`httpRequest`/`mcpTool`) and would need an `integration` branch plus per-item field
plumbing — and `callIntegration`'s `(cfg, fields)` shape differs from the others' `(cfg, input)`.
Shipping that half-done would leave a broken A3 path, so `integration` is **not** in
`BATCHABLE_REGION_ACTIVITIES` yet; the region validator cleanly rejects it (a correctable 400).
The follow-up adds the `mapNode` branch + a `fields` carrier on `MapNodeItem`. Integration is of
course **not pure** (side-effecting) — excluded from `PURE_NODE_TYPES`.

## 6. Save-gate validation (catalog-aware)

Beyond the zod shape (`provider`/`action`/`connectionId` are strings), a validator checks, at
save time (a correctable 400, never a runtime surprise):
- `provider` and `action` exist in the catalog.
- Every `required` field is supplied (in `fields` or `fieldBindings`).
- Every `{placeholder}` in `pathTemplate` is a declared `in:"path"` field that is supplied.

## 7. Verification — what each level proves (asked for explicitly)

- **Table-driven unit tests over the catalog** (mocked `__httpDeps.fetch`): for each
  provider/action, build the request from sample fields+bindings and assert **method + URL path
  + body + the auth header is attached + `assertEgressAllowed` ran**. Proves *we call the right
  endpoint, correctly*.
- **Catalog completeness test**: every `{placeholder}` in every `pathTemplate` is a declared
  path field; every field has a label; every provider has a `baseUrl` xor `baseUrlFromConnection`.
  Proves *the catalog can't drift from itself*.
- **Save-gate validator tests**: missing required field / unknown action / uncovered placeholder
  → 400.
- **What these do NOT prove:** that GitHub/Jira *accept* the call (API drift, token scopes). That
  needs a **live smoke test** with a real connection against a throwaway repo / Jira site — a
  **documented manual step**, not CI (no creds in CI). Stated so "verified" isn't oversold.

## 8. Constraints / honest edges

- **Cloud only.** The SSRF egress guard blocks private hosts, so **GitHub Enterprise Server /
  self-hosted Jira on private networks won't work**. Cloud GitHub (`api.github.com`) and Atlassian
  Cloud sites are fine. Documented per node.
- **Auth** is whatever the connection provides, shaped by the provider's `authScheme`. GitHub →
  a PAT / GitHub App token as **Bearer** (`authScheme: "bearer"`, the default). Jira Cloud + an
  Atlassian API token → **HTTP Basic** (`authScheme: "basic"`): the connection token is
  `email:api_token`, sent as `Basic base64(email:api_token)` (Bearer is only for Jira's OAuth
  access tokens). The activity performs the Bearer→Basic transform from the resolved token.
- Per-node docs (`docs/integrations/*.md`) derive their action/field reference from the catalog so
  they can't drift.

## 9. Which integrations to add — prioritized backlog (the "what else" ask)

Shipped: **GitHub + Jira + Slack + Notion**. Ordered by fit for AI-agent + HITL workflows; each is
just a catalog entry once the pattern is in:

**Tier 1 — highest leverage (recommended next):**
- ~~**Slack** — post message / reply in thread / react.~~ **SHIPPED** — the notify/approve surface.
- ~~**Notion** — create page / append block / query database.~~ **SHIPPED** — added the `json` field
  type (raw JSON value for schema-driven payloads) to make it fit; this also unlocks Airtable etc.
- **Linear** — create/update issue, comment. **Needs a catalog extension: Linear is GraphQL-only**
  (one endpoint, a query + variables), which the REST `pathTemplate`/method model can't express.
  A `graphql` action kind (query template + variable mapping) is the next design step for it.

**Catalog capabilities so far:** flat/nested JSON bodies (`bodyPath`), path/query/body/**header**
fields, typed fields incl. **`json`** (raw value, bindable) for schema-driven payloads, catalog-fixed
**`const`** fields (API type discriminators, e.g. PagerDuty's `incident.type`), per-provider
`authScheme` (bearer / basic / a custom `{ header, prefix }` — Shopify, Discord, ClickUp, Monday,
PagerDuty's `Token token=`, DeepL's `DeepL-Auth-Key`). **Still needs extension for:** GraphQL
providers (Linear/Monday are modelled as a single POST + a `query` field), and non-header auth —
a credential in the URL path (Telegram's `/bot<token>/…`), in a query param (OpenWeatherMap's
`appid`), or a form-encoded body. A provider needing one of those must NOT be added with a
"close enough" `authScheme`: it would silently fail to authenticate (see #655).

**Tier 2 — broad demand:**
- **Google Sheets** (append row / read range) · **Airtable** (create/update record) ·
  **HubSpot** (create/update contact/deal) · **Stripe** (create customer / refund — writes,
  at-most-once) · **Zendesk / Intercom** (create ticket / reply) · **Discord / Telegram**
  (send message) · **PagerDuty** (trigger incident).

**Tier 3 — long tail (as asked):**
- Asana · Trello · ClickUp · Monday · Salesforce · Shopify · Twilio (SMS) · SendGrid/Resend
  (email — already have generic SMTP) · Google Calendar · Gmail · Microsoft Teams / Outlook.

Recommendation: do **Slack next** (unlocks the notify/approve loop end-to-end), then Linear +
Notion. The user picks the order from this list — each is ~a catalog entry + a tile + a doc page.
