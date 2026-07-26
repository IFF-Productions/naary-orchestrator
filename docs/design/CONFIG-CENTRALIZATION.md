# Design — one place to read config

**Goal:** stop reading `process.env` from arbitrary modules, so what this system is configured by is
readable in one file per package instead of inferred from 99 call sites.

This is a plan, not a completed change. The measurements below are what turned a one-PR sweep into a
staged one — three of the five packages **cannot** share a single module, and the obvious
implementation (exported constants) would trade readability for a class of boot-order bugs.

## What's actually there

Measured, not estimated (`grep -rn 'process\.env' --include='*.ts' --include='*.tsx'`, tests excluded):

| Package | `process.env` reads | Can it share a module? |
| --- | ---: | --- |
| `apps/api` | 41 | yes — `src/env.ts` already exists |
| `packages/*` | 32 | **no** — see below |
| `apps/worker` | 15 | yes, its own |
| `apps/web` | 9 | **no** — different mechanism entirely |
| `apps/sandbox-runner` | 2 | **no** — already has `src/config.ts` |

**71 distinct variable names.** The most-read:

| Reads | Var |
| ---: | --- |
| 29 | `ENCRYPTION_KEY` |
| 18 | `APP_BASE_URL` |
| 12 | `CORS_ORIGINS` |
| 12 | `CODE_AGENT_SANDBOX_READ` |
| 9 | `DATABASE_URL` |
| 7 | `REQUIRE_MFA` |

`ENCRYPTION_KEY` at 29 sites is the clearest argument for doing this: a secret whose read path is
spread across two apps and several packages is hard to reason about and harder to rotate.

## What `apps/api/src/env.ts` is today

A **dotenv loader plus a boot validator for two variables** (`ENCRYPTION_KEY`, `DATABASE_URL`), imported
first in `main.ts` so it runs before any `@naary/*` module evaluates. It is not an accessor layer, and
nothing else reads config through it.

That existing "import me FIRST" contract is the crux of the design decision below.

## The decision: lazy accessors, not exported constants

The obvious shape is wrong:

```ts
// DON'T
export const CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://localhost:5173";
```

That evaluates **at import time**, which breaks two things this codebase currently gets right:

1. **Boot order becomes load-bearing everywhere.** `env.ts` exists precisely because dotenv must run
   before anything reads config. Turn 71 variables into module-level constants and every one of them
   inherits that ordering requirement — an import moved innocently to the top of a file reads
   `undefined`, and nothing fails loudly.
2. **Test seams disappear.** Several sites read at call time *on purpose* so a test can set and restore
   `process.env` — `platformOperatorEmails(env = process.env)` takes an injectable env, and
   `getObjectStore()` reads on first call. Freezing those at import makes them untestable without module
   resets.

So: **functions**, with the injectable-env parameter that the newer code already uses.

```ts
// apps/api/src/config.ts
export function corsOrigins(env = process.env): string[] { … }
export function requireMfa(env = process.env): boolean { … }
```

The win is the same — one file lists every variable, with its parsing, default, and *why* — without
making import order a correctness property.

## Why three packages can't share one module

- **`packages/*` (32 reads).** `storage`, `secrets`, `flags`, `observability` are consumed by **both**
  `apps/api` and `apps/worker`. Importing an app's config module would invert the dependency direction.
  Each package that reads config gets its own local `config.ts`; a shared `packages/config` is possible
  later but only earns its place if duplication actually appears.
- **`apps/sandbox-runner` (2 reads).** It builds standalone with plain `npm install` and **cannot take
  `workspace:*` deps** — the same reason it has no Sentry and no shared logger. It already centralises
  in `src/config.ts`; leave it alone.
- **`apps/web` (9 reads).** Uses Vite's `import.meta.env`, which is **build-time substitution**, not a
  runtime environment. Different mechanism, different failure modes, and no secrets by construction. Out
  of scope.

Verified along the way: **no `process.env` read in `apps/worker/src/temporal/workflow/`**. Good — an env
read in workflow code would be nondeterminism on replay (CLAUDE.md Tier-1 §2). Any slice touching the
worker must keep it that way.

## Constants, separately

The second half of the request. Constants are a smaller and less risky job than env, but the same
"one place" instinct applies with one caveat: **a constant belongs beside the invariant it encodes, not
in a bucket named `constants.ts`.** `MAX_ASSET_BYTES` next to the sniffer that enforces it, or
`WORKER_STALE_MS` next to the staleness check, is more readable than either in a shared file — the
comment explaining *why* 512 KB travels with the code that depends on it.

What's worth centralising is the narrower set that is genuinely **cross-cutting** — values two or more
packages must agree on, where drift is a real bug. `TASK_QUEUE` already lives in `@naary/contracts` for
exactly that reason. That's the model: promote a constant when a second consumer appears, not before.

## Slices

Ordered by value per unit of risk. Each is independently mergeable and independently revertable.

1. **`apps/api` (41 reads).** Extend `env.ts` into a typed accessor module (or add `config.ts` beside
   it, keeping `env.ts` as the loader/validator it already is) and migrate call sites. Biggest single
   win; no cross-package coordination.
2. **`apps/worker` (15 reads).** Same shape, its own module. Must preserve the "nothing in `workflow/`"
   property.
3. **`packages/*` (32 reads).** Per-package `config.ts`. Do it last: it's the most files and the least
   concentrated benefit, and by then the accessor shape will have proven itself twice.
4. **Cross-cutting constants.** Audit for values duplicated across packages and promote only those to
   `@naary/contracts`, where `TASK_QUEUE` already is.

Each slice is mechanical but wide, so each wants its own PR with the full suite green — a sweep this
broad hiding a real behaviour change in the noise is the main risk to manage.
