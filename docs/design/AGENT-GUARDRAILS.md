# Agent guardrails (#576)

Governance of what an agent may *do* and what may cross the model boundary. One policy object per
workspace, enforced at three independent points.

---

## 1. The policy

Stored on `TenantSettings.agentGuardrails` (nullable JSON; `NULL`/`{}` ⇒ no guardrails, behaviour
identical to pre-#576). Shape: `AgentGuardrailPolicy` in `packages/dsl/src/guardrails.ts`.

```jsonc
{
  "tools": {
    "allow":          ["read_*"],                 // non-empty ⇒ ALLOWLIST (fail closed)
    "deny":           ["delete_*", "c-1:drop_table"],
    "requireApproval":["wire_money", "github:create_issue"]
  },
  "input":  [{ "label": "codename", "kind": "keyword", "pattern": "Project Bluebird" }],
  "output": [{ "label": "acct", "kind": "regex", "pattern": "ACCT-\\d{6}", "action": "strip" }],
  "redact": { "enabled": true, "kinds": ["email", "phone", "creditCard", "ssn", "ipv4"] }
}
```

**Tool refs.** `connectionId:tool` for MCP, `provider:action` for a native integration. Entries are
**globs** (`*`), never regexes — an operator regex evaluated in workflow code would be a ReDoS
surface for no expressive gain. A pattern containing `:` matches the full ref; a colon-less pattern
matches the tool/action segment on any connection.

**Verdict order (the security contract).** `deny` → allowlist-miss → `requireApproval` → allow. An
explicit deny is final: a denied tool must never become reachable by getting a human to click
Approve.

**Content rules.** `keyword` (literal, case-insensitive by default) or `regex` (case-sensitive by
default). Action `fail` (default; fail the node non-retryably) or `strip` (replace the match with
`[BLOCKED]` and continue). Only the operator-chosen `label` ever reaches an error message or an
audit row — never the matched text.

Regex rules are guarded twice: the save gate rejects a nested-quantifier pattern (the `(a+)+` family,
same structural check the edge-condition `regex` operator uses) and an invalid pattern; at run time
a regex rule is scanned over at most `MAX_CONTENT_SCAN_CHARS` (100 000) because no timeout can
interrupt a synchronous `RegExp` and the structural check does not catch every exponential shape
(`(a|a)*b`). A `keyword` rule has no scan cap — `indexOf` is linear and safe.

**Write gate.** `agentGuardrailPolicySchema` (zod, in `packages/dsl/src/registry.ts`) is `strict()`,
so a typo'd key is a 400 rather than a silently unenforced rule. `parseAgentGuardrailPolicy` **fails
closed and loudly**: a stored value that no longer parses throws rather than degrading to "no
guardrails" (a governance control that silently stops enforcing is the worst available failure).

---

## 2. Three enforcement points

| Point | Where | Covers |
|---|---|---|
| Save gate | `GraphsService.upsert` → `validateGraphToolPolicy` | denied tool anywhere; forced-approval tool inside an agent's `tools[]` |
| In-activity | `runAgent` (`apps/worker/src/temporal/activities/agent.ts`) | denied / forced-approval in-loop tool; input + output content rules; PII redaction |
| Interpreter | `execNodeInner` → `toolApprovalGate` (`workflow/engine/node-exec.ts`) | denied tool node; the **durable forced-approval pause** before a standalone tool node |

The in-activity point is what makes a *runtime bypass* fail: a graph saved before the policy
tightened, promoted in from another environment, seeded, or started directly still hits it.

---

## 3. `§4` — the activity-boundary problem, and how forced approval resolves it

**The constraint.** An agent node's tool calls happen **inside a single activity** (the AI SDK's
`generateText` tool loop). Temporal cannot suspend an activity to await a Signal. So a
forced-approval tool *cannot* simply `await` approval where the tool executes. The three tempting
non-answers are all rejected:

- a poll/sleep loop inside the activity — violates Tier-1 rule 5 and cannot survive a worker crash;
- silently running the tool anyway — is exactly the hole the policy exists to close;
- pretending to pause — is a lie in a compliance surface.

**What ships.** Forced approval is a real durable pause **where the interpreter owns the call**:

