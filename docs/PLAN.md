# PLAN.md — Vertical Slice #1: Durable Interpreter Spine

> **For the executing agent:** Work one task at a time, in order. Do **not**
> start a task until the previous task's verification command passes and you've
> shown the output as evidence. If a task is ambiguous, ask before coding. Stay
> in plan mode until this plan is approved.

## 1. Purpose

Prove the single riskiest, most defensible part of the orchestrator: a **generic
Temporal workflow that interprets a graph definition and durably pauses for human
approval, then resumes** — surviving a worker crash while paused. This is the
capability the Sim/n8n/Flowise class of tools cannot do, and it is the
architectural decision that must be correct on day one.

If we can kill the worker while an execution is paused, restart it, send the
approval, and watch it resume to completion — the spine is proven. Everything
else (real LLM agents, MCP tools, a graph loaded from Postgres, the React Flow
canvas, multiple trigger types) layers on in later slices.

## 2. Scope

**In scope (build exactly this, nothing more):**

- A single generic Temporal workflow `runGraph(graph, input)` that walks a graph.
- A **hardcoded, linear** 3-node graph: `start → agent → humanApproval → end`.
- The `agent` node calls a **stubbed** activity (no real LLM — returns canned text).
- The `humanApproval` node pauses on `condition()` awaiting a Signal.
- A NestJS control plane with three endpoints: start, approve, get-state.
- An automated integration test proving pause → signal → resume → complete.
- A documented manual runbook proving crash-resilience (kill worker mid-pause).

**Explicitly OUT of scope for this slice (do NOT build):**

- No React / canvas / any frontend.
- No Postgres or any database (graph is hardcoded in code).
- No real LLM calls, no agent tool-use loop.
- No MCP client.
- No auth, no multi-tenancy, no task-queue routing strategy.
- No branching, parallel, or loop nodes — **linear traversal only**.
- No `continueAsNew`, no graph versioning, no claim-check / S3 offloading.
  (These are noted as future slices in §9; do not implement them now.)

## 3. Architecture constraints (non-negotiable)

These mirror `CLAUDE.md` and must hold even in this tiny slice, because they
establish the pattern everything later depends on:

1. **Interpreter, not codegen.** One generic workflow walks graph *data*. Never
   generate a workflow file per graph.
2. **Workflow code is deterministic.** No LLM calls, no I/O, no `Date.now()`, no
   `Math.random()`, no non-deterministic iteration order inside `workflows.ts`.
3. **All side effects live in Activities.** The stub agent is an Activity even
   though it does nothing real — establish the boundary now.
4. **Human approval = Signal + `condition()`.** Never poll, never sleep-loop.
5. **State lives in Temporal, not the worker.** The whole point: the worker is
   stateless and disposable.

## 4. Prerequisites & stack

- Node.js 20+, TypeScript 5+.
- Temporal dev server running locally. Preferred: `temporal server start-dev`
  (Temporal CLI). Acceptable alternative: a `docker-compose.yml` running the
  Temporal server + UI. Pick one; the CLI is simpler for slice #1.
- Packages: `@temporalio/client`, `@temporalio/worker`, `@temporalio/workflow`,
  `@temporalio/activity`, `@temporalio/testing`; `@nestjs/core`, `@nestjs/common`,
  `@nestjs/platform-express`; `typescript`, `ts-node`, a test runner (`vitest`
  or `jest`).

## 5. Target file layout

```
orchestrator/
  package.json
  tsconfig.json
  README.md                      # run instructions + durability runbook
  src/
    dsl/
      types.ts                   # GraphDef, NodeDef, EdgeDef
      sample-graph.ts            # the hardcoded 3-node linear graph
      walk.ts                    # deterministic node traversal (linear for now)
    temporal/
      shared.ts                  # TASK_QUEUE constant, signal/query definitions
      activities.ts              # runAgentStub
      workflows.ts               # runGraph interpreter
      worker.ts                  # standalone worker process
      client.ts                  # Temporal client factory
    api/
      main.ts                    # NestJS bootstrap
      app.module.ts
      executions/
        executions.module.ts
        executions.service.ts    # wraps Temporal client (start/approve/state)
        executions.controller.ts # POST /executions, POST /:id/approve, GET /:id
  test/
    interpreter.e2e.spec.ts      # pause → signal → resume → complete
    walk.spec.ts                 # traversal order unit test
```

