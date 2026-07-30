# Integration inventory & real-environment verification

Every external system this product talks to, and the **cheapest way to prove it actually
works against the real service** — not against a mock.

Two things this document deliberately does:

- **It separates "shipped" from "proven live."** A provider being in the catalog means its
  request shape is typed and unit-tested. It does **not** mean anyone has ever run it
  against the real API with real credentials. The `Live proof` column is the honest one.
- **It marks what writes.** Before running any check against a production workspace you
  need to know whether it creates an issue, posts a message, or sends mail. That's the
  column no one can reconstruct from the code quickly.

Generated from the code, not from memory. Provider/action data is derived from
`packages/dsl/src/integrations.ts` (38 providers); routes from the API controllers.

---

## 1. The verification instruments

Five ways to get real-environment proof. Everything in the tables below points at one of them.

### 1.1 Single-node Test — the main instrument

`POST /api/graphs/:workflowKey/nodes/:nodeId/test`
(controller is `@Controller("graphs/:workflowKey")`; nginx strips the `/api` prefix — see
`apps/web/nginx.conf`)

This is the **only** way to exercise a catalog integration with real credentials without
running a whole workflow. It runs the **real activity** through a short-lived test-mode
Temporal execution: secrets are fetched and decrypted *inside* the activity, the SSRF
host-guard applies, and **billing counts** (`costUsd` in the response is real spend).

```bash
curl -sS -X POST "$BASE/api/graphs/$WORKFLOW_KEY/nodes/$NODE_ID/test" \
  -H "Authorization: Bearer $NAARY_TOKEN" \
  -H "x-workspace-id: $TENANT_ID" \
  -H "x-environment-id: $ENV_ID" \
  -H "content-type: application/json" \
  -d '{"autofillUpstream": true}'
```

- `$NAARY_TOKEN` may be a Firebase ID token **or** an `nry_…` API token — the auth guard
  accepts API tokens on any guarded route, so this is scriptable from CI or a shell.
- `x-environment-id` selects the env whose **connections and credentials** are used. Omit
  it for the tenant's default env. An env-**bound** API token ignores the header (and 403s
  if you send one) — the binding wins.
- Response: `{pure, output, durationMs, costUsd}` for runnable nodes, or
  `{pure: false, message}` for control/wait nodes that can't run in isolation.
- Requires the **`run`** permission on that workflow (RBAC matrix).

  **The API-token caveat that will bite a script.** In a workspace with **zero**
  `WorkflowGrant` rows, an `nry_` token has full access and this call just works. The moment
  the workspace has **any** grant, group enforcement switches on and `nry_` tokens become
  deny-by-default — the token must then be a member of a permission group holding a `run`
  grant on that workflow, or this returns 403. Adding your first permission group to a
  workspace silently breaks previously-working verification scripts.

**Point it at a sandbox environment with sandbox connections** when the action writes.

### 1.2 Validate-on-save — model & CLI provider keys

`POST /api/tenants/:id/credentials` → `{isValid}`; `GET` the same path lists
`{provider, isValid}` (never the key). Saving makes a **real call to the provider**, so a
successful save *is* live proof the key works. Six providers:
`anthropic`, `openai`, `google`, `claude-code`, `cursor`, `copilot`
(`packages/secrets/src/provider-validate.ts`).

### 1.3 Notification channel send-test

`POST /api/tenants/:id/notifications/:channelId/test` — delivers a real message through the
channel's real transport (Slack/Teams webhook, or SMTP for email channels). **Writes.**

### 1.4 codeAgent test

`POST /api/executions/code-agent-test` — proves the coding-CLI path (subprocess or sandbox
container) end to end.

### 1.5 Test connection — one-click credential proof (#701)

`POST /api/tenants/:id/connections/:connectionId/test` → `{ok, status, httpStatus, checkedAction,
connectionStatus, message}`; **Test** button on each connection row in the Integrations screen and
in the connect form right after save.

```bash
curl -sS -X POST "$BASE/api/tenants/$TENANT_ID/connections/$CONNECTION_ID/test" \
  -H "Authorization: Bearer $NAARY_TOKEN" \
  -H "content-type: application/json" \
  -d '{"provider":"calendly"}'
```

