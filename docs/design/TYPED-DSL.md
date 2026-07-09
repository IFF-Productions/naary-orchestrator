# Design — Type-safe DSL config (one schema per node, shared across packages)

**Status:** proposed · **Date:** 2026-07-08 · **Purpose:** the DSL's node `config` is
untyped (`Record<string, unknown>`), so every consumer — the interpreter, the API, the web
canvas, and the AI generator — re-invents its own idea of what a node's config looks like, and
none of them is enforced. Give each node type ONE schema in `@naary/dsl` and derive everything
else (TS types, runtime validation, JSON Schema for the LLM, form metadata) from it. This is the
principled fix for the empty-config generator bug ([[ai-generate-503-empty-schema]]) and the 35
`as unknown as` casts in the worker.

---

## 1. What naary has today (grounded)

The DSL already has most of the pieces — they're just disconnected:

- **The node enum** — `NodeType` (42 members) in `packages/dsl/src/types.ts`, and
  `CONDITION_OPS`. Exhaustive, enforced.
- **~38 hand-written `*NodeConfig` interfaces** in `types.ts` (`HttpRequestNodeConfig`,
  `SetNodeConfig`, `ApprovalNodeConfig`, …). These are **compile-time only, erased at runtime,
  and wired to nothing** — `NodeDef.config` is typed `Record<string, unknown>`, not a union of
  them. Notably there is **no `AgentNodeConfig`** — the single most important node has no config
  type at all.
- **`NODE_CATALOG`** — `Record<NodeType, { group, summary, config?, entry? }>` in
  `node-catalog.ts`. Exhaustive by construction (`Record<NodeType, …>` makes a missing entry a
  compile error). But `config` is a **prose hint string** (`"{ method, url, headers?, … }"`),
  not a schema — good for a prompt, useless for validation or a form.
- **The worker** (`apps/worker/src/temporal/workflows.ts`) reads `node.config ?? {}` and does
  **35 `as unknown as XNodeConfig` casts** — an unchecked assertion per node kind. A typo in a
  graph (`{ methdo: "GET" }`) sails through to the activity.
