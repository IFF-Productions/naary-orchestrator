# PLAN — Slice: Canvas → DSL compile → run (close the demo loop)

**Goal:** author a workflow on a drag-and-drop canvas, **compile** it to the
`@naary/dsl` `GraphDef`, **save** it (versioned) via a new `POST /graphs`, and
**run** it via `POST /executions` — landing on the run view. Closes the core
product loop: visual editing → durable execution.

Decisions (confirmed): **full drag-and-drop editor**; **save-then-run** contract
(`POST /graphs` then `POST /executions` with the workflowKey).

Editor library: **@xyflow/react** (react-flow v12) — the standard for node editors
(drag, pan/zoom, edge-drawing, selection). Hand-rolling these is large + bug-prone;
react-flow lets the slice focus on the *compile + run* risk, with custom node
components styled to the existing theme.

## Tasks (verifiable core first)
### A. Backend — save-then-run contract
1. `GraphsController` (`POST /graphs`) — body `{ workflowKey, name, graph }` →
   `GraphsService.upsert` (already validates via `validateGraph` → 400 on bad
   graph; content-hashes; versions). Returns `{ workflowKey, version, contentHash }`.
   Register in `GraphsModule`. `@TenantId()` supplies the tenant.
2. `StartExecutionDto` + `ExecutionsService.start` — accept optional `workflowKey`
   (default `"default"`), so the canvas runs the graph it just saved. Tenant-scoped
   exactly as today; unknown key → 404.
3. Tests: `graphs.controller.spec` (save returns version; invalid graph → 400).

### B. Web — pure compiler (unit-tested, the real logic)
4. `lib/graph-model.ts` — editor types: `CanvasNode { id, type, position, config }`,
   `CanvasEdge { id, source, target, condition? }`.
5. `lib/compile-graph.ts` — `compileGraph(nodes, edges): { graph?: GraphDef; error? }`
   → assemble `GraphDef` (startNodeId = the `start`/`webhookTrigger` node), then
   `validateGraph`. Pure, no React.
6. `test/compile-graph.spec.ts` — valid graph compiles; no start node → error;
   dangling edge / unknown target → error (mirrors `validateGraph`).

### C. Web — API client
7. `lib/api.ts` — add `saveGraph(workflowKey, name, graph)` → `POST /graphs`;
   extend `startExecution(workflowKey?)` to pass the key.

### D. Web — the editor (react-flow)
8. `@xyflow/react` dep. Replace `CanvasPage`'s static body with a react-flow editor:
   - **Palette** to add nodes (start, webhookTrigger, agent, mcpTool, humanApproval,
     end); drag to reposition; connect handles to draw edges; delete.
   - **Config panel** for the selected node (per-type fields: agent systemPrompt,
     mcpTool connectionId/tool, edge condition).
   - **Validation status** (live `compileGraph` result).
   - **Run** button → compile → `saveGraph("default", …)` → `startExecution("default")`
     → navigate to `/app/runs/:id`. Surfaces `UnauthorizedError` (sign-in prompt).
   - Custom node components styled with the theme; seed from `sampleGraph` so it
     opens non-empty.

## Out of scope (do NOT build ahead)
- Multiple named workflows / a workflow list wired to the canvas (runs under the
  `"default"` key for now; the seed CLI already has the others).
- Undo/redo, copy/paste, autosave, minimap polish beyond react-flow defaults.
- New node types or interpreter changes — compile only to today's `NodeType`s.

## Verification (DoD)
- **Compiler**: `test/compile-graph.spec.ts` green in the root vitest suite.
- **Backend**: `POST /graphs` then `POST /executions {workflowKey}` against the
  running stack starts a run (api→Temporal→worker); invalid graph → 400; unknown
  key → 404. Controller spec green; full suite + typecheck green.
- **Web**: `pnpm --filter @naary/web build` + the web image build succeed.
- **Manual QA** (can't automate drag): add/connect/edit nodes, click Run, land on
  the run view — documented as the manual step (like the OIDC click-through).

## Security (CLAUDE.md)
- Graph is tenant-scoped (tenant from the token, never the body); `validateGraph`
  rejects malformed graphs before they reach the DB or Temporal.
- No secrets in graph config — agent keys stay BYOK in the activity, by tenantId.
