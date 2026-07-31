import type { ArgBinding, EdgeCondition } from "./core";

/** Who may decide an approval gate (REDESIGN-FUNCTIONALITY-GAPS.md Slice 1). Either list may be
 *  set; a decider must match an email OR be a member of a listed permission group. Enforced at
 *  decide time in the API (owner/admin bypass, consistent with RBAC-GROUPS §4). */
export interface ApprovalApprovers {
  /** Exact-match (case-insensitive) user emails allowed to decide. */
  emails?: string[];
  /** Permission-group ids whose members (users or API tokens) may decide. */
  groupIds?: string[];
}

/** Human-approval node config. The interpreter reads `timeoutHours` to bound the
 *  durable wait (auto-reject on elapse) and `remindAfterHours`/`escalateAfterHours`
 *  to drive durable reminder/escalation timers; title/instructions are display-only
 *  (the UI reads them from the graph). Routing/SLA/context fields are Slice 1 of
 *  REDESIGN-FUNCTIONALITY-GAPS.md. */
export interface ApprovalNodeConfig {
  title?: string;
  instructions?: string;
  /** Auto-reject if no decision within this many hours (omitted = wait forever). */
  timeoutHours?: number;
  /** Who may decide (emails and/or permission-group ids). Omitted = anyone with `run`. */
  approvers?: ApprovalApprovers;
  /** Display-only SLA: due = pausedAt + slaHours (no timer — chips derive due-by tones). */
  slaHours?: number;
  /** Reminder notification offsets (hours after pause), ascending, ≤5 entries. Each fires
   *  the notification channels with a `reminder` flavor via a durable Temporal timer. */
  remindAfterHours?: number[];
  /** Escalation notification offset (hours after pause). Notify-only in v1. */
  escalateAfterHours?: number;
  /** Who the escalation notification mentions (free-form, e.g. "@ops-oncall"). */
  escalateTo?: string;
  /** Structured context card: key → value, where values may contain `{{ }}` expressions
   *  resolved against the run ctx AT PAUSE TIME (in-activity; `$secrets` refs are never
   *  resolved here — they stay literal, so secrets can't leak into the awaiting record). */
  contextFields?: Record<string, string>;
}

/**
 * Execute Sub-workflow node — run another of the tenant's saved graphs as a
 * durable CHILD run, wait for it, and expose its result. Output is
 * `{ status, output }` — the child's terminal status + a bounded projection of its
 * node outputs (internal `__*` keys dropped) — so the parent graph can branch on
 * `<nodeId>.status` and read child results via `<nodeId>.output.*`.
 *
 * The child graph is resolved by `workflowKey` (latest version) IN an activity
 * (I/O), then launched with `wf.executeChild` (deterministic). Only `workflowKey`
 * — never a secret — lives in this config. The child input is built purely in the
 * interpreter from `input` + `inputBindings`; when neither is set the child
 * receives the parent's trigger input.
 */
export interface ExecuteSubWorkflowNodeConfig {
  /** The saved-graph key to run as a child (this tenant's latest version). */
  workflowKey: string;
  /** Static base for the child's input object. */
  input?: Record<string, unknown>;
  /** dotted input path → upstream output binding; fills/overrides that path. */
  inputBindings?: Record<string, ArgBinding>;
}

/** splitOut (items model) — opens a per-item region over an upstream ARRAY. On iteration `i` the
 *  node's output IS `array[i]`; the linear region between it and its `loopEnd` runs once per item.
 *  See docs/design/ITEMS-MODEL-CURRENT-ITEM.md §0.2. */
/**
 * `retry` — opens a RETRY REGION. Nodes from here to its `retryEnd` repeat as a unit until an
 * attempt completes without throwing, or `maxAttempts` is reached (then the run fails with the
 * node's own error, never a wrapper).
 *
 * The field names are `NodeRetryPolicy`'s verbatim: two retry features with two vocabularies for
 * the same four numbers would be a needless thing to learn twice.
 */
export interface RetryNodeConfig {
  /** Total attempts including the first (default 3, hard ceiling 25). */
  maxAttempts?: number;
  /** Wait before the 2nd attempt, in seconds (default 1). */
  initialIntervalSeconds?: number;
  /** Multiplier applied to the wait each attempt (default 2 = exponential). */
  backoffCoefficient?: number;
  /** Cap on any single wait, in seconds. */
  maxIntervalSeconds?: number;
}

/* `retryEnd` closes a retry region and carries NO config — the policy lives on the `retry` node.
   Like `end` and `noOp` it therefore has no schema and no entry in the registry's drift map; an
   empty schema would be a thing to keep in step with nothing. */

export interface SplitOutNodeConfig {
  /** Upstream node id whose output holds (or contains, via `path`) the array to split. */
  from: string;
  /** Optional dotted path into that output pointing at the array. */
  path?: string;
}

/** loopEnd (items model) — closes a per-item region. Its output is the ARRAY of the region node it
 *  binds to (`from`), one element per iteration. After it, the run is back to a single value. */
export interface LoopEndNodeConfig {
  /** The region node whose per-iteration output to collect into an array. */
  from: string;
}

