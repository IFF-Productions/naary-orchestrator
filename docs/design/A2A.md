# Design — A2A (agent-to-agent) readiness (#580 Phase 2)

**Status: design only. Nothing in this document is implemented, and Phase 2 deliberately
ships no code** — the deliverable for #580 Phase 2 is this mapping plus an explicit
recommendation. Phase 1 (the in-graph `handoff` capability) IS implemented; see
`packages/dsl/src/handoff.ts` and the supervisor gallery template.

## Why this is on the roadmap at all

The industry has settled into a two-axis picture, and it is worth being precise about the
axes because they are often conflated:

- **MCP is vertical.** An agent reaching *down* to tools, data, and resources. We already
  do this in both directions: outbound via the `mcpTool` node and an agent's in-loop
  `tools[]`, inbound via `mcpServerTrigger` (a workflow published as a callable tool).
- **A2A is horizontal.** An agent talking *across* to another agent as a peer — an opaque
  collaborator with its own model, prompt, tools, and lifecycle, rather than a function you
  call. The Linux Foundation project passed 150 member orgs in April 2026 and ships inside
  Google, Microsoft, and AWS agent platforms.

The buyer question A2A answers is "can your agents work with the agents we already run?"
The buyer question #580 Phase 1 answers is "can your agents delegate to each other?" —
those are different questions, and Phase 1 answers the one that is actually being asked
today.

## What we already have that this would extend

This is the part that makes A2A cheap for us relative to a greenfield implementation. The
inbound half is not a new subsystem; it is a second protocol dialect over machinery that
exists and is in production:

| Piece | Where it lives | What it already does |
|---|---|---|
| Opt-in publication | `apps/api/src/mcp/mcp-exposed.ts` → `extractMcpServerTool(graph)` | A graph whose **entry node** is `mcpServerTrigger` is published; anything else is not. Publication is a graph-authoring act, not a separate registry. |
| Hosted endpoint | `apps/api/src/mcp/mcp.controller.ts` | `@Public() @All()` `/mcp`, MCP Streamable HTTP (POST / GET-SSE / DELETE), bearer `nry_…` API tokens via `ApiTokenService`, per-tenant + per-environment session resolution, foreign session ids → indistinguishable 404. |
| Tool surface | `apps/api/src/mcp/mcp.server.ts` | One tool per opted-in workflow (`run_<workflowKey>`, name/description from the trigger config, `CAP = 40`), returning `{ runId }` for the caller to poll with `get_run`. |
| Durable task state | Temporal + the `Execution` read model | A run already has a durable identity, a status, a cost, a result, and the ability to sit paused for days. |
| Human-in-the-loop | `humanApproval` + Signal/`condition()` | A run can block on a person and resume — with SLA reminders and escalation. |

## The protocol mapping

A2A's core object is a **task**: a caller sends a message, gets back a task with an id, and
the task moves through a lifecycle until it produces artifacts. Concretely, the pieces line
up like this — and the alignment is better than it has any right to be, because both models
were designed around long-running work rather than request/response:

| A2A concept | Naary equivalent | Notes |
|---|---|---|
| Agent Card (the discovery document: identity, skills, capabilities, auth) | Generated per environment from the graphs whose entry node is a publish trigger | Same input `extractMcpServerTool` already reads. One **skill per published workflow**: id = `workflowKey`, name/description = the trigger's `toolName`/`description`. |
| Skill | A published workflow | We do not need a skill concept; a workflow already is one. |
| Task | An `Execution` (a Temporal workflow run) | 1:1. We already have durable ids, status, and result. |
| `submitted` / `working` | `queued` / `running` | Direct. |
| **`input-required`** | **`awaiting_approval` / `awaiting_webhook`** | **The interesting one.** A2A has a first-class state for "the agent needs something from you before it can finish". Most A2A servers use it for a clarifying question; for us it is a *human approval gate that can hold for days and survive a restart*. This is the single best argument for doing A2A at all — our differentiator is already spelled out in the protocol's own vocabulary. |
| `completed` / `failed` / `canceled` | `completed` / `failed` / `cancelled` | Direct; cancel maps onto the existing cancel path. |
| Artifacts | The run's `respondToWebhook` body, plus object-store references for large outputs | The claim-check pattern (`@naary/storage`) already keeps big payloads out of history — that maps onto artifact parts by reference. |
| Streaming (SSE) | The same transport shape the MCP controller already speaks | Reuse, not rebuild. |
| Push notifications (server → caller webhook) | The notification channel machinery (`@naary/notifications`) | Existing signing/secret handling applies. |
| Authentication | `nry_…` API tokens via `ApiTokenService`, per-token throttling | Already in place for `/mcp`; the A2A spec expects standard HTTP auth schemes, so bearer tokens fit. |