1. `execNodeInner` resolves the run's tool-policy projection once per run segment
   (`resolveToolPolicy` activity → `ctx.__toolPolicy`, a small `ref → verdict` map; refs the policy
   plainly allows are omitted, so an unrestricted graph caches `{}`).
2. On a `mcpTool` / `integration` node whose ref is `approval`, the interpreter writes the
   `__approval` record (with `toolRef`, so the inbox/Slack/public prompt names the tool), sets
   `awaiting_approval`, pages the tenant best-effort, and awaits `approvalSignal` via
   `wf.condition()` — the exact machinery `humanApproval` uses, so every existing approval surface
   (run view, batch, Slack buttons, signed public link) works unchanged.
3. On approval the tool runs; on rejection the run ends `rejected` and the tool never runs. Either
   way the interpreter writes an `AuditEvent` naming **actor + tool + decision**.

An **agent node's in-loop** forced-approval tool is instead **refused**, twice: the save gate rejects
the configuration with a message telling the author to move the tool to a standalone node, and the
activity refuses it non-retryably (`GUARDRAIL_TOOL_NEEDS_APPROVAL`) for a graph the save gate never
saw. Every new command in the interpreter sits behind `wf.patched("tool-approval-gate-v1")`, and the
node-type check keeps every non-tool node on its exact pre-#576 command sequence.

**DEFERRED: in-loop pause + resume.** The full version — the activity returns a structured "needs
approval for tool X", the interpreter pauses, then resumes the *same conversation* — is designable
(the AI SDK's canonical HITL pattern is a tool with no `execute`, which ends the step with the tool
call unresolved; `result.response.messages` would be handed back and continued after the decision).
It is deferred because it needs a second agent activity, a resume-state contract, the partial
message history riding Temporal history (with its own size/claim-check question), and a round cap —
an interpreter change larger than this slice. Nothing in the shipped code pretends otherwise.

### Worker-side audit

`AuditEvent` previously had exactly one writer: the API's global `AuditInterceptor`, which needs a
mutating HTTP request *with* a principal. Neither of #576's audit obligations has one (a violation
detected inside an activity; a decision the worker observes as a Signal — and the public signed-link
path never audited at all). So the worker got a narrow append-only writer
(`activities/audit.ts`, `method: "WORKER"`), and `ApprovalInput` gained an optional `actor` display
string the API fills from the principal it already authenticated. It is a label, never an
authorization input.

---

## 4. PII redaction — what it guarantees

`redactPii` replaces each occurrence with a stable `[PII_<KIND>_<n>]` placeholder (one placeholder
per distinct value, so the model still sees a coherent document). Cards are Luhn-checked and SSNs
matched before the looser phone shape, so a long order id is not mislabelled as a card. Kind order
also guarantees a later kind can never re-redact an earlier kind's placeholder.

The returned `map` (placeholder → raw PII) is the sensitive artifact. Tier-1 rule 4's posture applies
verbatim: it stays in the activity's block scope, is never returned, never logged, never attached to
a span, never persisted. Only a **count** escapes, on `AgentResult.guardrails.redacted`.

**Asserted in `apps/worker/test/agent-guardrails.spec.ts`:** no raw PII reaches the provider, the
activity's return value (⇒ `ctx` ⇒ Temporal history), the usage-ledger write, or any structured log
line — and the map is unreachable from the result.

**The one boundary redaction cannot cross, stated plainly:** an agent node's *input* is already a
workflow argument by the time the activity runs, so PII a caller put in the **trigger payload** is in
Temporal history before redaction can see it. (The codebase states the same limit for the
`textToSpeech` node's resolved text.) Redaction governs what leaves the boundary — provider, ledger,
logs, node output — not what the trigger already recorded. Keeping PII out of a trigger payload is a
separate problem (ingress-side filtering) and is not claimed here.

---

## 5. Not in this slice

- **Web UI** for editing the policy. The API is `GET`/`PUT /tenants/:id/settings/guardrails`
  (whole-object PUT: a merge could never remove a rule from a blocklist).
- Per-**environment** policy (workspace-wide today), and per-**node** overrides of the workspace
  policy (node-level `tools[]` is validated *against* it, which is what the issue asks for).
- Redaction of tool ARGUMENTS and tool RESULTS inside the agent loop (prompt assembly only).
- Content rules on non-agent nodes.
