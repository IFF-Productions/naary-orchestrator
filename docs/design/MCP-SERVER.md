# Design — MCP Server (naary as an agent-callable durable backend)

**Status:** proposed · **Date:** 2026-07-05 · **Purpose:** expose naary itself as an MCP
server so an external AI agent (Claude Desktop, Cursor, an SDK agent) can discover, build,
run, and supervise **durable** workflows — turning naary into the crash-surviving, multi-day,
human-in-the-loop execution backend that agents don't have on their own.

naary is already an MCP *client* (the `mcpTool` node). This doc is the inverse: naary as an
MCP *server*. It is the natural follow-on to the node catalog (PR #145), which is the data an
agent needs to know "what can I build with."

---

## 1. What naary already has (grounded)

Everything a server needs to wrap already exists as a service call — this is thin glue, not
new machinery:

- **MCP SDK, both halves.** `@modelcontextprotocol/sdk ^1.29.0` is already a dependency in
  `packages/connections` (for the client). The same package ships `Server` +
  `StreamableHTTPServerTransport` — the **mirror** of the `StreamableHTTPClientTransport` we
  already use in `packages/connections/src/mcp.ts`. No new transport to pick.
- **Auth built for machines.** `apps/api/src/auth/auth.guard.ts` is dual-auth. A
  **`nry_`-prefixed API token** (`ApiTokenService.verify` → `tenantId`, `role:"owner"`;
  sha256-hashed in the `ApiToken` Prisma model) already means "a non-human principal acting
  for exactly one workspace." That IS the MCP auth story.
- **Node catalog.** `NODE_CATALOG` / `nodeCatalogPrompt()` in `@naary/dsl` (PR #145) — the
  exhaustive, machine-readable list of node types + config hints.
- **Generate.** `GraphGeneratorService.generate(tenantId, prompt) → { name, graph }` — NL →
  validated draft `GraphDef` (BYOK, tenant's own key).
- **Save.** `GraphsService.upsert(tenantId, workflowKey, name, graph) → GraphSnapshot`
  (validates + content-hashes + versions).
- **Run.** `ExecutionsService.start(tenantId, input?, workflowKey) → { workflowId }`
  (snapshots the latest graph, starts `RUN_GRAPH_WORKFLOW` on Temporal).
- **Supervise.** `ExecutionsService.getState(id, tenantId) → { status, currentNodeId?, ctx }`
  (+ the `runRecord` read-model for cheap listing; `history()` for a timeline). HITL resumes
  via `approvalSignal`.

---

## 2. The two flavors (they compose)

| | **A. Control-plane MCP server** | **B. MCP Server-Trigger node** |
|---|---|---|
| What it exposes | A fixed toolset to *operate naary* | One **saved workflow** as one callable tool |
| Who calls it | An agent that manages workflows | An agent that just wants "run the refund flow" |
| Tool set | `list_node_types`, `list_workflows`, `create_workflow`, `run_workflow`, `get_run`, `approve` | `run_<workflowKey>` with the workflow's own input schema |
| n8n analogue | (n8n has no first-class equivalent) | n8n's **MCP Server Trigger** |
| Endpoint | one per workspace: `/mcp` | one per exposed workflow: `/mcp/wf/:workflowKey` |

**A** is the broad play (an agent designs + runs anything, durably). **B** is n8n-parity
(a workflow becomes a tool). Build **A first** — it's the foundation and needs no new node
type; **B** is a thin specialization once A's run/get_run plumbing exists.

---

## 3. Transport + auth

- **Transport:** `StreamableHTTPServerTransport` mounted at `POST/GET /mcp` on the existing
  Nest HTTP app (Streamable HTTP is the current MCP standard; SSE is legacy). A new
  `McpModule` owns an `McpController` (`@Public()` so the global `AuthGuard` doesn't run
  first) that hands the request to the transport.
- **Auth:** the MCP client sends `Authorization: Bearer nry_…`. We verify it with the *same*
  `ApiTokenService.verify(token)` the guard uses → `tenantId`. Every tool call then runs with
  that `tenantId` — the same isolation boundary as the REST API. **No token → no tools**
  (reject the session). Reuse, don't fork, the guard's verification path.
- **Isolation:** a session is bound to one `tenantId` for its lifetime; tools never accept a
  `tenantId` argument (it comes only from the token) — mirrors CLAUDE.md Tier-1 rule 4.
- **Minting:** workspaces already mint `nry_` tokens; Phase 3 adds a web affordance to create
  an "MCP token" and copy the `…/mcp` URL + token into an agent's MCP config.

---

## 4. The tool surface (flavor A, Phase 1)

Each tool is ~10 lines wrapping an existing service. Secrets never appear in args or results;
inputs/outputs are small JSON (Temporal 2 MB payload discipline still applies downstream).

- **`list_node_types`** → `{ nodes: [{ type, group, summary, config? }] }`. Straight from
  `NODE_CATALOG`. This is *how the agent knows what to build.*
- **`list_workflows`** → `{ workflows: [{ workflowKey, name, version }] }`. From the latest
  `graphDefinition` per key for the tenant.
- **`create_workflow`** — two modes: `{ prompt }` (calls `generate`) OR `{ name, graph }`
  (a graph the agent authored directly). Returns the **draft** and, if `save:true`, calls
  `upsert` → `{ workflowKey, version, contentHash }`. Default `save:false` so an agent can
  inspect before persisting (matches the canvas's "generate → review → save").
- **`run_workflow`** `{ workflowKey, input? }` → `{ runId }` (the Temporal `workflowId` from
  `start`). Fire-and-return; the run is durable, so the agent's own session ending doesn't
  kill it — the core value prop.
- **`get_run`** `{ runId }` → `{ status, currentNodeId?, output? }`. From `getState`. The
  agent polls this (or, later, subscribes) to await a multi-minute/multi-day run.
- **`approve`** `{ runId, decision, note? }` → `{ ok }`. Sends `approvalSignal` so an agent
  can satisfy a `humanApproval` pause (or a *human* does it in the UI — both work).

MCP **resources** (optional, cheap): expose each saved graph as a resource
`naary://workflow/{workflowKey}` so an agent can read a flow it's editing.

---

## 5. The Server-Trigger node (flavor B, Phase 2)

Expose a chosen saved workflow as its own MCP tool so an agent calls it like any other tool:

- A workflow opts in (a flag on the graph, or an allow-list on the MCP token). Its **input
  schema** comes from its entry node (a `webhookTrigger`/`start` `inputSchema`, or inferred).
- The server advertises `run_<workflowKey>` with that schema; a call maps to
  `start(tenantId, input, workflowKey)`. Two return modes: **async** (return `runId`, same as
  A) or **await** (server waits on `handle.result()` up to a bounded timeout, then returns the
  output) — await is what makes it feel like a normal synchronous tool for short flows, async
  is mandatory for long/HITL ones.
- Endpoint `/mcp/wf/:workflowKey` (or a single `/mcp` whose tool list is the token's allowed
  workflows). No new interpreter work — it's `run_workflow` with a per-workflow schema.

---

## 6. Where this makes naary stronger than n8n

An MCP tool call is normally ephemeral — it lives and dies inside the agent's turn. Routing it
through naary means the agent gets, for free:

- **Durability** — the run survives the agent disconnecting, the server restarting, a crash.
  `run_workflow` returns immediately; `get_run` reconnects to state hours later.
- **Human-in-the-loop** — a tool can *pause for a person* (`humanApproval`, days) and the
  agent picks it back up via `get_run`/`approve`. No other agent backend offers this.
- **Unbounded, crash-safe retries + budget caps** — the agent doesn't babysit reliability.

This reframes naary from "a workflow tool with AI nodes" to "**the durable execution layer for
AI agents**" — the differentiator already stated in CLAUDE.md, now exposed to the whole agent
ecosystem.

---

## 7. Non-negotiables carried into every slice

- **Secrets never cross the MCP boundary.** Tools take/return `tenantId`-scoped data only; the
  `tenantId` comes from the token, never an argument. Provider keys stay in activities.
- **Tenant isolation == token.** Every tool inherits the session's single `tenantId`; no
  cross-tenant argument exists to abuse.
- **Billing still fails safe.** Runs started via MCP meter usage exactly like REST-started
  runs (same `ExecutionsService.start` → same ledger).
- **No new durability layer.** The MCP server is stateless glue over Temporal; it does not hold
  run state (Tier-1 rule 7).

---

## 8. Rollout — as slices (each its own PR)

1. **`McpModule` + auth + `list_node_types`.** Stand up the Streamable HTTP transport, verify
   `nry_` tokens, ship one read-only tool. Proves transport + auth end-to-end.
2. **`list_workflows` + `get_run`.** The other read-only tools (read-model + `getState`).
3. **`run_workflow`.** First write path — start a durable run from an agent.
4. **`create_workflow`** (generate + optional save) — the "agent builds a flow" moment.
5. **`approve`** — close the HITL loop from the agent side.
6. **Server-Trigger node (flavor B)** — per-workflow tools, async + await return modes.
7. **Web: mint MCP token + show the `/mcp` URL** and a copy-paste agent config snippet.

Slices 1–3 are the minimum that demonstrates the whole story (discover → run → supervise).

## 9. Verification plan

- **We're our own client.** `packages/connections` already has an MCP client — an e2e test
  connects it to our server and round-trips `list_node_types → create_workflow → run_workflow
  → get_run` against a dev Temporal, asserting a real run reaches `completed`.
- **MCP Inspector** (the official dev tool) against `/mcp` for manual/tool-schema checks.
- **Per-tool unit tests** with a mocked `ExecutionsService`/`GraphsService` (the tools are thin
  — assert they pass `tenantId` from the token, never from args).
- **Auth tests:** no token / bad token / wrong-tenant token → session rejected; a valid token
  sees only its tenant's workflows.

## 10. Residual open questions

- **Streaming progress.** Do we push run progress as MCP notifications (server→client) for a
  live "watch the run" feel, or is `get_run` polling enough for v1? (Polling for v1.)
- **`create_workflow` default.** Return an unsaved draft (safer, matches canvas) vs auto-save
  (fewer round-trips for an autonomous agent). Proposed: draft by default, `save:true` opt-in.
- **Server-Trigger input schemas.** Where does a workflow's tool schema come from — an explicit
  `inputSchema` on the entry node, or inferred from `set`/binding usage? (Explicit field first.)
- **Token scope.** `nry_` tokens are full-tenant-owner today. Do MCP tokens need a narrower
  scope (e.g. run-only, or an allow-list of workflowKeys for flavor B)? Likely yes for B —
  ties into the deferred RBAC/roles slice.
- **Concurrency/session lifecycle.** Streamable HTTP session GC + per-tenant rate limiting.