Calls the provider's cheapest **non-write, zero-required-field** catalog read with the connection's
credential and writes the answer back to `Connection.status`. What makes it real proof rather than a
second implementation: it composes the request through `planIntegrationCall` (`@naary/dsl`) — the
*same* function the `integration` node's activity uses for the auth-header scheme, base URL and
header merge order — so a pass proves the header scheme, base URL and token the node will actually
use. `apps/worker/test/integration-request.drift.spec.ts` pins the activity's emitted request to that
function across all 38 providers × `{api_token, oauth}`, so the two cannot drift.

- **`provider` is required.** A `Connection` row has no provider column (`type: "custom"` is
  provider-agnostic; the provider is chosen at the `integration` node), so the caller must say which
  API the token is for.
- **It cannot write.** The action is derived from the catalog's own `write` flag; there is no
  caller-supplied action or field override and no hand-maintained probe table.
- **`status: "unknown"`** = we declined to probe, which is *not* a verdict on the token; the
  connection's status is left untouched. See §2.4 for exactly which providers this covers.
- Env: the secret is read from the connection row's **own** `environmentId`, so no
  `x-environment-id` header is needed (or honored).
- RBAC: tenant scoping only, like the sibling create/list/delete routes — the matrix's verbs are
  per-workflow and none applies to a connection.

### 1.6 The live suite — `pnpm test:live`

Eight `*.live.spec.ts` files that run **real graphs through the real Temporal interpreter
against real external services**, each `describe.skipIf(!creds)` so a plain checkout runs
nothing. Config: `vitest.live.config.ts`. Credentials live in `~/.naary-live.env`.
Exact env-var names in §6.

---

## 2. Catalog integrations (38 providers, `integration` node)

All 38 execute through the **same** activity (`apps/worker/src/temporal/activities/integration.ts`).
The per-provider risk is therefore concentrated in **catalog data, not code**: the auth-header
scheme, the `baseUrl`, and the path/query templating. That is exactly why one real read-only
call per provider is high-value coverage rather than redundant — a typo in a header scheme is
invisible to every unit test and fatal in production.