## 6. Tasks

### Task 0 — Scaffold & dependencies
- **Files:** `package.json`, `tsconfig.json`, install deps, npm scripts:
  `start` (NestJS), `worker` (worker process), `test`.
- **Verify:** `npx tsc --noEmit` exits 0. `temporal server start-dev` is
  reachable on `localhost:7233` (show the CLI output / a successful client
  connection log).

### Task 1 — DSL types + sample graph + walk
- **Files:** `src/dsl/types.ts`, `src/dsl/sample-graph.ts`, `src/dsl/walk.ts`.
- `types.ts`: `NodeType = 'start' | 'agent' | 'humanApproval' | 'end'`;
  `NodeDef { id; type; config? }`; `EdgeDef { from; to }`;
  `GraphDef { nodes: NodeDef[]; edges: EdgeDef[]; startNodeId: string }`.
- `sample-graph.ts`: the linear `start → agent → humanApproval → end` graph.
  Give the agent node `config: { canned: "hello from stub agent" }`.
- `walk.ts`: `walk(graph): NodeDef[]` returns nodes in deterministic edge order
  starting from `startNodeId`. Linear only; assume each node has ≤1 outgoing edge.
- **Verify:** `test/walk.spec.ts` asserts `walk(sampleGraph).map(n => n.type)`
  equals `['start','agent','humanApproval','end']`. `npm test` green for this file.

### Task 2 — Stubbed agent activity
- **Files:** `src/temporal/activities.ts`.
- `runAgentStub(config: { canned: string }, input: unknown): Promise<string>` —
  returns `` `[stub-agent] ${config.canned} :: ${JSON.stringify(input)}` ``.
  No LLM, no network.
- **Verify:** unit test (can live in `walk.spec.ts` or its own file) asserts the
  returned string contains the canned text and the serialized input.

### Task 3 — Interpreter workflow + signal + query
- **Files:** `src/temporal/shared.ts`, `src/temporal/workflows.ts`.
- `shared.ts`: `export const TASK_QUEUE = 'orchestrator'`;
  `export const approvalSignal = defineSignal<[{ approved: boolean }]>('approval')`;
  `export const stateQuery = defineQuery<ExecutionState>('state')`.
- `workflows.ts`: implement `runGraph(graph, input)` per the sketch below.
  Reference sketch (refine as needed, keep it deterministic):

  ```ts
  import * as wf from '@temporalio/workflow';
  import type * as activities from './activities';
  import { approvalSignal, stateQuery } from './shared';
  import { walk } from '../dsl/walk';
  import type { GraphDef } from '../dsl/types';

  const { runAgentStub } = wf.proxyActivities<typeof activities>({
    startToCloseTimeout: '1 minute',
    retry: { maximumAttempts: 3 },
  });

  export async function runGraph(graph: GraphDef, input: unknown) {
    const ctx: Record<string, unknown> = { __input: input };
    let approval: { approved: boolean } | undefined;
    let status = 'running';
    let currentNodeId = graph.startNodeId;

    wf.setHandler(approvalSignal, (s) => { approval = s; });
    wf.setHandler(stateQuery, () => ({ status, currentNodeId, ctx }));

    for (const node of walk(graph)) {       // deterministic order
      currentNodeId = node.id;
      switch (node.type) {
        case 'start':
        case 'end':
          break;
        case 'agent':
          ctx[node.id] = await runAgentStub(node.config as any, ctx.__input);
          break;
        case 'humanApproval':
          status = 'awaiting_approval';
          await wf.condition(() => approval !== undefined); // durable pause
          status = 'running';
          if (!approval!.approved) { status = 'rejected'; return { status, ctx }; }
          break;
      }
    }
    status = 'completed';
    return { status, ctx };
  }
  ```
- **Verify:** `npx tsc --noEmit` exits 0. Full behavior is verified in Task 6.

### Task 4 — Worker process
- **Files:** `src/temporal/worker.ts`, `src/temporal/client.ts`.
- `worker.ts`: `Worker.create({ workflowsPath: require.resolve('./workflows'),
  activities, taskQueue: TASK_QUEUE })` then `worker.run()`.
