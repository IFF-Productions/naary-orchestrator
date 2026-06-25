# PLAN.md — Vertical Slice #4: External Integrations (Webhook Triggers + MCP Tool Nodes)

> **For the executing agent:** Builds on Slices #1–#3. Reuses the Slice #2 encrypted
> secret store for all tokens. Two phases — **do Phase A fully before Phase B.** One
> task at a time; verify before moving on. Stay in plan mode until approved.

## 1. Purpose

Let workflows (a) be **triggered by** external platforms like GitHub and Jira, and
(b) **act on** them. Both use one mechanism per direction, so adding a third platform
later is config, not new code:

- **Inbound = webhooks** (Phase A). GitHub/Jira fire a webhook → it starts a workflow.
  This is plain signed HTTP, **not** MCP.
- **Outbound = MCP** (Phase B). An MCP Tool node calls a remote MCP server's tools
  (create issue, comment on PR, transition ticket). GitHub and Atlassian both run
  **official remote MCP servers**, so for the common case you connect to *their*
  hosted server rather than running one.

### The key architectural insight

Our orchestrator is a **headless, long-running MCP client**, not an interactive
desktop client. The remote servers' browser-based OAuth flow is built for interactive
clients (a browser pops up). So we split auth by where it happens:

- **Interactive consent runs once in the web app** (the "Connect Jira" button). We
  capture a **refresh token** (requires the `offline_access` scope).
- **The Temporal activity refreshes non-interactively at run time** using that stored
  refresh token — it never does a browser flow.
- For headless/enterprise, also support **API token / PAT** auth (Atlassian offers
  this for headless setups; Jira Data Center uses a PAT). This is simpler — target it first.

## 2. Scope

**In scope:**
- **Phase A:** a Webhook Trigger node + per-trigger ingress endpoint with signature
  verification (GitHub HMAC, Atlassian scheme) and delivery dedupe; payload → workflow start.
- **Phase B:** an MCP Tool node; an MCP client (Streamable HTTP, the `/mcp` endpoint)
  used **inside an activity**; tool discovery; a `connections` model; two auth paths —
  API-token/PAT first, then OAuth 2.1 with Dynamic Client Registration (RFC 7591) +
  PKCE + refresh.
- GitHub and Atlassian as the two reference integrations, plus a generic
  "add any MCP server by URL" connection as the platform-agnostic backstop.

**Explicitly OUT of scope:**
- No connector-marketplace polish — functional Connect/Disconnect only.
- No GitHub App install flow yet (per-installation tokens) — OAuth/PAT first; GitHub
  App is the production hardening follow-up (§8).
- No webhook-driven *resume* of a paused run (signal) yet — Phase A only *starts*
  workflows. (§8.)
- No fine-grained per-tool permission UI beyond the agent node's tool bindings.

## 3. Architecture constraints (add to CLAUDE.md)

1. **MCP calls and token refresh are I/O → activities only.** The workflow passes only
   `tenantId`, `connectionId`, and node config. Tokens are fetched/refreshed in-activity,
   never returned, never in workflow history.