`Safest read` = the non-write action with the fewest required fields (computed from the
catalog's own `write` flag and `fields[].required`). `Needs` = the fields you must supply.

| Provider | Safest read action | Needs | Read/total actions | Live proof |
| --- | --- | --- | --- | --- |
| airtable | `list_records` | baseId, tableId | 2/4 | — |
| asana | `get_task` | taskGid | 1/4 | — |
| box | `list_folder_items` | folderId (`0` = root) | 2/4 | — |
| calendly | `get_me` | — | 3/4 | — |
| clickup | `get_task` | taskId | 2/5 | — |
| cloudflare | `list_zones` | — | 2/4 | — |
| deepl | `get_usage` | — | 3/3 | — |
| digitalocean | `list_droplets` | — | 2/4 | — |
| discord | `get_channel` | channelId | 2/5 | — |
| dropbox | `list_folder` | path (`""` = root) | 2/4 | — |
| front | `list_conversations` | — | 3/4 | — |
| github | `get_issue` | owner, repo, issueNumber | 2/5 | **yes** — `github-agent.live.spec.ts` |
| gitlab | `list_issues` | projectId | 2/4 | — |
| googlesheets | `get_spreadsheet` | spreadsheetId | 2/5 | — |
| hubspot | `get_contact` | contactId | 1/4 | — |
| intercom | `get_contact` | contactId | 1/4 | — |
| jira | `get_issue` | issueKey | 1/4 | — |
| linear | `list_issues` | query (GraphQL) | 2/5 | — |
| mailchimp | `list_members` | listId | 2/5 | — |
| mattermost | `list_channel_posts` | channelId | 3/5 | — |
| monday | `list_items` | query (GraphQL) | 2/5 | — |
| msgraph | `list_messages` | userId | 2/4 | — |
| netlify | `list_sites` | — | 4/4 | — |
| notion | `get_page` | pageId | 2/4 | — |
| pagerduty | `list_incidents` | — | 2/6 | — |
| pipedrive | `list_deals` | — | 2/5 | — |
| posthog | `list_events` | projectId | 3/4 | — |
| sendgrid | `list_templates` | — | 1/3 | — |
| sentry | `get_issue` | issueId | 3/4 | — |
| shopify | `list_products` | — | 2/5 | — |
| **slack** | **none — all 3 actions write** | — | 0/3 | **yes** — webhook path, `approval-notify.live.spec.ts` |
| stripe | `list_charges` | — | 2/5 | — |
| todoist | `list_tasks` | — | 2/4 | — |
| twilio | `list_messages` | accountSid | 2/4 | — |
| vercel | `list_deployments` | — | 3/4 | — |
| webflow | `list_collections` | siteId | 3/4 | — |
| zendesk | `list_tickets` | — | 2/5 | — |
| zoom | `list_meetings` | userId | 2/4 | — |

### 2.1 Slack has no read-only smoke check

Every Slack catalog action (`post_message`, `update_message`, `add_reaction`) mutates. Its
smoke test **must post** — use a scratch channel, never a real one. (Slack's `humanApproval`
*notification* path is separately live-covered via webhook.)

### 2.2 The 9 providers whose auth is **not** a plain Bearer — verify these first

A wrong header scheme fails 100% of that provider's calls and is invisible to every unit
test. Machine-derived from each provider's `authScheme` field, which is what
`integration.ts` actually branches on (`"basic"` → re-wrap as Basic; an object → move the
token into a custom header with an optional prefix; absent/`"bearer"` → plain Bearer):

| Provider | `authScheme` | Effective header | Also needs |
| --- | --- | --- | --- |
| jira | `basic` | `Authorization: Basic base64(email:api-token)` | Server URL = your Atlassian site |
| twilio | `basic` | `Authorization: Basic base64(AccountSid:AuthToken)` | node's `accountSid` field set explicitly — it is **not** derived from the token |
| zendesk | `basic` | `Authorization: Basic base64(email/token:api-token)` | Server URL = `https://{sub}.zendesk.com/api/v2` |
| shopify | `{header: X-Shopify-Access-Token}` | `X-Shopify-Access-Token: <token>` | Server URL = `https://{shop}.myshopify.com/admin/api/2024-01` |
| discord | `{header: Authorization, prefix: "Bot "}` | `Authorization: Bot <token>` | — |
| clickup | `{header: Authorization}` (no prefix) | `Authorization: <token>` — **bare**, no `Bearer` | — |
| monday | `{header: Authorization}` (no prefix) | `Authorization: <token>` — **bare** | — |
| deepl | `{header: Authorization, prefix: "DeepL-Auth-Key "}` | `Authorization: DeepL-Auth-Key <key>` | Server URL = free vs pro host |
| pagerduty | `{header: Authorization, prefix: "Token token="}` | `Authorization: Token token=<key>` | `From:` = a PagerDuty user email, for writes |

The other 29 send a plain Bearer.

**An OAuth connection escapes both rewrites.** Both the Basic and the custom-header branches
are guarded on the connection's auth mode: an OAuth access token stays a genuine Bearer.
So a provider reached over OAuth exercises a *different* header path than the same provider
reached with a PAT — verify the mode you actually use.

### 2.3 Bearer, but still needs setup

| Providers | What's missing by default |
| --- | --- |
| `mattermost`, `deepl`, `shopify`, `mailchimp`, `zendesk`, `jira` | **No `baseUrl` in the catalog** — the connection's Server URL is mandatory. These are the only 6; the other 32 have a fixed base |
| `googlesheets` | A Google **OAuth access token** with the `spreadsheets` scope. A Google API key will never work — API keys go in a `?key=` query param, which this node does not send |
| `zoom` | A server-to-server OAuth token with a **~1h TTL** — rotate it, or calls start 401ing after an hour of working fine |

---

### 2.4 Which providers "Test connection" can actually prove — 31 of 38

This is the honest ceiling of §1.5, machine-derived from the catalog: an action that is `write: false`,
a `GET`, and has no required field the user would have to supply. It is smaller than §2's "safest read"
column, because that column allows an action that needs an id and this one does not.

It used to be **14 of 38**, and the missing half was the popular half — GitHub, Slack, Jira, Linear,
Notion and GitLab all reported `unknown`, which is where a dead token is most likely to be. #835 fixed
that in the CATALOG rather than in the route: 17 providers gained a genuine argument-free identity read
(`GET /user`, `/users/me`, `/meta/whoami`, …), each declared with `probe` on the action so the choice is
pinned. Every candidate endpoint was checked against the real API before it landed (unauthenticated,
expecting a 401/403 "route exists, credential rejected" — never a 404), and GitHub's two were checked
with real credentials.

**Testable with one click (31):** `airtable` · `asana` · `box` · `calendly` · `clickup` · `cloudflare` ·
`deepl` · `digitalocean` · `discord` · `front` · `github` · `gitlab` · `intercom` · `jira` ·
`mailchimp` · `mattermost` · `netlify` · `notion` · `pagerduty` · `pipedrive` · `posthog` · `sendgrid` ·
`sentry` · `shopify` · `stripe` · `todoist` · `twilio` · `vercel` · `webflow` · `zendesk` · `zoom`

**8 of the 9 non-Bearer providers** (§2.2) are now covered — the case where a wrong header scheme fails
100% of that provider's calls and no unit test would notice; only `monday` (GraphQL POST) is still not.
So are all **6 baseUrl-less providers** (§2.3), where the probe doubles as a check that the Server URL
points at the right host.

**GitHub takes two probes, chosen by the connection's `authMode`.** Verified live against
api.github.com: a PAT gets `200` from `GET /user` and `403` from `GET /installation/repositories`; a
GitHub App installation token gets exactly the reverse. One probe for both would report a healthy App
connection as broken, which is worse than not probing — hence `probe.authModes` on the catalog action.

**Reports `unknown` (7)** — use single-node Test (§1.1). Each says why, in the catalog
(`unprobeableReason`), and the reason reaches the user:

| Provider | Why it stays unprobed |
| --- | --- |
| `slack` | `auth.test` needs no arguments, but the Slack Web API answers **HTTP 200 with `{"ok": false}`** for a dead token. The check verdicts on the HTTP status, so probing it would call every expired token healthy |
| `linear`, `monday` | GraphQL: `query { viewer { id } }` would prove the key, but every call is a POST carrying a query, and the probe only ever issues a GET |
| `dropbox` | `/users/get_current_account` is an RPC **POST** |
| `msgraph` | `/me` answers only for a DELEGATED token; an application (client-credentials) token is rejected by it in a way indistinguishable from a bad credential |
| `hubspot` | No scope-free identity endpoint. The obvious candidate, listing contacts, is gated on `crm.objects.contacts.read` — a token scoped for deals only would 403 and be reported as a dead credential |
| `googlesheets` | The Sheets API has no identity endpoint, and Google's token/userinfo endpoints are on a **different host** than the provider's `baseUrl` |

A provider moves between these lists the moment its catalog entry gains a safe read — no code change
needed. `apps/api/test/connection-test.service.spec.ts` asserts the 31/7 split *and* names the seven, and
`packages/dsl/test/integration-docs.spec.ts` asserts each of them carries a reason, so this table cannot
silently rot.

**Ordering note:** an `unknown` answer comes *before* the missing-Server-URL check — telling someone to
fill in a Server URL for a provider we can't probe at all would send them to fix the wrong thing.

### 2.5 Which write bodies a SPEC can vouch for — 51 of 76 (#813)

A third evidence tier, between "unit-tested" and "run live": the request body an action builds,
diffed against the provider's own OpenAPI document. `packages/dsl/test/integration-catalog-openapi.drift.spec.ts`
resolves every `in: "body"` field's `bodyPath` against a pinned spec and classifies it
**confirmed** (it names a property the spec declares), **unknowable** (it lands in a free-form
object, or the spec is silent), or **wrong**. Only *wrong* fails the build. Run `pnpm test` and the
spec prints the per-action table **and the coverage line below** — the numbers here are pasted from
that run, and its denominator is computed from the catalog, so "of 76" cannot go stale by hand.

This does **not** replace the `Live proof` column. A spec proves the shape is *sayable*, not that
anyone has ever sent it. It does close the specific hole #707 and #811 came out of: an action whose
body could never be accepted, shipped looking exactly as trustworthy as one that works.

**Spec-verified — 25 providers, 51 of the 76 body-bearing write actions:** `asana` · `box` ·
`calendly` · `clickup` · `cloudflare` · `digitalocean` · `discord` · `front` · `github` · `gitlab` ·
`hubspot` · `intercom` · `jira` · `mailchimp` · `mattermost` · `msgraph` · `pagerduty` · `posthog` ·
`sendgrid` · `slack` · `stripe` · `todoist` · `twilio` · `webflow` · `zoom` — **125 body fields
confirmed, 8 unknowable, 2 wrong (both adjudicated).**

- The **8 unknowable** break down as: **5 are all of `jira.create_issue`**, whose every field lands
  under Jira's `fields`, declared `additionalProperties` — any key is legal there, so the spec
  cannot confirm or deny `fields.project.key` or `fields.summary`. That action is *covered* and
  contributes **zero** confirmed fields, which is exactly why the three states are printed
  separately: counting it as verified would be the inflation this audit exists to prevent. The other
  3 are properties a provider's own spec marks `readOnly` while its docs require them on a write
  (PagerDuty's `incident.service.id`/`.type`, Cloudflare's DNS `content`) — the spec contradicts
  itself there, so it neither confirms nor denies.
- The **2 wrong are not a red build.** A `wrong` verdict stays in the total once adjudicated, and
  both are `msgraph.send_mail`: Microsoft's generated document names the action parameters `Message`
  and `SaveToSentItems` after the CSDL declaration, while Microsoft's own reference and every one of
  its examples send `message`/`saveToSentItems`. Each lives in `ACKNOWLEDGED_BODY` with that
  evidence, and each must STILL be produced or the test fails — an acknowledgment that stops
  matching is either a fixed catalog or a changed spec, and both deserve a look.

**Not spec-verified — 10 providers plus one action of an 11th, 25 actions in total.** (`hubspot` is
in both lists: 2 of its 3 writes are verified, `create_deal` is not — which is why 25 + 10 lands on
35.) Grouped by why, because "we didn't check", "there is nothing to check against", and "the check
would lie" are three different claims:

| Why | Providers |
| --- | --- |
| **GraphQL — permanently out of scope, not pending.** The body IS `{query, variables}`, which is right by construction; the risk lives inside the query STRING, and only introspection can check that. Do not expect these to appear above | `linear` (3) `monday` (3) |
| Vendor publishes a machine-readable document in a **non-OpenAPI format**. Converting it ourselves would mean auditing our own converter, not their spec | `googlesheets` (2 — Discovery doc), `dropbox` (2 — Stone IDL, `dropbox/dropbox-api-spec`) |
| Vendor publishes **no** machine-readable REST document. Shopify's REST Admin API is legacy and only the GraphQL schema is published; the OpenAPI documents in circulation are third-party and years stale | `shopify` (3) |
| Spec exists but is **not a fetchable document** — Airtable's is embedded in its docs page's SSR state under an `"openApi"` key, with no raw URL. Scraping HTML into a fixture would put a third party's page structure in the refresh path, which is the one thing the pinning design exists to prevent | `airtable` (2) |
| Spec exists and documents **different endpoints than we call** | `pipedrive` (3 — the v1 document no longer contains `POST /deals`, `PUT /deals/{id}` or `POST /persons`; v2 needs a different base path, `PATCH`, and `{id}`), `sentry` (1 — only the org-scoped issue route; ours is the legacy un-scoped one) |
| Spec exists but describes a **different API version than we pin**, so diffing it would report a working call as broken | `notion` (2 — we send `Notion-Version: 2022-06-28`; the published document is 2025-09-03, where `POST /databases/{id}/query` is superseded by data sources) |
| Spec exists; matching needs a **path-rewrite seam** we chose not to build | `zendesk` (3 — canonicalises without the `.json` suffix our paths use). #813 set the bar at "worth doing when a second provider needs the same seam (Shopify's paths have the suffix too)"; Shopify turns out to publish no spec at all, so that bar can no longer be met and 3 actions do not justify a transform duplicated across the extractor and the drift spec, where a desync silently stops matching |
| One action, not a provider: `hubspot.create_deal`. HubSpot's Deals document templates every path on the internal objectTypeId `0-3` and never the word `deals`. The generic Objects document has `/crm/v3/objects/{objectType}`, but binding a literal segment of ours to a placeholder of theirs would make `{}` match anything and quietly un-check every path in the file | `hubspot` (1 of 3) |

Two rules this audit had to learn, recorded so the next one doesn't relearn them:

1. **A spec mismatch on a version-pinned API is not evidence of breakage.** Check what version we
   actually send before concluding an endpoint is gone (see `notion`), and check the live status
   code — `410` and `401` mean opposite things. Todoist's `/rest/v2` answers **410 Gone**, which is
   how the base URL in this PR came to be fixed rather than excused.
2. **Vendor-authored or it doesn't count.** APIs.guru conversions, third-party Postman collections
   and anything we would transform ourselves are not evidence — they make the fixture agree with our
   own reading rather than with the provider.

Adding one is a `SOURCES` entry in `packages/dsl/scripts/extract-openapi-fixtures.mjs` plus
`pnpm refresh:openapi-fixtures`; the reasons above live next to that list so they can be argued
with rather than rediscovered. Where a document was hard to find, the SOURCES comment carries the
DERIVATION (Calendly's is reachable only through a Gatsby chunk → Stoplight project id → node uri)
so a future 404 is recoverable.

## 3. Non-catalog product integrations

| Integration | Surface | Credential / config | Real-environment check | Writes? | Live proof |
| --- | --- | --- | --- | --- | --- |
| Anthropic / OpenAI / Google (BYOK LLM) | `agent` node | tenant provider key, per env | save the key (§1.2) → `isValid`; then single-node Test on an `agent` node | no (costs money) | **yes** — `github-agent.live.spec.ts`, `form-email.live.spec.ts`, `agent-tools.live.spec.ts` |
| Claude Code / Cursor / Copilot CLIs | `codeAgent` node | CLI token (`claude-code`/`cursor`/`copilot`) | §1.4 `code-agent-test`, or single-node Test | read-only mode: no. write mode: **commits/PRs** | **yes (Claude Code, read-only)** — `code-agent.live.spec.ts` |
| MCP servers (client side) | `mcpTool` node + agent in-loop tools | connection URL + token | single-node Test on `mcpTool` with a known safe tool | depends on the tool | **yes** — `mcp-tool.live.spec.ts`, `agent-tools.live.spec.ts` |
| **We are an MCP server** | `POST/GET/DELETE /api/mcp` (Streamable HTTP) | `nry_` API token | point a real MCP client at it (`claude mcp add --transport http $BASE/api/mcp` + bearer token) and call `list_workflows`. Built-in tools: `list_node_types`, `list_workflows`, `create_workflow`, `run_workflow`, `get_run`, `approve` | `create_workflow` / `run_workflow` / `approve` do | — |
| Workflow exposed as an MCP tool | `mcpServerTrigger` as the graph's **entry** node | same `nry_` token | the same MCP client must see a `run_<workflowKey>` tool (or the node's configured `toolName`) in `tools/list`; re-point the entry node and it must disappear | running it starts a run | — |
| Postgres | `sqlQuery` / `sqlExec` | SQL connection DSN | single-node Test with `SELECT 1` | `sqlExec` does | **yes** — `sql-sync.live.spec.ts` (`POSTGRES_TEST_DSN`) |
| MySQL | `sqlQuery` / `sqlExec` | SQL connection DSN | single-node Test with `SELECT 1` | `sqlExec` does | — |
| SQL Server (mssql/tedious) | `sqlQuery` / `sqlExec` | SQL connection DSN | single-node Test with `SELECT 1` | `sqlExec` does | — |
| SMTP | `sendEmail` node + email notification channel | SMTP connection URI | single-node Test to a mailbox you own, or §1.3 for a channel | **sends mail** | **yes** — `form-email.live.spec.ts` (real Ethereal SMTP round-trip) |
| Any HTTP API | `httpRequest` node | per-node auth / `$secrets` | single-node Test; SSRF guard runs for real | method-dependent | **yes** (as the transport under the integration/agent specs) |
| Any GraphQL API | `graphQL` node | per-node auth | single-node Test with a trivial query | mutation-dependent | — |
| OpenAPI import | `POST /api/introspect/openapi` | the spec URL | POST a real spec URL; guard + parse run for real | no | — |
| GraphQL introspection | `POST /api/introspect/graphql` | endpoint + token | POST a real endpoint — a successful introspect **proves the credential** | no | — |
| RSS / Atom feeds | `rssRead` node, `pollTrigger` | none | single-node Test against a real feed URL | no | — |
| pgvector (RAG) | `vectorUpsert` / `vectorQuery` | app Postgres + pgvector | `vectorUpsert` a scratch doc, then `vectorQuery` it back | **upsert writes rows** | — |
| Slack (notifications) | notification channel | incoming-webhook URL | §1.3 send-test | **posts** | **yes** — `approval-notify.live.spec.ts` |
| Microsoft Teams (notifications) | notification channel | incoming-webhook URL | §1.3 send-test | **posts** | **yes** — `approval-notify.live.spec.ts` |
| Email (notifications) | notification channel | `{connectionId, to[]}` | §1.3 send-test | **sends mail** | — |
| GitHub App | connection (`github-app/install/start` → `/api/github-app/callback`) | App ID + private key + installation | complete the install flow, then a `github` integration read | install itself does | **yes** — `github-app.live.spec.ts` |
| Atlassian 3LO | connection (`.../atlassian/oauth/start` → `/api/atlassian/oauth/callback`) | OAuth client | complete the flow; connection `status` must be `connected`; then a `jira` read | no | — |
| Generic OAuth2 connection | `.../oauth/start` → `/api/oauth/callback` | OAuth client | same: `status` → `connected`, then a provider read | no | — |
| PAT / custom connection | `POST /api/tenants/:id/connections` | token + server URL | §1.5 Test connection (31 of 38 providers — §2.4); otherwise single-node Test | no | — |
| Webhook ingress | `POST /api/hooks/:endpointId` | endpoint secret | `curl` a real payload; a run should appear | starts a run | covered by e2e |
| Hosted forms | `GET/POST /api/forms/:formId`, page at `/f/:id` | none (optional Turnstile) | load `/f/:id` in a browser and submit | starts a run | **yes** — `form-email.live.spec.ts` |
| Hosted chat | `GET/POST /api/chat/:chatId`, page at `/c/:id` | none (optional Turnstile) | load `/c/:id` and send a message | starts a run | covered by e2e |
| Schedules | `scheduleTrigger` (Temporal Schedules) | none | activate the workflow, wait one tick, check the Runs list | starts runs | covered by e2e |
| Object storage (claim-check) | large payload offload | `STORAGE_PROVIDER=s3`, `S3_BUCKET`, `AWS_REGION` | run a node whose output exceeds the offload threshold; the payload should become an `s3://` reference | writes objects | — |

---

## 4. Operator / platform integrations

These are wired by whoever runs the instance, not by a tenant. Each is **off unless
configured** — so "is it actually on in prod?" is the real question.

| Integration | Config | Is-it-live check |
| --- | --- | --- |
| Temporal | `TEMPORAL_ADDRESS` | `temporal workflow list`; a run must reach a terminal state. **Not** covered by `/healthz` — see the note below |
| Postgres (Neon in prod) | `DATABASE_URL` | `npx prisma migrate status`; any authed API read (the auth guard itself hits the DB) |
| Worker fleet | worker heartbeat rows | `GET /api/workers` — a live worker must appear with a recent heartbeat |
| Firebase Auth | Firebase project env | sign in through the SPA, or hit any authed route with an ID token. `/healthz` is `@Public()`, so it proves nothing about auth |
| Sentry (errors/traces/profiles/replay) | `SENTRY_DSN`, `SENTRY_TRACES_SAMPLE_RATE`, `SENTRY_PROFILES_SAMPLE_RATE`, `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE` | trigger a deliberate node failure; the issue must appear with `gen_ai.*` span attributes attached |
| OTLP metrics sink (Datadog etc.) | `OTEL_EXPORTER_OTLP_ENDPOINT` | run an `agent` node; `gen_ai.client.token.usage` series must appear with the `naary.gen_ai.usage.estimated` dimension |
| Flagsmith / OpenFeature | `FLAGSMITH_API_URL`, `FLAGSMITH_ENVIRONMENT_KEY` | `GET /api/me/flags` (authed); flip a flag in Flagsmith and re-read |
| S3 | `STORAGE_PROVIDER=s3`, `S3_BUCKET`, `AWS_REGION` | see claim-check row in §3 |
| Cloudflare Turnstile | per-tenant BYO keys (`GET /api/turnstile-config`) | submit a real gated form from an allow-listed hostname |
| Encryption at rest | `ENCRYPTION_KEY` (required at boot) | save a credential, then read it back through an activity — never from the DB directly |
| Prometheus metrics | `/metrics` on the api container | scrape **container-to-container** (`api:3000/metrics`) — the public proxy returns 404 by design |
| netdata | compose service | its own dashboard |
| Sandbox runner (Docker) | `COMPOSE_PROFILES=sandbox`, `CODE_AGENT_SANDBOX_READ` | §1.4 `code-agent-test` — the container must be reached, not the host subprocess |

---

## 5. A safe 5-minute smoke pass on a live instance

Ordered so each step's failure tells you something distinct:

1. `GET /api/healthz` → the API process is up and serving HTTP. **That is all it proves** — it
   is a deliberately trivial liveness probe (`apps/api/src/health/health.controller.ts`) and
   returns `ok` even when Temporal and the DB are down. Do not treat a green healthz as
   "prod is fine."
2. `GET /api/workers` → a worker is polling with a fresh heartbeat. Combined with an authed
   read (which touches the DB), this is what actually tells you the downstreams are alive.
3. `GET /api/tenants/:id/credentials` → every provider you rely on shows `isValid: true`.
   (Re-saving a key re-validates it against the provider.)
4. Single-node Test the **read-only** action from §2 for each catalog provider you use,
   against the **sandbox** env.
5. §1.3 send-test each notification channel — this is the one that pages people, so do it
   last and tell them first.

Nothing in steps 1–4 writes to an external system, except step 4 for Slack (§2.1).

---

## 6. Live-suite credentials (exact env-var names)

`pnpm test:live` — costs money (paid LLM calls) and leaves side effects; tests create
`naary-e2e-*` resources and clean up in `finally`. Files are serialized
(`fileParallelism: false`) because they share remote state.

The two columns are **not** interchangeable: only the first unskips the suite. Exporting an
optional var and still seeing a skip means a *required* one is missing.

| Spec | Required to unskip (the `skipIf` gate) | Optional config it also reads |
| --- | --- | --- |
| `github-agent.live.spec.ts` | `GITHUB_TEST_TOKEN` **and** `GITHUB_TEST_REPO` **and** `ANTHROPIC_TEST_KEY` | — |
| `github-app.live.spec.ts` | `GITHUB_APP_ID` **and** `GITHUB_APP_PRIVATE_KEY` **and** `GITHUB_APP_INSTALLATION_ID` **and** `GITHUB_TEST_REPO` | — |
| `approval-notify.live.spec.ts` | `SLACK_TEST_WEBHOOK_URL` **OR** `TEAMS_TEST_WEBHOOK_URL` — either alone is enough | `APP_BASE_URL`, `ENCRYPTION_KEY` |
| `form-email.live.spec.ts` | `ANTHROPIC_TEST_KEY` | — (SMTP is a real Ethereal account created on the fly) |
| `mcp-tool.live.spec.ts` | `MCP_TEST_URL` **and** `MCP_TEST_TOOL` | `MCP_TEST_TOKEN`, `MCP_TEST_ARGS` |
| `agent-tools.live.spec.ts` | `ANTHROPIC_TEST_KEY` **and** `MCP_TEST_URL` **and** `MCP_TEST_TOOL` | `MCP_TEST_TOKEN`, `MCP_TEST_TOOL_DESC` |
| `code-agent.live.spec.ts` | `CLAUDE_CODE_TEST_TOKEN` | — |
| `sql-sync.live.spec.ts` | `POSTGRES_TEST_DSN` | — |

`APP_BASE_URL` matters beyond tests: without it the worker renders Slack/Teams messages with
no approve buttons and no run links.

Related suites: `pnpm test:integration` (real drivers/nodes against testcontainers Postgres
and in-process HTTP/GraphQL servers — no internet, no cost) and `pnpm test` (default).

---

## 7. Known gaps

Stated as facts, not as a plan.

1. ~~**No per-connection "Test connection" route.**~~ **Closed by #701**, widened by **#835** — see
   §1.5. The remaining gap is narrower and stated in §2.4: **31 of 38** providers have a non-write,
   zero-required-field GET, so one-click proof is available for 31; the other **7** (`slack`,
   `linear`, `monday`, `dropbox`, `msgraph`, `hubspot`, `googlesheets`) still need single-node Test,
   each for a named reason the product shows the user.
2. **37 of 38 catalog providers have no real-environment proof.** Only GitHub is exercised
   live (plus Slack's webhook notification path, which is not the `integration` node). The
   other 36 are typed, unit-tested, and unproven against the real API. Since #813, 13 of them
   also have their write bodies diffed against the provider's own OpenAPI spec (§2.5) — which
   narrows the gap without closing it: a spec proves the shape is sayable, not that it works.
3. **Only Postgres of the three SQL engines is live-covered.** MySQL and SQL Server have
   unit + integration coverage; no live DSN gate exists.
4. **`codeAgent` live coverage is Claude Code, read-only.** Cursor and Copilot have no live
   spec, and write mode (commit/PR) is not live-covered.
5. **Email notification channels have no live spec** — the `sendEmail` *node* does
   (`form-email`), the *channel* path does not.
6. **Turnstile + iframe embeds interact badly by design.** For an iframe embed, Turnstile
   solves inside *our* framed document, so the solved hostname is this instance's host, not
   the tenant's site. A tenant who lists only their own domains will have gated iframe
   submissions denied.
7. **`vectorUpsert`/`vectorQuery`, object-storage claim-check, Atlassian 3LO, and the
   generic OAuth2 connection flow** have no live spec.