/**
 * For Each node — map an upstream ARRAY by running a saved graph (`workflowKey`) as
 * a durable child run ONCE PER ITEM (the item is the child's input), concurrently.
 * Output is an array of `{ status, output }` (the same bounded projection as
 * `executeSubWorkflow`), in item order — so downstream can filter/aggregate it.
 * Only `workflowKey`/`tenantId` cross the boundary (no secrets). Bounded by an item
 * cap and the sub-workflow depth cap.
 */
export interface ForEachNodeConfig {
  /** The saved-graph key to run per item (this tenant's latest version). */
  workflowKey: string;
  /** Upstream node id whose output holds the array to iterate. */
  from: string;
  /** Optional dotted path into that output to reach the array. */
  path?: string;
}

/**
 * Code node — run arbitrary user JavaScript in a sandbox (QuickJS compiled to WASM;
 * no host access, memory + wall-clock capped). It runs in an ACTIVITY (QuickJS has
 * Date/Math.random → non-deterministic). The code executes as
 * `(function($input,$ctx){ <code> })(...)` — `$input` is the run's entry input,
 * `$ctx` is a `{nodeId: output}` map of upstream outputs — and its RETURN VALUE
 * becomes this node's output. No secrets, no network.
 */
export interface CodeNodeConfig {
  /** The user JavaScript. Use `return <value>` to produce the node's output. */
  code: string;
  /** Wall-clock cap in ms (default 2000, capped at 5000). */
  timeoutMs?: number;
  /** Memory cap in MB (default 64, capped at 128). */
  memoryMb?: number;
}

/**
 * Merge node — fan-IN join. A node with N inbound edges; the interpreter runs it
 * ONCE, when the last inbound branch arrives, and writes a combined output to
 * `ctx[mergeId]`. Lets the diamond pattern (fan-out → parallel work → recombine)
 * work without duplicating the merge or its downstream.
 *
 * PURE: deterministic graph work (no I/O, no secrets) — the combine reads the
 * inbound parents' outputs from ctx. v1 supports UNCONDITIONAL fan-in only
 * (a conditional edge into a merge is rejected by `validateGraph`, since a branch
 * that never fires would strand the join); loops back through a merge are undefined.
 */
/**
 * IF node — a boolean gate (n8n's IF). Evaluates `conditions` and COMBINES them with AND
 * (all must hold) or OR (any), producing `{ result: boolean }`. This adds boolean
 * combination that a single edge condition / Switch rule can't express. The author draws a
 * true-edge (`<ifId>.result eq true`) and a false-edge (`eq false`). PURE (reuses
 * `evaluateCondition`, no eval).
 */
export interface IfNodeConfig {
  /** Combine the conditions: "and" (default, all hold) or "or" (any holds). */
  combine?: "and" | "or";
  /** The predicates (same op set as edges/filter/switch). Empty ⇒ result is false. */
  conditions: EdgeCondition[];
}

/** One named branch of a Switch node — a label plus the predicate that selects it. */
export interface SwitchRule {
  /** The branch label; also the value written to `{ matched }` when this rule wins. */
  name: string;
  /** Structured predicate (same op set as edges/filter), evaluated against `ctx`. */
  condition: EdgeCondition;
}

/**
 * Switch node — multi-way router (n8n's Switch, Rules mode). Evaluates `rules` IN ORDER
 * against the run context and outputs `{ matched }` = the FIRST matching rule's name, or
 * `fallback` when none match. PURE (reuses `evaluateCondition`, no I/O). The author draws
 * one outgoing edge per branch with `eq` on `<switchId>.matched` — one node instead of N
 * hand-wired conditional edges on the source.
 */
export interface SwitchNodeConfig {
  /** Ordered branches; the first whose condition holds wins. */
  rules: SwitchRule[];
  /** `matched` value when no rule matches (default "default"). */
  fallback?: string;
}

export interface MergeNodeConfig {
  /** How to combine the inbound parents' outputs. "array" (default) →
   *  `[parent1, …, parentN]` in declared inbound-edge order; "object" →
   *  `Object.assign({}, …parents)`. */
  mode?: "array" | "object";
}

/**
 * Wait node — pause the run for a fixed duration, then continue. Backed by a
 * durable Temporal timer (`wf.sleep`), so the pause survives worker crashes and
 * costs nothing while waiting — never a busy-loop (CLAUDE.md rule 5). No output.
 */
export interface WaitNodeConfig {
  /**
   * "duration" (default) = pause for a fixed time; "webhook" = pause DURABLY until an
   * external system POSTs the run's resume URL (survives crashes / days, like approval).
   */
  mode?: "duration" | "webhook";
  /** duration mode: how long to pause, in seconds. <= 0 / omitted = no wait (pass through). */
  durationSeconds?: number;
  /**
   * webhook mode: optional max seconds to wait before auto-continuing (a durable timer,
   * so it survives a crash). <= 0 / omitted = wait forever until resumed. On timeout the
   * node's output is `{ resumed: false, timedOut: true }` so a graph can branch on it.
   */
  timeoutSeconds?: number;
}

/**
 * Stop and Error node — terminate the run as a failure with a message. Terminal:
 * nothing downstream runs. The message is static, non-secret display text (it
 * surfaces in the run's history/timeline).
 */
export interface StopAndErrorNodeConfig {
  /** Shown as the run's failure reason. */
  message?: string;
}
