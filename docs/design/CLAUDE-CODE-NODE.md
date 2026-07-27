# Design: `claudeCode` node — run Claude Code inside a workflow

Status: **DESIGN (doc-first, pre-code)**. Destination is a full read/write node that
clones a repo, lets Claude Code edit it, and opens a PR. This doc specifies the whole
program and **slices it so the dangerous boundary (the sandbox) ships and is proven
first** — before any credentialed VCS-write flow rides on top of it.

Related: [APP-AUTH](./APP-AUTH.md) (GitHub App installation tokens — the VCS-write
credential), [N8N-PARITY-GAPS](./N8N-PARITY-GAPS.md) (nodes), the `agent` node
(`runAgent`) is the activity template.

---

## 0. Summary

A new node type `claudeCode` runs a headless Claude Code session (`claude -p`) as a
Temporal **activity**, billed to the tenant's **own Anthropic key** (BYOK, same model as
the `agent` node). At its destination it can: clone a repo → let the model read/edit/run
Bash → commit → push a branch → open a PR. That is **arbitrary code execution with
credentials in scope**, so the design is organised around a **threat model** (§2) and a
**sandbox boundary** (§3), not around the node config.

Two decisions are already made (user):
- **Execution surface: subprocess `claude -p`** (not the in-process Agent SDK). Rationale
  in §4 — per-call `ANTHROPIC_API_KEY` env avoids a cross-tenant key race that the
  in-process SDK's shared `process.env` would create, and it gives process isolation for
  the model's Bash/Edit tools.
- **Capability destination: full read/write + commit/PR.** But per §6 this is the
  *program's* destination; **Slice 1 is read-only** and exists to prove the sandbox.

One decision is **open and needs the user's infra call** (§3): the sandbox isolation
boundary. It is framed as *isolation × egress policy × credential lifetime*, not "which
container tech."

---

## 1. Where it fits (mirrors the `agent` node)

The interpreter resolves node config in the deterministic workflow, then a
`callClaudeCode` activity does the work — the exact `runAgent` envelope:

- **BYOK key, in-activity:** `CredentialsService.getDecryptedKey(tenantId, "anthropic")`
  — decrypted in memory, never returned across the workflow boundary, never logged.
- **Fail-safe usage:** read the headless JSON envelope's `total_usage` /
  `total_cost_usd`; feed `recordUsage` (idempotent upsert on `executionId,nodeId`); fall
  back to a char/4 estimate so a run is **never billed at zero** (Tier-1 rule 6).
- **Error mapping:** `MissingCredentialError` / 401 / 403 → non-retryable `AUTH`; 429 →
  `QUOTA`; anything else → a **sanitized** retryable (`toSanitizedRetryable`) so a
  subprocess/SDK error can't echo the key or env into Temporal history/logs.
- **Determinism / at-most-once:** its own `proxyActivities` block, `startToCloseTimeout`
  in minutes (like `mapNode`'s 40m), `maximumAttempts: 1` (it has side effects — commits,
  PRs), and a `heartbeatTimeout` + `Context.heartbeat()` so a stuck subprocess is
  detected (a new pattern for this repo — no activity heartbeats today).

Files a node type touches (the `mcpTool` checklist, self-enforced by the `NODE_CATALOG`
`Record<NodeType,…>` and `NodeConfigMap` compile guards): `packages/dsl/src/{types.ts,
registry.ts (+parity guard), node-config.ts, node-catalog.ts}`, worker
`temporal/{activities.ts, workflows.ts (proxy block + case)}`, web
`{lib/graph-model.ts, lib/friendly-catalog.ts, screens/CanvasPage.tsx (config panel +
ERRORABLE_KINDS; NOT RETRYABLE_KINDS — a side-effecting run is at-most-once)}`. Save-time
validation is automatic once the `registry.ts` zod schema exists.

---

## 2. Threat model (the centre of this design)

`claude -p` with Bash + network access, pointed at a repo or prompt that may contain
**third-party content**, can attempt to **exfiltrate every credential in its
environment**. The design must contain this, not footnote it.

### 2.1 Who is trusted

- **Self-authored, self-targeted run** (tenant writes a workflow that runs Claude Code on
  the tenant's own repo with the tenant's own key): largely self-sovereign. The blast
  radius is the tenant's own resources.
