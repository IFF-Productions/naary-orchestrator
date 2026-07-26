# CLAUDE.md — AI Agent Orchestrator

A durable, platform-agnostic orchestrator for AI-agent + webhook workflows. Users
author workflows on a visual canvas; the canvas compiles to a JSON **graph (DSL)**;
a single generic **Temporal workflow interprets that graph** at runtime. Agent nodes
call LLMs (bring-your-own-key per tenant); tool nodes call MCP servers. The
differentiator over n8n / Flowise / Sim is **durable, long-running, human-in-the-loop
execution** — flows that can pause for days and survive crashes.

---

## TIER 1 — Hard rules (check before every change)

These are architectural non-negotiables. Violating one is a workflow failure, not a
style nit.

1. **Interpreter, not codegen.** One generic Temporal workflow walks graph *data*.
   Prefer extending the interpreter over generating a workflow file per graph.
2. **Workflow code is deterministic.** Keep LLM calls, network/DB I/O, `Date.now()`,
   `Math.random()`, `uuid()`, and non-deterministic iteration **out of** `workflows.ts`
   and the graph-traversal code. Anything non-deterministic belongs in an Activity.
3. **All side effects live in Activities.** LLM, MCP, HTTP, DB, secret reads — Activities only.
4. **Secrets never enter Temporal.** Only `tenantId` may flow through workflow args /
   history. Fetch and decrypt provider keys **inside the activity**, by `tenantId`; use
   in memory; never return them, never log them, never put them in telemetry spans.
5. **Human approval = Signal + `condition()`.** Prefer a durable wait over any polling
   or sleep-loop.
6. **Billing must fail safe.** If token usage is missing/undefined, record a fallback
   estimate — prefer that over recording zero (a zero is a silently-free call).
7. **State lives in Temporal, not the worker.** Workers are stateless and disposable.

---

## Stack

- **TypeScript** (Node 24 LTS — the MAJOR is declared in `/.nvmrc`, which CI and the Dockerfiles
  both read; patch releases float deliberately, so security fixes arrive without a repo change),
  **NestJS** (control plane / HTTP).
- **Temporal** (TS SDK) — durable execution. `@temporalio/{client,worker,workflow,activity,testing}`.
- **Postgres** + **Prisma** — graph definitions, tenant credentials, usage ledger.
  (Temporal owns execution *state*; Postgres owns *definitions* and *records*.)
- **Vercel AI SDK (`ai`, v6)** — the model-call + tool-normalization layer, used
  **inside activities only**. It is NOT the orchestration layer — Temporal is.
- **MCP TypeScript SDK** — MCP *client*, in activities (added in a later slice).
- Local Temporal via `temporal server start-dev`.

> Pin `ai` to an **exact** version (no caret). v6 has a known usage-undefined bug
> (~v6.0.97 via AI Gateway) that breaks billing. If you use Claude Code/Cursor,
> import the AI SDK's own skill so SDK conventions are followed.

---

## Conventions

- **Workflow vs activity split:** the workflow decides *which node runs next* from
  prior outputs + edge conditions; activities *do the work*. If you're tempted to
  `await fetch` in a workflow, that's the signal to move it to an activity.
- **Structured output:** AI SDK v6 unified `generateObject` into `generateText` +
  the `Output` object — prefer `generateText({ output: Output.object({ schema }) })`
  with a Zod schema over the deprecated `generateObject`.
- **Token usage for billing:** use `result.totalUsage` (sums across tool-loop steps);
  `result.usage` is the single-call context meter, not the bill.
- **Error semantics in agent activities:** map provider `401`/`429` (bad/exhausted
  tenant key) to **non-retryable** `ApplicationFailure` — don't burn Temporal retries
  on a credential the user must fix. Let genuine transient errors retry.
- **Graph versioning:** snapshot/content-hash the graph at execution start so editing
  a flow never corrupts in-flight runs. Version *interpreter* changes with
  `workflow.patched()` / Worker Versioning.
- **Payloads:** keep Temporal payloads small (~2MB cap). Large LLM/file outputs go to
  object storage; pass references, not blobs.
- **Privacy:** the usage ledger stores tokens + cost only — never prompt/completion text.

---

## Commands

- Dev Temporal server: `temporal server start-dev`
- Worker: `npm run worker`
- API (NestJS): `npm run start`
- Tests: `npm test`
- Typecheck: `npx tsc --noEmit`
- Prisma: `npx prisma migrate dev`, `npx prisma studio`

---

## How we work

- **Plan before editing.** For anything beyond a trivial single-file change, enter
  plan mode and confirm the plan first. Slice plans live in `PLAN*.md` — follow them
  task by task, in order.
- **Vertical slices, narrow scope.** Build the smallest end-to-end slice that proves
  the next risk. Respect each plan's "OUT of scope" fence — do not build ahead.
- **Verification is the definition of done.** Show evidence (test output, the command
  and its result, the `curl` response) — prefer that over asserting "it works." Each
  task names how to verify it; run that before moving on.
- **Use a review subagent** to check a finished slice's diff against its `PLAN.md`.
  Tell it to flag only gaps affecting correctness, security, or stated requirements —
  not style — to avoid over-engineering.

---

## Security checklist (verify on any change touching keys or usage)

- No API key in workflow args, Temporal history, logs, or telemetry spans.
- `ENCRYPTION_KEY` required at boot; never logged. Key decryption happens in-activity.
- Provider keys are validated on save; `401`/`429` surface to the user, don't loop.
- Usage ledger records tokens/cost only.

---

## Things to watch (we've been bitten here)

- Putting I/O or `Date.now()` in workflow code → nondeterminism errors on replay.
  Prefer activities; if you need time in a workflow, use Temporal's APIs.
- Trusting `result.usage` for billing, or recording zero when usage is undefined.
- Long agent loops growing event history → use `continueAsNew` (later slices).
- Confusing the AI SDK's own durability features (Workflow DevKit) with our Temporal
  layer — prefer Temporal for all durability; the AI SDK is just the model call.
