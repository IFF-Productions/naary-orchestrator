# Conversational AI workflow builder (persisted session, iterative edits)

**Status:** design (doc-first). No schema/code lands with this doc.
**Decisions taken (product Q&A):** the builder is a **persisted, server-side session** (conversation +
graph snapshots, resumable + auditable), and a session **closes on save OR an explicit Done** (whichever
first).

**Depends on:** the streaming build feature (`feat/build-with-ai-streaming`) — this reuses its
incremental generate + SSE frame protocol + live-canvas rendering. That must land first; this is the
next layer on the SAME files (generate path, `/graphs/generate/stream`, `CanvasPage`/`NewAutomation`).

Related: [Chat Trigger + RAG](./CHAT-TRIGGER-RAG.md) (the `ChatMessage` conversation-storage precedent —
distinct feature: that's a runtime chat *trigger*; this is a build-time *editor*), the existing
`GraphGeneratorService`.

---

## 1. Why

Today "Build with AI" is one-shot: a prompt → a whole graph, take it or leave it. Iterating means
re-prompting from scratch. Users want to **converse**: "add a Slack notification after the approval",
"make the trigger a webhook", "remove the email step" — each turn *edits* the current workflow, live on
the canvas, until they're happy. Then the session ends.

## 2. The key reuse — "edit" is already 90% built

`GraphGeneratorService.callModel` already accepts `repair: { previous, error }` — it feeds a PREVIOUS
graph + an instruction back to the model and gets a corrected graph. **An edit turn is the same shape**:
`{ previous: currentGraph, instruction: userMessage }` (no validator error — a user instruction). So
"conversational editing" is: thread the current graph + the conversation into that same free-form,
validate-then-repair pipeline, and STREAM the result (the streaming feature). No new generation engine.

## 3. Session model (persisted, server-side)

New tables (additive migration):

```
model BuilderSession {
  id            String   @id @default(uuid())
  tenantId      String
  environmentId String?          // the env the build targets (promote/save scope)
  workflowKey   String?          // set once saved, or seeded from an existing workflow to edit it
  status        String   @default("open")   // open | closed
  closedReason  String?          // saved | done | abandoned
  currentGraph  Json?            // the working draft (the latest streamed+validated graph)
  title         String?          // a short label (first prompt, trimmed) for the resume list
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  closedAt      DateTime?
  turns         BuilderTurn[]
  @@index([tenantId, status, updatedAt])
}

model BuilderTurn {
  id          String   @id @default(uuid())
  sessionId   String
  role        String            // user | assistant
  content     String            // user prompt, or a short assistant summary of the change
  costUsd     Decimal? @db.Decimal(12,6)  // metered per assistant turn (BYOK)
  createdAt   DateTime @default(now())
  session     BuilderSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  @@index([sessionId, createdAt])
}
```

Notes:
- `currentGraph` is the authoritative working draft — a turn reads it as `previous`, writes the new
  validated graph back. Resume = load `currentGraph` + the turns.
- **Privacy:** unlike the usage ledger (tokens/cost only), a builder session stores **user prompts** by
  necessity. That's the user's own content, tenant-scoped, and **must never reach telemetry/Sentry**
  (scrub) — same Tier-1 §4 posture as other content. BYOK keys are resolved in-request for the model
  call and NEVER stored on the session.
- **Stateless workers hold** (Tier-1 §7): the session lives in the CONTROL PLANE (API/DB). The worker
  is untouched — building a workflow is a control-plane authoring activity, not a run.

## 4. API (tenant-scoped; every route `assertOwner`s the session's tenant)

- `POST /builder/sessions` → open a session. Optional `{ workflowKey }` to seed `currentGraph` from an
  existing workflow (edit an existing flow conversationally). Returns `{ id }`.
- `POST /builder/sessions/:id/turns` → send a message. **SSE**, reusing the streaming frame protocol
  (`meta`/`node`/`edge`/`result`/`error`): runs edit-mode generation with `previous = currentGraph`,
  the conversation, and the new message; streams the edited graph; on success appends the user + a
  short assistant turn and updates `currentGraph`. Meters the model cost into the usage ledger +
  `BuilderTurn.costUsd`. 409 if the session is closed.
- `POST /builder/sessions/:id/close` → `{ reason: "saved" | "done" }`. Idempotent; sets status/closedAt.
- `GET /builder/sessions/:id` → resume: `{ status, currentGraph, turns }`.
- `GET /builder/sessions?status=open` → the caller's open sessions (for a "resume your build?" prompt).

Saving the workflow (the existing canvas save / `POST /graphs`) also calls `close(reason:"saved")` when
it originated from a session — so "save" ends the session without a second action; an explicit **Done**
button closes with `reason:"done"` (discard/keep the draft as the user chooses).

## 5. Lifecycle

open (first message, or "Build with AI") → N edit turns (each streams onto the canvas) → **close** on
save (reason=saved) OR Done (reason=done). A closed session is read-only (resume shows it, editing
starts a NEW session, optionally seeded from its `currentGraph`). A background reaper closes sessions
left `open` and untouched > T (e.g. 24h) as `abandoned` (keeps the resume list clean). Turns per session
are bounded (a hard cap) and every turn passes the existing budget gate.

## 6. Frontend

A **chat panel** beside the canvas (Builder `CanvasPage`; Simple `NewAutomation` gets a lighter inline
version). Open → create a session. Each message → the turn SSE → nodes/edges stream onto the canvas live
(streaming feature) with the playful progress copy. The panel shows the conversation; the canvas shows
the current draft. A **Done** button + the normal **Save** both close the session (and the panel). On
entering the builder for a workflow with an `open` session, offer **Resume**.

## 7. Security & Tier-1
- Session + conversation live in the API/DB (control plane); workers stay stateless.
- BYOK keys resolved in-request, never persisted on the session; secrets never in a turn/graph snapshot.
- Prompts are user content: tenant-scoped, scrubbed from telemetry, never logged raw.
- Every session route is owner-checked (`assertOwner`) like executions/graphs.

## 8. Slices (proposed; each shippable, after the streaming PR lands)
1. **Schema + session CRUD** — `BuilderSession`/`BuilderTurn`, open/get/close/list. No generation yet.
2. **Turn = edit-mode streaming** — `POST /turns` reusing the streaming generate with `previous =
   currentGraph`; append turns; meter cost. (Backend heart of the feature.)
3. **Chat-panel UI** — the conversation surface, live-canvas per turn, Resume, Done + save-closes.
4. **Reaper** for abandoned open sessions (optional) + a "your builds" resume list.

## 9. Verification per slice
- 1: session CRUD unit tests (owner isolation, open→closed idempotency); migration additive.
- 2: edit-turn threads `currentGraph` as `previous`, streams frames, updates `currentGraph`, meters
  cost; 409 on a closed session (mock the generator; a live edit against the dev stack).
- 3: chat send/stream/reconcile; save AND Done both close; resume restores the draft + turns.