- `client.ts`: factory returning a connected `Client` (used by NestJS + tests).
- **Verify:** `npm run worker` logs that it is polling task queue `orchestrator`
  with no errors. Leave it running for later tasks.

### Task 5 — NestJS control plane
- **Files:** `src/api/main.ts`, `app.module.ts`, `executions/*`.
- `executions.service.ts`:
  - `start(): Promise<{ workflowId }>` → `client.workflow.start(runGraph,
    { args: [sampleGraph, { hello: 'world' }], taskQueue: TASK_QUEUE,
    workflowId: \`exec-${randomUUID()}\` })`.
  - `approve(id, approved)` → `client.workflow.getHandle(id).signal(approvalSignal,
    { approved })`.
  - `getState(id)` → `client.workflow.getHandle(id).query(stateQuery)`.
- `executions.controller.ts`: `POST /executions`, `POST /executions/:id/approve`
  (body `{ approved: boolean }`), `GET /executions/:id`.
- **Verify (worker must be running):**
  1. `curl -XPOST localhost:3000/executions` → returns a `workflowId`.
  2. `curl localhost:3000/executions/<id>` → `status: "awaiting_approval"`.
  3. `curl -XPOST localhost:3000/executions/<id>/approve -H 'content-type:
     application/json' -d '{"approved":true}'` → 202.
  4. `curl localhost:3000/executions/<id>` → `status: "completed"` and `ctx`
     contains the stub-agent output. Show all four outputs.

### Task 6 — Automated e2e test (the real definition of done)
- **Files:** `test/interpreter.e2e.spec.ts` using `@temporalio/testing`.
- Use `TestWorkflowEnvironment.createLocal()`, register a `Worker` against
  `env.nativeConnection`, start `runGraph`, poll `stateQuery` until
  `awaiting_approval`, assert it, send `approvalSignal({ approved: true })`,
  await `handle.result()`, assert `status === 'completed'`.
- Add a second case: `{ approved: false }` → result `status === 'rejected'`.
- **Verify:** `npm test` green, both cases passing. Show the test output.

### Task 7 — Manual durability runbook (documented in README.md)
- **Steps:**
  1. Start dev server + worker + NestJS.
  2. `POST /executions`; confirm `awaiting_approval`.
  3. **Kill the worker process** (Ctrl-C).
  4. `GET /executions/:id` still reports `awaiting_approval` (state is in
     Temporal, not the worker).
  5. **Restart the worker.**
  6. `POST /:id/approve {approved:true}`; `GET` → `completed`.
- **Verify:** the execution completes after the worker was killed and restarted.
  This is the proof the slice exists to produce — capture it in the README.

## 7. Definition of done

- [ ] `npm test` passes (Task 6 e2e: both approve and reject paths).
- [ ] `walk` unit test passes with deterministic order.
- [ ] The four-step manual API flow (Task 5) works end to end.
- [ ] The durability runbook (Task 7) completes after a worker restart.
- [ ] `npx tsc --noEmit` clean; no LLM/MCP/DB/frontend code present.
- [ ] No side effects or non-deterministic calls inside `workflows.ts` or `walk.ts`.

## 8. Verification philosophy

Show evidence, never assert "it works": paste the test runner output, the `curl`
responses, and the worker log lines. After implementation, run a review subagent
against this PLAN.md and report only gaps that affect correctness or the stated
requirements — not style, and nothing outside this slice's scope.

## 9. Next slices (do NOT build now — context only)

1. **Real agent activity** — swap `runAgentStub` for a real LLM call inside an
   activity; add structured-output parsing.
2. **MCP tool node** — add an `mcpTool` node type; MCP client lives in an activity.
3. **Graph from Postgres + per-execution version snapshot** — stop hardcoding the
   graph; snapshot/content-hash it at start so in-flight runs are immune to edits.
4. **Branching / parallel / loop nodes** — generalize `walk` beyond linear;
   `Promise.all` fan-out; introduce `continueAsNew` for long loops.
5. **React Flow canvas** — author the graph visually; compile to the DSL;
   overlay the executed path from Temporal event history as a live trace.
6. **Trigger variety** — webhook controller, Temporal Schedules, external events.