- **The generator** (`apps/api/src/graphs/graph-generator.service.ts`) had to abandon JSON-Schema
  structured output and fall back to plain-text + hand-parsing (PR #183) precisely because there
  was no concrete per-node config schema to hand the model — a permissive `config` slot yields an
  empty `{}` from the decoder ([[ai-generate-503-empty-schema]]).
- **`zod` is already a dependency** of `apps/worker`, `apps/api`, and `packages/secrets` — but
  **not** `packages/dsl`. Adding it to the DSL is consistent with the repo, not a new footprint.

**The gap in one line:** the DSL knows *which* nodes exist and enforces that, but not *what shape
each node's config is* — so config correctness is asserted, never checked, in four places
independently.

## 2. The idea — one schema per node, everything derived

Collapse the three parallel lists (the 38 interfaces, the catalog's prose `config` hint, and each
consumer's private assumptions) into **one registry keyed by `NodeType`, where each entry carries
a real runtime schema for its config**:

```ts
// packages/dsl/src/registry.ts  (new)
import { z } from "zod";

export interface NodeSpec {
  group: NodeGroup;
  summary: string;             // (moved from NODE_CATALOG)
  entry?: boolean;
  config: z.ZodTypeAny;        // ← the new part: a real schema, not a hint string
}

export const NODE_REGISTRY = {
  httpRequest: {
    group: "data-source",
    summary: "HTTP/REST call; output {status,headers,body}. Branch on <id>.status.",
    config: z.object({
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
      url: z.string().url(),
      headers: z.record(z.string()).optional(),
      // …the fields already spelled out in HttpRequestNodeConfig, now as schema
    }),
  },
  // …one entry per NodeType
} satisfies Record<NodeType, NodeSpec>;
```

From that single definition, **derive** every consumer's artifact:

| Consumer | Derived from the schema | Replaces today |
|---|---|---|
| **DSL types** | `type HttpRequestConfig = z.infer<typeof NODE_REGISTRY.httpRequest.config>` | the 38 hand-written interfaces (mechanical) |
| **Worker** | `NodeDef` becomes a discriminated union on `type`, so `node.config` is narrowed by `switch (node.type)` | the 35 `as unknown as` casts (compile-time proof, zero runtime cost) |
| **API / save** | `graphSchema.safeParse(graph)` — real per-node config validation | structural-only `validateGraph` |
| **Generator** | `z.toJSONSchema(nodeConfigSchema(type))` (zod v4, native) → **concrete** per-node config properties | plain-text + hand-parse (PR #183); structured output can fill config again |
| **Web** | field list + kinds from `schema.shape` (or a thin `ui` map) → auto-built config panels | hand-maintained panels + `friendly-catalog` |

This answers the thread that motivated it — *"why not JSON schema?"* / *"why not DTOs?"*: JSON
Schema *can* work **once config is typed at the source** — an untyped `config` slot has no concrete
shape to emit, so the decoder returns `{}`. Typing config in the DSL removes that specific cause.

> **Premise TESTED — and it did not hold for structured output (§4, Phase 1b, 2026-07-08).** The
> "type config → structured output fills it" idea was a hypothesis, and the live experiment
> resolved it against a mode switch: the reliable path is **plain-text generation (#183)**, which
> already fills config *and* edges correctly. The #182 empty-**edges** data (edges concretely
> schema'd yet still empty under `Output.object`) plus that result point at the structured-output
> *mode* — not the untyped config slot — as the real generator blocker. **The registry does not
> fix the generator by reviving structured output.** Its generator value is narrower (enrich the
> plain-text prompt with concrete per-node config schema); its real payoff is the worker /
> validation / forms wins below, which stand regardless.

The DSL-typing value stands on its own — it kills the 35 worker casts, adds save-time validation,
and powers forms — **independent of** how the generator experiment resolves.

## 3. The Tier-1 landmine — zod must not run in workflow code

This is the one hard constraint and the design turns on respecting it.

Zod is **runtime** validation. `workflows.ts` and the graph-traversal code are **deterministic**
(CLAUDE.md Tier-1 rule 2) — a `.parse()` there means running validator logic inside the replayable
workflow sandbox, and any version drift in zod's behavior would be a nondeterminism/replay hazard.

**Rule: the interpreter consumes only the erased TYPES, never the schema values.**

- Worker imports **`import type { HttpRequestConfig } from "@naary/dsl"`** — types only, erased at
  compile time. The discriminated union gives it narrowing with **zero runtime zod** in the
  workflow bundle.
- Every actual `.parse()` / `.safeParse()` runs where I/O already lives: **the API** (on save /
  in the generator) and **activities** (defensive parse at the activity boundary, if we want it).
- Enforce it mechanically: the worker's workflow bundle must not import the registry *value*. A
  lint rule / bundle check (`no zod in the workflow entrypoint`) keeps the boundary from eroding.

zod already being a worker dependency (used in activities) is fine — the line isn't "zod in the
worker package," it's "zod evaluated inside `workflows.ts`."

## 4. Migration — incremental, never big-bang

A permissive fallback for not-yet-migrated nodes means every phase ships on its own and no phase
requires touching all 42 nodes at once.

**Phase 1a — DSL schema foundation (done; §6).** `zod` in `@naary/dsl`, concrete schemas that began
with 8 high-value nodes and, in Phase 2·1, now cover **every config-bearing node type** (permissive
fallback only for the 3 config-less entry/exit nodes), derived types with bidirectional parity
guards, and a sanitized `nodeConfigJsonSchema`.

**Phase 1b — the discriminating experiment (RUN 2026-07-08; result below).** The question was
whether concrete config schema revives structured-output generation, or whether the failure is the
`Output.object` *mode* itself. I ran a live generation (PR-review prompt, scoped `nry_` token vs
the live API, row deleted after — the method from [[ai-generate-503-empty-schema]]).

**Result — the deployed generator is already #183 (plain-text `parseGraphJson`, NOT `Output.object`),
and it produced a fully-correct graph:** 6 nodes, 5 edges, every config-bearing node filled with real
values (GitHub `GET`/`POST` URLs, a task-specific agent `systemPrompt`, a 48h `humanApproval`), and
`{{ nodeId.path }}` wiring. So the control confirms **plain-text #183 works**; combined with the
#182 empty-**edges** evidence (edges were concretely schema'd yet still came back empty under
`Output.object`), the conclusion is that the structured-output *mode* was the unreliable part on this
model/gateway — **not** the permissive config slot. Concrete config schema is therefore *not* the
lever that fixes generation.

> **Caveat on rigor:** the control exercised the *deployed* plain-text path (settling #183 = keep),
> not an `Output.object` + concrete-config build (that needs an API image rebuild). Given plain-text
> already meets the goal, forcing the structured-output treatment is low marginal value; it's left as
> an optional confirmation, not a blocker.

**Decision:** keep plain-text #183 as the generation path — do **not** switch back to
`Output.object`. Re-scope the registry's generator value from "revive structured output" to
"**enrich the plain-text prompt**": feed `nodeConfigJsonSchema(type)` (concrete, sanitized) into the
prompt in place of / alongside the prose `config:` hints from `nodeCatalogPrompt()`. The registry's
*durable* wins (worker casts, save-time validation, forms) are unaffected and remain the main
payoff.

**Phase 2 — replace the interfaces + delete the casts.**
*2·1 (done):* the registry now defines a parity-guarded schema + `z.infer` type for every
config-bearing node. *2·2 (next):* delete the 35 `as unknown as` casts in `workflows.ts` via a
runtime-free typed accessor `configOf<T extends NodeType>(node)` mapped from the registry types —
chosen over a `NodeDef` discriminated union, which would ripple through every generic consumer
(`walk`/`canonicalize`/web/API) for little gain. The accessor is type-only, so it can live in
`index.ts` for the worker to use without pulling zod into the workflow bundle.

**Phase 3 — validate on the write path.**
`validateGraph` (or a new `validateGraphConfig`) runs `graphSchema.safeParse` in the API DTO /
save handler, returning per-node, per-field errors instead of a generic reject. Structural checks
in `branch.ts` stay pure and unchanged; config validation is the additive layer.

**Phase 4 — auto-derive the web forms.**
Config panels and the Simple-mode `friendly-catalog` read the schema's `shape` (plus a thin `ui`
hint map for labels/widget kind) instead of being hand-maintained in parallel. Retire the
duplicated field lists.

Each phase is independently shippable and independently reversible.

## 5. Trade-offs & open questions (called out honestly)

- **~38 schemas to write (now written).** Mostly transcription — the interfaces already spelled out
  every field; the permissive fallback kept it a gradual sweep rather than a wall. Done in Phase 2·1.
- **Graph versioning.** Schemas will evolve; an in-flight run's snapshot was validated against an
  older shape. Mitigation: **validate strictly on write, leniently on read** — never re-validate a
  historical graph snapshot against the current schema, and gate interpreter-visible shape changes
  behind `workflow.patched()` / content-hash as we already do for graph edits.
- **A sanitize pass is required, and the prototype proved it** — `z.toJSONSchema` emits an empty
  `{}` for `z.unknown()` and open records (`body`, `outputSchema`, `fields`), which is the exact
  shape Anthropic rejects. `registry.ts` post-processes those into a concrete `anyOf` union
  before the schema reaches the generator. Fewer empty cases than the fully-untyped `config`, but
  not zero — the pass is load-bearing, not optional.
- **Registry value vs. catalog.** `NODE_CATALOG` (prose `config` hint) can be *generated from* the
  registry (`nodeCatalogPrompt()` reads schema field names), or kept as the summary layer with the
  schema alongside. Recommend: fold `group`/`summary`/`entry` into `NODE_REGISTRY` and derive the
  prompt text, so there's genuinely one source.
- **Bundle discipline is load-bearing.** If zod ever leaks into the workflow entrypoint, Tier-1
  rule 2 is silently violated. This needs a guard (lint/bundle assertion), not just a convention.

## 6. Status (shipped so far)

Phases 1a + 1b + 2·1 are built and green — `packages/dsl/src/registry.ts` + `test/registry.spec.ts`
+ `test/registry-corpus.spec.ts`, `tsc -b` clean, full dsl suite **144/144** (PR #184):

- `zod` in `@naary/dsl`; concrete `config` schemas for **all 38 config-bearing node types** +
  permissive fallback for the 3 config-less ones (`nodeConfigSchema(type)`, own-property lookup so a
  hostile deserialized `type` can't reach the prototype chain).
- Derived TS types (`z.infer`) with **bidirectional type-equivalence guards** (`Exact<A,B>`,
  enforced by `tsc -b`) against every interface-backed node — not a single-literal `satisfies`
  check. These caught two **real divergences**: the naïve `z.enum(CONDITION_OPS)` widened `op` to
  `string` (fixed with a literal-preserving, completeness-guarded op tuple), and the interface-less
  `agent` schema requiring `provider/model/systemPrompt` that the runtime actually **defaults**
  (would have rejected valid graphs on save). So Phase 2·2 can swap interfaces for inferred types
  with build-enforced safety, not hope.
- **Runtime acceptance proven, not just type parity** — a corpus round-trip `safeParse`s every node
  config across all 10 in-repo sample/template graphs (plus an explicit number-keyed `paramBindings`
  case), so wiring a save-gate can't reject a known-good workflow.
- `nodeConfigJsonSchema(type)` → concrete, **Anthropic-safe** JSON Schema (the sanitize pass
  above), verified by a deep "no empty `{}` anywhere" assertion — which itself surfaced the
  `z.unknown()` → `{}` gotcha and proved the sanitize pass necessary.
- `index.ts` deliberately does **not** re-export `registry.ts`, so the worker's `@naary/dsl`
  surface stays zod-free (Tier-1 rule 2 honored by construction).

Phase 1b (the generator experiment) **ran** and settled #183 — see §4. Remaining: Phase 2·2 (kill
the worker casts), Phase 3 (validate on save), Phase 4 (auto-derive forms).

## 7. Recommendation

Phase 1a (the DSL schema foundation) is landed and worth shipping on its own — it's the base every
later phase builds on and its payoffs (killing the 35 worker casts, save-time validation, forms)
don't depend on the generator. Phase 1b **ran** and settled the generator question: **keep
plain-text #183** (it fills config + edges correctly); the registry does not need to switch the
generator back to structured output. So the sequencing is: ship 1a, merge #183, then take Phases
2–4 as independent slices (replace interfaces / kill casts → validate on write → auto-derive
forms), each paying down one of the four disconnected consumers — with the generator left on its
working plain-text path and optionally enriched by the registry's per-node schema in the prompt.
