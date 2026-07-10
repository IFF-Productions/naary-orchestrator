# Design — Chat Trigger + Retrieval (RAG)

**Status:** proposed · **Date:** 2026-07-09
**Prereq reading:** `N8N-PARITY-GAPS.md` §7 row 12 (deferred AI item, specced here).
**Plays to:** naary's real strength — durable agent + tool orchestration.

---

## 1. The gap

n8n's popular AI on-ramp is the **Chat Trigger**: a hosted chat widget that starts a workflow per
message, with the agent grounded on a **vector store** (RAG). naary has the hard parts already —
the `agent` node, `mcpTool`, BYOK credentials, per-tenant budget, durable execution — but no
conversational entry point and no retrieval nodes. This doc specs both, reusing the machinery the
Form Trigger mini-program just built (public entry surface + anonymous-submission security).

## 2. Design

### 2.1 `chatTrigger` — a conversational entry node
- A new entry node (sibling of `formTrigger`): its output IS the inbound `{ message, sessionId }`.
  Mirrors the formTrigger passthrough (`ctx[node.id] = ctx.__input`) — same interpreter shape.
- **Public surface** (reuse the Form Trigger slice-2/3 pattern exactly): a `ChatEndpoint` registry
  row (opaque id, no secret), a `@Public()` `POST /chat/:chatId` that validates + rate-limits +
  **requires a tenant budget cap** (the anonymous-spend backstop we established for forms), and a
  hosted chat page at `/c/:chatId` outside `RequireAuth`.
- **Sessions & durability (the differentiator):** a chat session maps to ONE long-lived workflow
  that stays open across messages via Signal + `condition()` — the same durable-wait primitive as
  human approval. A message is a Signal; the agent's reply is read back via a Query. This is where
  naary beats n8n's queue-mode memory caveats: the conversation state lives in Temporal, survives
  worker crashes, and can pause for days.

### 2.1b Durable per-session workflow — design (the deferred differentiator)

The public chat surface (#215) is **single-turn**: each `POST /chat/:id` is a fresh `runGraph` with
no memory. This section designs the durable session so a conversation has memory across messages.

**Session = one long-lived workflow** keyed deterministically by
`chatsession-<tenantId>-<chatId>-<sessionId>`. Its only durable state is the conversation
`history: {role, text}[]`.
- **`POST /chat/:id`** → `signalWithStart(chatSession, {message})` (starts it on the first message,
  signals it thereafter) → then Query the session for the reply.
- **The session workflow loop:** `await condition(() => pending !== undefined, IDLE_TIMEOUT)`; on a
  message it runs the chat graph, appends `{user}` + `{assistant}` to history, exposes the reply via
  a Query, clears `pending`, loops. `continueAsNew(history)` when event history grows; the idle
  timeout ends the session (frees the workflow) after N minutes of silence.

**The hard part — how the session runs the graph + gets the reply.** `runGraph` returns
`{status, ctx}`, but the reply (a `respondToWebhook` **body**) lives only in a query, not `ctx`.
Options:
- **(i) Child `runGraph` per message.** `wf.executeChild(runGraph, {args:[graph, {message, history}]})`
  → the session reads the reply from the child. Requires **adding `reply?` to `RunGraphResult`** (=
  the `respondToWebhook` body) so the child hands it back — a small, safe additive change. Clean
  isolation; one child run per message (history bounded by the child, not the session).
- **(ii) Session interprets inline.** Duplicates the interpreter in the session workflow — rejected
  (violates interpreter-not-codegen).

### The worth question (decide before building — this is the A4-style check)
Is the long-lived-workflow worth it over a **session-history table** (`ChatMessage` rows keyed by
sessionId, threaded into each per-message `runGraph`)? The table is simpler, n8n-equivalent, and
already gives cross-message memory. The workflow's marginal value is: conversation state lives in
Temporal (survives crashes, pauses for days, no separate store) and enables durable mid-conversation
waits (an approval *inside* a chat turn). That differentiator is real but the table covers 90% of
"chat with memory". **Recommendation:** decide (A) full session workflow — option (i), adds `reply`
to `RunGraphResult` + a `chatSession` workflow + `signalWithStart` in the endpoint; or (B) the
history-table (smaller, ships faster, defer the workflow until durable-in-turn waits are needed).

### 2.2 Retrieval — `vectorUpsert` + `vectorQuery` nodes (pgvector)
- Storage: **pgvector** (we already run Postgres; no new datastore). A `VectorChunk` table
  `{ tenantId, collection, chunkText, embedding vector, metadata }`, tenant-scoped, `ivfflat` index.
- `vectorUpsert` (activity): embed `chunks[]` via the tenant's BYOK embedding model and upsert.
- `vectorQuery` (activity): embed the query, return top-k nearest chunks for the agent's context.
- Both are **activities** (embedding = network I/O; Tier-1 #3). Embedding tokens flow through the
  **same usage ledger** (fail-safe estimate if usage missing) — retrieval spend is metered like
  everything else. BYOK key is fetched + used **in the activity**, never returned/logged.

### 2.3 The reference flow
`chatTrigger → vectorQuery → agent(grounded on retrieved chunks) → respond`. The agent node already
accepts context via `ArgBinding`; the retrieved chunks bind into its system/context input. No new
agent machinery.

## 3. Roadmap — stacked slices

1. **`chatTrigger` node** (DSL + interpreter passthrough + web canvas), no public surface yet —
   exactly the shape of Form Trigger slice 1. Cheap, unblocks the rest.
2. **pgvector + `vectorUpsert`/`vectorQuery`** activities + nodes. Independent of chat; useful
   for any agent flow. Migration adds the `vector` extension + table.
3. **Public chat endpoint + durable session** — `POST /chat/:id` as a Signal into a long-lived
   per-session workflow; reply via Query; budget-cap gate + rate limit reused from forms.
4. **Hosted chat page** at `/c/:chatId` (outside auth) + streaming reply UI + mint URL in
   Integrations — mirrors Form Trigger slice 3.

Out of scope: JMESPath over retrieved docs, re-ranking models, multi-modal/binary embeddings,
non-pgvector stores (Pinecone/etc.) — all later, behind connections.

## 4. Non-negotiables

- Anonymous-spend backstop: registering a chat endpoint REQUIRES a tenant monthly budget cap
  (same rule + reasoning as the Form Trigger endpoint — a public LLM surface needs a spend cap;
  the cap is enforced per-LLM-call by the agent activity's atomic reservation).
- Durable session = Signal + `condition()`, NOT a poll/sleep-loop (Tier-1 #5). Conversation state
  lives in Temporal, not the worker.
- Embedding + retrieval are activities; BYOK keys fetched/used in-activity; embedding tokens
  metered in the usage ledger (never record zero on missing usage).
- The vector store holds tenant content chunks; keep it tenant-scoped and out of Temporal history
  (pass collection refs + top-k results, not the whole corpus).

## 5. Why now (after items?)

Chat + RAG is naary's most marketable AI feature and it **reuses** the Form Trigger public-surface
machinery and the agent/budget infra wholesale — so it's mostly assembly, not new architecture. It
pairs naturally with the items model (retrieve N docs → map the agent over them), but doesn't
depend on it; slices 1–2 can land independently whenever prioritized.