2. **Webhook ingress lives outside the workflow** (like Slice #1 triggers): the
   controller verifies the signature, then calls `client.workflow.start()`.
3. **All tokens use the Slice #2 encrypted store.** Refresh tokens are credentials.
4. **Point clients at `/mcp` (Streamable HTTP), not `/sse`** (the older transport).
5. **Confirm every endpoint/scope against the provider's current docs** — they move;
   do not hardcode from memory.

## 4. Data model

```prisma
model WebhookEndpoint {
  id         String   @id @default(uuid())
  workflowId String
  tenantId   String
  provider   String   // 'github' | 'atlassian' | 'generic'
  signingSecret String // for HMAC verification
  createdAt  DateTime @default(now())
}

model Connection {
  id         String   @id @default(uuid())
  tenantId   String
  type       String   // 'atlassian' | 'github' | 'custom'
  label      String
  serverUrl  String   // e.g. https://mcp.atlassian.com/v1/mcp
  authMode   String   // 'api_token' | 'pat' | 'oauth'
  scopes     String[]
  status     String   @default("connected") // 'connected' | 'needs_reauth' | 'error'
  // secret/refresh token stored via the Slice #2 encrypted credential store, keyed by this id
  createdAt  DateTime @default(now())
  @@unique([tenantId, type, label])
}
```

## 5. Tasks — Phase A (inbound webhooks)

### A0 — Webhook Trigger node + endpoint registration
- `WebhookEndpoint` table; a `Webhook Trigger` node type; on save, generate a unique
  ingress URL (`/hooks/:endpointId`) + signing secret, surfaced to the user to paste
  into GitHub/Jira.
- **Verify:** creating a webhook-triggered workflow returns a stable URL + secret.

### A1 — Signed ingress endpoint
- `POST /hooks/:endpointId`: verify the signature (GitHub `X-Hub-Signature-256` HMAC-SHA256
  over the raw body; Atlassian per its scheme), reject mismatches with 401, and dedupe
  on the delivery id (e.g. GitHub `X-GitHub-Delivery`).
- **Verify:** a sample `pull_request` payload with a valid signature is accepted; a
  tampered body / bad signature returns 401; a duplicate delivery id is ignored.

### A2 — Payload → workflow start
- On a verified event, `client.workflow.start(runGraph, { args: [graph, event, { tenantId }] })`
  using the endpoint's tenant; the event payload becomes the trigger node's output.
- **Verify:** a valid GitHub PR webhook starts an execution; `GET /executions/:id`
  shows the event available as the trigger node's output.

## 6. Tasks — Phase B (outbound MCP)

### B0 — Connections model + service
- `Connection` table; service with create/list/delete; secrets/refresh tokens written
  through the Slice #2 crypto. API: `GET/POST/DELETE /tenants/:id/connections`.
- **Verify:** create an `api_token` connection; the token is stored encrypted, not plaintext.

### B1 — API-token / PAT auth path (simplest first)
- Store the API token/PAT for a connection; an activity helper returns the auth header
  for that connection.
- **Verify:** unit test resolves a connection to a valid auth header without exposing the token.

### B2 — MCP Tool node + activity call
- `MCP Tool` node config: `connectionId`, selected `tool`, and input bindings from
  upstream node outputs. New activity `callMcpTool`: open an MCP client (Streamable HTTP)
  to `connection.serverUrl`, list tools, invoke the configured tool with mapped inputs,
  return the result. No secrets in the result or logs.
- **Verify (integration):** with an `api_token` Atlassian connection, an MCP Tool node
  runs a Jira tool (e.g. search issues or create issue) end-to-end inside a workflow
  and returns structured output.

### B3 — OAuth 2.1 interactive consent (in the web app)
- `POST /tenants/:id/connections/:type/oauth/start` → perform Dynamic Client
  Registration (RFC 7591) against the server, build a PKCE authorize URL requesting
  `offline_access`, return it for the browser to open.
- `GET /oauth/callback` → exchange the code, store the **refresh token** encrypted on
  the connection, set `status='connected'`.
- **Verify:** completing the browser flow for Atlassian persists an encrypted refresh
  token and the connection shows connected.

### B4 — Non-interactive refresh in the activity
- Before an MCP call, fetch the refresh token, mint/refresh an access token, use it.
  Cache the short-lived access token; serialize refreshes per connection (a lock) to
  avoid concurrent-refresh races. On `401`/invalid-grant → set `status='needs_reauth'`,
  surface to the user, and fail the activity **non-retryably**.
- **Verify:** after consent, an activity with no browser available refreshes and calls
  a tool successfully; a revoked token flips the connection to `needs_reauth`.

### B5 — End-to-end reference flow
- Wire the canonical flow: GitHub PR webhook (Phase A) → Agent reviews the diff →
  MCP Tool node comments back via a GitHub connection → Human Approval before any merge.
- **Verify:** the full loop runs; show the execution timeline and the resulting action.

## 7. Definition of done
- [ ] A GitHub/Jira webhook with a valid signature starts a workflow; bad signatures rejected.
- [ ] An MCP Tool node calls a real remote MCP server tool via an `api_token` connection.
- [ ] OAuth consent in the web app persists an encrypted refresh token.
- [ ] An activity refreshes that token non-interactively and calls a tool — no browser,
      no token in workflow history or logs.
- [ ] A revoked/expired token surfaces as `needs_reauth`, not an infinite retry.
- [ ] The reference GitHub-PR-review flow runs end to end.

## 8. Next slices (context only — do NOT build now)
1. **GitHub App** install flow (per-installation tokens, granular repo scopes, higher
   rate limits) — the production-grade multi-tenant GitHub auth.
2. **Webhook → resume**: let an inbound event *signal* a paused run, not just start one.
3. **Connector gallery / curated Connect catalog** with polished per-provider UX.
4. **Self-hosted instances**: let a tenant point a connection at GitHub Enterprise /
   Jira Data Center URLs (different endpoints; PAT auth).
```