- **Third-party-triggered run is the real escalation.** The headline use cases —
  *"auto-review incoming PRs"*, *"run Claude Code from a public webhook"* — mean the
  **prompt and/or the cloned repo are attacker-controlled**. Combined with BYOK creds +
  Bash, that is an adversarial setting. The doc's job is to make that setting safe.

### 2.2 Vector A — GitHub token leaks via the git remote

If the sandbox clones with `https://x-access-token:TOKEN@github.com/…`, then a single
`git remote -v` or `cat .git/config` hands the installation token to the model — and to
anything an attacker-controlled repo/prompt induces the model to run.

**Mitigation — split the trust into two boxes:**
- **Inside the sandbox, Claude Code only edits files.** It gets a plain working tree (no
  git remote with an embedded token, ideally no `.git` credential material at all).
- **Outside the sandbox, the activity does all VCS I/O** — clone, branch, commit, push,
  open PR — with the installation token that **never enters the sandbox env**.

That one split turns "untrusted code execution" and "credentialed VCS write" into two
separate boxes. The token's lifetime and reach are bounded to the activity process.

### 2.3 Vector B — the Anthropic key must live in the sandbox

Claude Code needs `ANTHROPIC_API_KEY` to run, so unlike the git token it **cannot be
removed** — only **contained**. Containment = **egress allowlist**: the sandbox may reach
`api.anthropic.com` (and nothing else). No arbitrary outbound network. So even a fully
hijacked run cannot POST the key to an attacker endpoint, and cannot reach internal
services (SSRF). This reuses the project's existing egress-hardening posture
(`BlockedEgressError`, SSRF guards) applied to the sandbox network.

### 2.4 Non-goals / accepted risks (stated, not hidden)

- The tenant's own key running on the tenant's own repo can still be "wasted" by an
  adversarial prompt (burn tokens). Bounded by `--max-turns` / `--max-budget-usd` and the
  monthly cap reservation.
- A malicious *tenant* is not the threat model here (they already own their key + repo);
  the threat model is a malicious **third party** influencing a legitimate tenant's run.

---

## 3. Sandbox architecture — the open decision (isolation × egress × credential lifetime)

The sandbox decision is **not** "Docker vs Firecracker." Evaluate every option on three
axes:

1. **Isolation boundary** — can the model's Bash escape to the host / other tenants' runs?
2. **Egress policy** — can it reach anything but `api.anthropic.com`?
3. **Credential lifetime** — how briefly does the Anthropic key exist, and is the git
   token provably *absent*?

### Options

| Option | Isolation | Egress control | Notes |
|---|---|---|---|
| **A. Run in the worker container** (restricted tools) | ❌ shares the worker's process/FS/network | weak (worker's own network) | Simplest, but the model's Bash runs beside the worker + every tenant key in flight. Only acceptable for the **read-only** Slice 1 with tools clamped to `Read,Grep,Glob` and no Bash. **Not** acceptable for write/Bash. |
| **B. Worker spawns sibling containers (Docker socket)** | ⚠️ **worse than it looks** | per-container network | Mounting the Docker socket into the worker is **host-root escalation** — a hijacked run can create a privileged container and own the host. **Rejected** as the write-mode boundary. |
| **C. Dedicated sandbox pool/service the activity dispatches to** (recommended) | ✅ separate hosts/pods, no host-root path from the worker | per-sandbox network policy → allowlist `api.anthropic.com` | The activity POSTs {working tree, prompt, key} to a sandbox worker that runs `claude -p` and returns the edited tree/diff. Clean two-box split (§2.2): the sandbox never holds the git token; the activity never runs the model. |
| **D. microVM / gVisor per run** (Firecracker, etc.) | ✅✅ strongest | per-VM | The hardened version of C; more infra. A later hardening slice, not the MVP boundary. |

**Recommendation: C** (dispatch to an isolated sandbox pool), hardenable to **D**. It is
the only option that simultaneously gives real isolation, a place to pin the egress
allowlist, and the §2.2 credential split — without Option B's host-root footgun.

**This is the user's infra call** (it implies standing up a sandbox pool / choosing a
provider). It is called out as **Open Decision #1** in §8. Slice 1 (read-only, Option A
with clamped tools) does **not** require it, which is exactly why Slice 1 goes first.