An **outbound** A2A client node (calling *someone else's* agent) is the mirror image and is
mostly a node, not a subsystem: a sibling of `mcpTool` that speaks the A2A task lifecycle,
polls or streams to completion, and lands the artifact in `ctx`. It needs a connection type
(`a2a`), the SSRF/egress allowlist that `@naary/connections` already enforces, and — the one
genuinely new problem — a **remote `input-required` policy**: if the remote agent asks a
question mid-task, does our run pause on a `humanApproval`, answer from config, or fail?
That is a product decision, not a protocol one.

## What would actually be hard

Being honest about this is the point of the exercise; the mapping above makes A2A look
almost free, and it is not.

1. **Session/task state is currently per-API-instance.** `mcp.controller.ts` holds sessions
   in an in-memory `Map`, which needs sticky routing today. A2A tasks are longer-lived and
   more likely to be resumed from a different caller connection, so this would want to move
   to a durable lookup (Temporal is already the task store — the map is just a transport
   cache). This is real work and it is the same work queue-mode wants.
2. **The agent card is a public, uncredentialed document.** It is a directory of what a
   tenant automates. Publication is already opt-in per graph, but a card aggregates them,
   which is a different disclosure than one tool call. It needs an explicit per-environment
   toggle, and the "anonymous-endpoint" review discipline from the embedded-pages work.
3. **Artifact and part semantics.** Our runs return whatever the graph's response node
   produced, typed loosely. A2A artifacts are structured with parts and mime types; mapping
   an arbitrary `respondToWebhook` body onto that faithfully needs a convention, and a
   sloppy one produces a technically-conformant agent that no client can consume.
4. **Spec version pinning.** A2A is moving. Any implementation must pin a spec version in
   the card and in a conformance test suite, and treat the version as a compatibility
   surface — the same lesson as the Temporal SDK version lock.
5. **Two protocols, one endpoint story.** We would be serving MCP *and* A2A over the same
   auth and the same publication opt-in. That is an asset (one mental model for the user)
   but it needs one shared "published workflows" abstraction rather than two drifting
   copies of `extractMcpServerTool`.

## Recommendation — NO-GO on implementing A2A now; GO on a narrow readiness slice

**Do not build A2A yet.** The reasoning, in order of weight:

1. **No demand signal.** #580 is labelled `priority:low` and sourced from a market review,
   not from a user or a deal. Every hour spent on A2A is an hour not spent on the template
   gallery, insights, or the SSO/queue-mode items that customers do ask about. The
   protocol's momentum is real; the *pull* on us is not, yet.
2. **Phase 1 already answers the question buyers actually ask.** "Can agents delegate to
   each other?" is now demonstrable end-to-end with a gallery template, per-agent cost
   attribution, and durable approval gates in the middle of a delegation chain. That is the
   demo. A2A adds *interoperability with other vendors' agents*, which is a different and
   later concern.
3. **The prerequisites are shared with work we want anyway.** Durable session/task lookup
   (point 1 above) is queue-mode's problem too. Doing that work under a "queue mode" or
   "public API" banner pays for itself regardless of whether A2A ever ships.
4. **The mapping is not going to rot.** Because the inbound half is a dialect over
   `mcpServerTrigger` + the hosted endpoint, the cost of waiting is low: nothing about the
   above gets harder if we start in six months. This is the opposite of, say, a data-model
   decision.

**But do these two things now**, because each has standalone value and each is what "ready"
actually means:

- **Keep one publication abstraction.** Any new publish surface (A2A, a public run API, a
  partner integration) must read from `extractMcpServerTool`'s notion of "the entry node
  opts this graph in", not reimplement it. Cheap discipline; prevents the drift in point 5.
- **Treat the run read model as a task API.** When the Execution read model is next touched,
  keep status names and the paused/`input-required` distinction expressible without a join
  — that is the only piece of A2A that touches our core and the only one that is expensive
  to retrofit.

### What would flip this to GO

State the trigger conditions so the decision is reviewable rather than re-litigated:

- A named customer or partner asks to call a naary workflow from their A2A platform
  (Google/Microsoft/AWS agent surfaces), **or** asks us to call theirs; or
- A2A appears in an RFP/security-questionnaire we are actually answering; or
- The durable task-state work lands for queue mode, dropping the inbound cost to roughly
  "an agent-card endpoint plus a lifecycle adapter".

At that point the first slice is: **inbound only, one skill per published workflow, no
streaming, poll-based task status, behind a per-environment flag** — deliberately the same
shape and the same opt-in as the MCP server trigger, so it is a second dialect rather than a
second subsystem.

## Explicitly NOT in scope (for anyone picking this up later)

- No A2A server, no agent card endpoint, no `a2a` connection type, no A2A client node.
- No change to `mcpServerTrigger`, `mcp.controller.ts`, or `mcp.server.ts`.
- No new run/task status values. (If A2A ever needs one, it maps onto existing statuses —
  it does not add to them.)

## Verification

This slice is a document; there is nothing to run. The claims about existing machinery above
are checkable against `apps/api/src/mcp/` (controller, server, `mcp-exposed.ts`) and
`docs/design/MCP-SERVER.md` §5, and the Phase 1 claims against
`packages/dsl/test/handoff.spec.ts` and `apps/worker/test/interpreter-handoff.e2e.spec.ts`.