---

## 4. Execution surface — subprocess `claude -p` (decided)

```
execFile("claude", [
  "-p", resolvedPrompt,
  "--output-format", "json",
  "--permission-mode", mode,          // "plan" (S1 read-only) → "acceptEdits" (write)
  "--allowedTools", tools,            // clamped per slice
  "--max-turns", String(maxTurns),
  "--max-budget-usd", String(cap),    // hard cost stop
], {
  cwd: workingTree,                    // the sandbox working dir (NO git remote w/ token)
  env: { ...MINIMAL, ANTHROPIC_API_KEY: tenantKey },  // per-call env, not process.env
  timeout: startToCloseBudget,
})
// → parse { result, total_usage, total_cost_usd, is_error, num_turns }
```

Why subprocess over the in-process Agent SDK: the SDK reads a **shared `process.env`** for
the key, which races across concurrent per-tenant activities in one worker; a per-`execFile`
`env` is isolated. Subprocess also process-isolates the model's Bash/Edit. Cost: the
`claude` binary must be in the sandbox image, and errors are exit-code + JSON (handled by
§1's sanitized mapping). Use `--output-format json`; check **`is_error`** even on exit 0.

---

## 5. Durability & correctness

- **`maximumAttempts: 1`** — commits/PRs are side effects; never auto-retry a partial
  write. Genuine transient *pre-side-effect* failures surface to the run's `onError`.
- **Heartbeat** a long run (`Context.heartbeat()` from the stream) so a hung subprocess is
  killed by `heartbeatTimeout` rather than sitting to the full `startToCloseTimeout`.
- **Idempotent branch + PR** — derive the branch name deterministically from
  `executionId + nodeId`; **"PR already exists → reuse it"**, never open a duplicate. This
  is not theoretical: we just fixed a bug (PR #262) proving **the same trigger fires
  twice** in this system — a claudeCode node that opens a duplicate PR on a redelivery is
  the same bug class.
- **Payloads via claim-check** — the working tree / diff / model output go to object
  storage; only references flow through Temporal history (2MB cap, Tier-1 payload rule).
- **Privacy** — the usage ledger records tokens + cost only, never prompt/diff text.

---

## 6. Slices

Each slice is the smallest end-to-end step that proves the next risk.

- **Slice 1 — Sandbox + a proven-isolated read-only run.** The node type end-to-end
  (schema → catalog → interpreter case → `callClaudeCode` activity → BYOK key → usage →
  UI), running `claude -p --permission-mode plan` with tools clamped to `Read,Grep,Glob`,
  **no Bash, no writes, no repo clone** (operates on an inline/attached working set or a
  read-only checkout). **Goal: prove the plumbing + the read-only posture** — BYOK key
  containment, usage recording, heartbeat/timeout, and that a clamped toolset genuinely
  can't write or shell out — before any credentialed write rides on it. Verifiable under
  **Option A** (worker-container) *precisely because* the model can't write or shell out, so
  its weak egress control isn't yet load-bearing. **The `api.anthropic.com` egress allowlist
  is NOT proven here** — it requires the Option-C sandbox and lands with Slice 2 / the §5
  hardening slice. (So Slice 1 proves isolation-by-capability-clamp, not isolation-by-network.)
- **Slice 2 — Repo clone (read) + write in the sandbox, diff captured.** Activity clones
  via the App token (read) into the sandbox working tree **with the git remote/token
  stripped** (§2.2), runs `--permission-mode acceptEdits`, captures the resulting diff to
  claim-check storage. Still **no push/PR** — output is the proposed diff. Requires the
  Option-C sandbox (Open Decision #1).
- **Slice 3 — Commit → push branch → open PR (idempotent).** The activity (outside the
  sandbox) applies the diff, commits, pushes a deterministic branch, opens/reuses a PR via
  the installation token. Reuses [APP-AUTH](./APP-AUTH.md) token minting.
- **Slice 4 — Canvas/config UX.** Full inspector (repo/connection picker, prompt +
  bindings, tool/permission selector, cost caps), catalog polish, error-handling wiring.
- **Slice 5 — Egress + isolation hardening.** Enforce the `api.anthropic.com` allowlist at
  the sandbox network layer; optionally move Option C → D (microVM). Adversarial tests
  (§2 vectors).

---

## 7. Node config (shape, refined per slice)

```ts
interface ClaudeCodeNodeConfig {
  prompt: string;                 // {{ upstream.output }} templating for free
  systemPrompt?: string;          // → --append-system-prompt
  model?: string;                 // defaults to the tenant's Anthropic default
  permissionMode?: "plan" | "acceptEdits";   // S1 forces "plan"
  allowedTools?: string[];        // clamped/validated per slice
  maxTurns?: number;
  maxBudgetUsd?: number;          // hard cost stop
  timeoutMs?: number;
  // Slice 2+: what to operate on
  repo?: { connectionId: string; ref?: string };   // via App-auth connection
  // Slice 3+: PR target
  pr?: { baseBranch?: string; titleTemplate?: string };
  costUsd?: number;               // manual fallback cost (fail-safe)
}
```

Template expressions (`{{ nodeId.path }}`) are resolved by the deterministic
`resolveTemplates` before the activity is called, so `prompt` gets upstream interpolation
for free; a dedicated binding resolver is only needed if we add `promptBindings`.

---

## 8. Open decisions

1. **Sandbox isolation boundary (infra call — user).** Recommendation: Option C
   (dispatch to an isolated sandbox pool with an `api.anthropic.com` egress allowlist),
   hardenable to D (microVM). Blocks Slice 2+; **Slice 1 does not need it**.
2. **Read-only Slice-1 working set.** Inline attachment vs a read-only checkout of a
   connected repo. Leaning inline (no VCS surface at all in S1).
3. **Cost-cap semantics.** Does a claudeCode run count against the tenant monthly cap
   reservation (like `runAgent`), or only its own `maxBudgetUsd`? Leaning: both — reserve
   against the monthly cap, plus a per-node hard stop.

---

## 8b. Addendum — requirements update (ephemeral container-per-run + interactive Q&A)

Two requirements were added after the original design; they refine, not replace, §3–§7.

### 8b.1 Sandbox = ephemeral container **per run** (chosen: Option C, realized)

The user chose the full-feature sandbox and framed it concretely: **spin up N Claude Code
containers, one per workflow run, each independent** ("like an interactive session, but
boxed"). Temporal already gives the independence — each run is its own workflow execution,
so N concurrent runs = N concurrent `callClaudeCode` activities. Each activity launches its
**own throwaway container**; there is no shared long-lived sandbox to multiplex.

**Realization on the current single-Docker-host deploy — a dedicated sandbox-runner
service (NOT the worker):**

```
worker (callClaudeCode activity)              sandbox-runner service (has Docker access)
  ─ POST {workingTree ref, prompt, key,  ───▶   docker run --rm \
     sessionId?, limits}                          --network naary-sandbox-egress \   (allowlist: api.anthropic.com)
                                                   --cpus … --memory … --pids-limit … \
                                                   --read-only + tmpfs workdir \
  ◀─ {diff|result, questions?, sessionId, ───     naary-claude-sandbox   (claude -p)
     usage}
  ─ (outside the sandbox) clone/commit/push/PR with the App token
```

- **Why a separate runner, not the worker:** mounting the Docker socket into the worker is
  host-root escalation (§3 Option B, rejected). Confining Docker access to one small runner
  service keeps that blast radius off the worker (which holds every tenant key in flight)
  and preserves the §2.2 two-box credential split — the **git token never enters any
  sandbox container**; the runner only ever receives the Anthropic key + working tree.
- **Egress:** the sandbox container joins an **internal Docker network with no default
  route**, plus an allowlist proxy to `api.anthropic.com` (Vector B, §2.3). Even a hijacked
  run can't POST the key out or reach internal services.
- **Ephemeral + bounded:** `--rm`, `--read-only` root + a `tmpfs`/volume for the working
  tree, cpu/memory/`--pids-limit`, and a wall-clock timeout ≤ the activity
  `startToCloseTimeout`. Nothing persists between runs.
- **This is still Open Decision #1's answer**: own-Docker-host via a runner service. A
  sandbox-as-a-service (e2b/Modal/Fly Machines/k8s Jobs) is a drop-in alternative behind the
  same `POST → {diff}` contract if the host approach is later outgrown — the worker activity
  is unchanged.

### 8b.2 Interactive Q&A — pause for user input, with a notification (built into the node)

`claude -p` is one-shot, but supports session resume (`claude -p --resume <session_id>
"<answers>"`). The node runs an **ask → pause → answer → resume** loop, using the SAME
durable pause the `humanApproval` / `wait(webhook)` nodes already use (Signal +
`wf.condition()` — survives crashes/days, no polling; `resumeSignal` already carries a
payload):

```
loop:
  { result, questions?, session_id, usage } = callClaudeCode({ …, sessionId })   // activity
  recordUsage(...)                                                                // every turn, fail-safe
  if !questions: break                        // model produced the diff/PR-ready result
  status = "awaiting_input"
  emit sendNotification({ kind: "input_needed", questions, answerUrl })  // Slack/Teams (§ shipped)
  await wf.condition(() => answers !== undefined)   // durable pause (humanInput signal)
  sessionId := session_id                     // resume the SAME claude session with the answers
```

- **Getting questions OUT of a headless run:** the system prompt instructs the model, when
  it lacks information it can't safely assume, to end its turn by emitting a structured
  `{ "needs_input": true, "questions": [...] }` instead of guessing. The activity parses that
  from the `--output-format json` envelope (alongside `is_error`, `total_usage`).
- **Answer surface — two ways (both):** (a) **in-app** on the run detail screen (the run is
  `awaiting_input`, like an approval), and (b) a **signed public answer link** in a
  **Slack/Teams notification** — reusing the notification system + the signed-link pattern
  from the `/approve` page (a new `input_needed` notification kind with an "Answer" button).
  This is why the user asked for "the option of posting a notification": the pause pings the
  reviewer wherever they are.
- **Determinism:** `session_id` + subprocess are non-deterministic → they live in the
  activity's input/output; the loop + pause live in the deterministic workflow, driven by
  activity results + the `humanInput` signal. New signal `humanInputSignal` (payload =
  answers), mirroring `approvalSignal`/`resumeSignal`.
- **New status `awaiting_input`** joins `awaiting_approval` / `awaiting_webhook` in the
  read-model + UI (`RunSummary` status union, `runStatusUi`).

### 8b.3 Revised slices (fold the two additions in)

- **Slice 1** — unchanged (read-only, no sandbox, proves plumbing). Buildable **now**.
- **Slice 2** — **sandbox-runner service** + ephemeral container-per-run; clone (read) into
  the sandbox with the git remote/token stripped; capture the diff. (Was "Option-C sandbox".)
- **Slice 3** — commit → push → **open/reuse PR, return the PR number** (idempotent).
- **Slice 3b (new)** — the **interactive Q&A loop**: `needs_input` parsing, `awaiting_input`
  status + `humanInputSignal`, the in-app answer UI, and the `input_needed` Slack/Teams
  notification with a signed answer link.
- **Slice 4 / 5** — canvas UX / egress+isolation hardening, unchanged.

### 8b.4 Auth note

The node authenticates `claude -p` with the **tenant's Anthropic API key (BYOK)**, exactly
like the `agent` node — separate from any personal Claude *subscription*. A subscription
`CLAUDE_CODE_OAUTH_TOKEN` could back it later, but BYOK is the multi-tenant default. (Auth is
**per-driver** — see §8c; Cursor/Copilot bring their own credential.)

### 8b.5 Not Claude-only — a multi-CLI **driver** abstraction (see §8c)

The node is **tool-agnostic**: the destination is to run *any* agentic coding CLI (Claude
Code, Cursor CLI, GitHub Copilot CLI) via a pluggable driver. Everything above (ephemeral
container-per-run, the two-box git-token split, the ask→pause→resume loop, PR idempotency)
is **driver-independent** — only the in-container command, auth env, output parsing, and
resume mechanism vary. Claude Code is driver #1; the seam is built from the start so adding
Cursor/Copilot is a new adapter, not a new node.

---

## 8c. CLI-driver abstraction (multi-tool: claude · cursor · copilot)

The node type carries a `tool` selector; a **driver registry** maps it to an adapter. This
mirrors the codebase's integration-catalog philosophy (adding a tool = a catalog entry +
image + auth mapping, not a new node type). The sandbox-runner stays CLI-agnostic — it's
handed an image + command + env and returns the diff/output; the **driver** owns what's
CLI-specific.

### Driver interface (what each adapter provides)

```ts
interface CliAgentDriver {
  tool: "claude" | "cursor" | "copilot";
  image: string;                 // container image with the CLI installed (per-tool or shared)
  // Build the argv for a headless, non-interactive run (+ a resume variant if supported).
  invoke(opts: { prompt: string; workdir: string; sessionId?: string; limits: Limits }): string[];
  // Auth env injected into the container (per-tool secret; git token NEVER included).
  authEnv(cred: TenantCredential): Record<string, string>;
  // Parse the CLI's output → a normalized envelope the workflow understands.
  parse(stdout: string, exitCode: number): {
    result?: string; diff?: string;
    questions?: string[];        // structured "needs input" (drives the Q&A pause)
    sessionId?: string;          // for --resume, if the CLI supports it
    usage?: { costUsd?: number; tokens?: number };
    isError: boolean;
  };
  capabilities: { headless: boolean; resume: boolean; structuredQuestions: boolean };
}
```

### Capability reality per CLI (honest, drives what each supports)

| Driver | Headless | Resume (Q&A loop) | Structured output | Auth | Notes |
|---|---|---|---|---|---|
| **claude** (Claude Code) | ✅ `claude -p` | ✅ `--resume <id>` | ✅ **schema-enforced** — `--json-schema <schema>`, parsed answer on `structured_output` | Anthropic BYOK key (or `CLAUDE_CODE_OAUTH_TOKEN`) | Reference driver — full ask→pause→resume + fail-safe usage. Driver #1. |
| **cursor** (Cursor CLI / `cursor-agent`) | ✅ headless/print mode | ⚠️ session model differs — verify at build | ❌ none — an `outputSchema` is REFUSED | Cursor account/key | Close to Claude Code; confirm resume + question emission before wiring the Q&A loop. |
| **copilot** (GitHub Copilot CLI) | ⚠️ evolving toward agentic | ⚠️ limited/none today | ❌ none — an `outputSchema` is REFUSED | GitHub / `gh` auth | Most limited for the edit→PR→resume loop; may land as a plan/suggest-only driver first. |

**Structured output (`outputSchema`)** — the column above was written when the only JSON on offer
was the CLI's *envelope* (`is_error`, `total_usage`) with a free-text `result`. Claude Code has
since gained `--json-schema`, which CONSTRAINS the model and returns the parsed object as
`structured_output` on the final result message. Verified live against the version the Dockerfile
pins, in the `stream-json` mode this driver actually runs — the `--output-format json` behaviour
could not be assumed to carry over.

A driver whose `capabilities.structuredOutput` is false REFUSES a schema (non-retryable) rather
than degrading to text. This is the one capability that must NOT "degrade gracefully": handing back
unvalidated prose in a field the graph reads as typed data produces a run that looks successful and
is wrong, which is worse than failing.

Drivers **advertise capabilities**; the workflow degrades gracefully — a driver without
`resume`/`structuredQuestions` simply doesn't offer the Q&A pause (it runs once and returns
its result), so the node works for every tool at the level that tool supports. The CLI
details for Cursor/Copilot must be **verified against their live docs at build time** (like
we did for the Teams envelope) — not wired from memory.

### Build implication

- **Slice 1** builds the node + the **driver seam** with the **claude** driver only. `tool`
  defaults to `claude`; the registry + interface exist so a Cursor/Copilot adapter is
  additive.
- Config gains `tool: "claude" | "cursor" | "copilot"` (§7); the runner image is selected by
  the driver; per-tool auth comes from the tenant's connection/credential for that tool.

---

## 9. Tier-1 compliance checklist

- Interpreter, not codegen — one activity, config-driven. ✓
- Workflow deterministic — all subprocess/clone/PR I/O in the activity. ✓
- Secrets never in Temporal — BYOK key + App token fetched/used in-activity; the key is
  per-`execFile` env; the git token never enters the sandbox. ✓
- Billing fail-safe — usage from the JSON envelope, char/4 fallback, never zero. ✓
- Payloads small — diffs/trees via claim-check. ✓
- Privacy — ledger stores tokens/cost only. ✓
