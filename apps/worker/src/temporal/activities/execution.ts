// Execution/run bookkeeping, $vars, durable chat-session persistence, dateTime,
// and sub-workflow graph resolution — the DB-backed "records" activities.
import { createHash } from "node:crypto";
import { ApplicationFailure } from "@temporalio/activity";
import { canonicalize } from "@naary/dsl";
import type { GraphDef, TemplateBlock } from "@naary/dsl";
import {
  Prisma,
  getDefaultEnvironmentId,
  getPrisma,
  resolveWorkflowKey,
} from "@naary/db";
import { createLogger } from "@naary/logging";
import { getObjectStore, maybeOffload } from "@naary/storage";
import { getBudget } from "@naary/usage";
import { resumeSnapshotsEnabled, storageProvider } from "../../config";
import { RETURNED_TERMINAL_STATUSES } from "@naary/contracts";

const log = createLogger({ component: "worker" });

/**
 * Record run ownership (tenant + workflowKey) so EVERY run — manual, webhook, or
 * scheduled — appears in the Runs list and can be authorized by tenant. Idempotent
 * upsert: manual/webhook runs are pre-created by the API (this is then a no-op);
 * scheduled runs (started by Temporal) are created here. Called once at workflow
 * start, behind a `patched()` gate so in-flight runs aren't broken on replay.
 */
export async function recordExecution(meta: {
  workflowId: string;
  tenantId: string;
  environmentId?: string;
  workflowKey?: string;
  graphVersion?: number;
}): Promise<void> {
  // #904: a run started by an ALREADY-ARMED Temporal schedule (or any long-lived handle created
  // before a key rename) still carries the OLD key in its args. Resolve it here or the run would be
  // filed under a key the workflows list no longer shows — history has to follow the workflow.
  const workflowKey = meta.workflowKey
    ? await resolveWorkflowKey(meta.tenantId, meta.workflowKey)
    : null;
  await getPrisma().execution.upsert({
    where: { workflowId: meta.workflowId },
    create: {
      workflowId: meta.workflowId,
      tenantId: meta.tenantId,
      environmentId: meta.environmentId ?? null, // per-env Runs tag (Slice 6)
      workflowKey,
      // Only scheduled runs create here (API runs are pre-created with the version);
      // record the snapshotted version so scheduled runs show it too.
      graphVersion: meta.graphVersion ?? null,
    },
    update: {}, // already recorded — don't clobber the original createdAt
  });
}

/**
 * Global Variables ($vars): load a run's non-secret, env-scoped key/value config as a plain map,
 * for the interpreter to seed into `ctx.$vars` at run start (design ROADMAP-ENTERPRISE). The DB read
 * lives here (Tier-1 #3 — all I/O in activities); the workflow only threads the returned DATA into
 * ctx. Env-scoped so a value can differ sandbox vs prod; a pre-env run (no environmentId) falls back
 * to the tenant default, matching every other env-scoped read. NOT secrets — those resolve in-activity
 * and never enter the graph/ctx/history (Tier-1 #4, separate feature).
 */
export async function loadVariables(meta: {
  tenantId: string;
  environmentId?: string;
}): Promise<Record<string, string>> {
  const environmentId =
    meta.environmentId ?? (await getDefaultEnvironmentId(meta.tenantId));
  const rows = await getPrisma().variable.findMany({
    where: { tenantId: meta.tenantId, environmentId },
    select: { key: true, value: true },
  });
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

/** Load a content template's subject + blocks by id, scoped to (tenant, env) so a run can only
 *  render its own workspace's templates (docs/design/TEMPLATE-EDITOR.md). Returns null when the
 *  template was deleted/renamed away — the sendEmail handler then falls back to the node's inline
 *  html/text. Read-only (idempotent), so its proxy can retry. The blocks were validated on write. */
export async function loadTemplate(
  templateId: string,
  meta: { tenantId: string; environmentId?: string },
): Promise<{ subject: string | null; blocks: TemplateBlock[] } | null> {
  const environmentId =
    meta.environmentId ?? (await getDefaultEnvironmentId(meta.tenantId));
  const row = await getPrisma().template.findFirst({
    where: { id: templateId, tenantId: meta.tenantId, environmentId },
    select: { subject: true, blocks: true },
  });
  if (!row) return null;
  return { subject: row.subject, blocks: row.blocks as TemplateBlock[] };
}

/** Failure classification derivable from the terminal STATUS itself (returned-status
 *  terminals). Thrown failures carry an explicit `failureKind` classified in the
 *  workflow from the recorded error instead. circuit_open/invalid_graph get none —
 *  their status is already the most precise description (consumers fall back to it). */
const STATUS_FAILURE_KIND: Record<string, string> = {
  rejected: "rejected",
  budget_exceeded: "budget",
};

/**
 * Push the run's current status + accumulated cost to its Execution row — the
 * read-model the Runs list reads (so listing needs no per-run Temporal calls).
 * Best-effort: a missing row (race before recordExecution) is ignored.
 * A TERMINAL status also stamps `finishedAt` (the clock read lives HERE, in the
 * activity — Tier-1 rule 2) and persists the compact `failureKind` (Slice 2):
 * explicit from the workflow for thrown failures, else derived from the status.
 */
export async function setExecutionStatus(meta: {
  workflowId: string;
  status: string;
  costUsd?: number;
  /** Classification of a THROWN failure (workflow-derived, deterministic). */
  failureKind?: string;
  /** Run-detail recovery (#525): the node a THROWN run died on. Node id only. */
  failedNodeId?: string;
  /** Run-detail recovery (#525): the node ids that had produced output when the run
   *  threw — so the UI marks them done even though the failed run's ctx isn't queryable. */
  executedNodeIds?: string[];
}): Promise<void> {
  const terminal = RETURNED_TERMINAL_STATUSES.has(meta.status);
  const failureKind =
    meta.failureKind ??
    (terminal ? STATUS_FAILURE_KIND[meta.status] : undefined);
  await getPrisma()
    .execution.update({
      where: { workflowId: meta.workflowId },
      data: {
        status: meta.status,
        ...(meta.costUsd !== undefined ? { costUsd: meta.costUsd } : {}),
        ...(terminal ? { finishedAt: new Date() } : {}),
        ...(failureKind !== undefined ? { failureKind } : {}),
        ...(meta.failedNodeId !== undefined
          ? { failedNodeId: meta.failedNodeId }
          : {}),
        ...(meta.executedNodeIds !== undefined
          ? { executedNodeIds: meta.executedNodeIds }
          : {}),
        // Pause-not-fail (Slice 3): stamp when the run parks on budget; clear on any
        // other status so the column always means "currently paused since". The
        // month-rollover boot reconcile keys off it.
        budgetPausedAt: meta.status === "awaiting_budget" ? new Date() : null,
      },
    })
    .catch(() => undefined);
}

/** The budget snapshot a paused run re-reads after a budgetResume Signal (Slice 3). */
export interface BudgetSnapshot {
  perExecutionCapUsd: number;
  maxStepsPerRun: number;
  onBudgetExceeded: string;
}

/**
 * Re-read the tenant's budget policy/caps for a run resuming from `awaiting_budget`
 * (Slice 3, pause-not-fail). The PUT that resumed the run likely RAISED the per-run cap
 * — without this re-read the workflow would re-check its stale start-time snapshot and
 * immediately re-park. DB read (I/O) → activity, per Tier-1 rule 3; the workflow only
 * threads the returned numbers (never secrets). Null when the tenant has no budget row
 * (caps removed) — the workflow then keeps its existing snapshot.
 */
export async function refreshBudget(meta: {
  tenantId: string;
}): Promise<BudgetSnapshot | null> {
  const b = await getBudget(meta.tenantId);
  return b
    ? {
        perExecutionCapUsd: b.perExecutionCapUsd,
        maxStepsPerRun: b.maxStepsPerRun,
        onBudgetExceeded: b.onBudgetExceeded,
      }
    : null;
}

/**
 * Durable chat session (design §2.1b, option A): load the last `limit` MESSAGES of a session
 * (oldest-first) so a freshly (re)started session workflow resumes with memory — the ChatMessage
 * table is the durable backing store; the session's in-Temporal history is the live working copy.
 * Mirrors the API's ChatService.loadHistory (ordered by the monotonic `seq`). Empty for a new
 * session. Side effect (DB read) → activity, per Tier-1 #3.
 */
export async function loadChatHistory(meta: {
  tenantId: string;
  chatId: string;
  sessionId: string;
  limit?: number;
}): Promise<{ role: string; text: string }[]> {
  if (!meta.sessionId) return [];
  const rows = await getPrisma().chatMessage.findMany({
    where: {
      tenantId: meta.tenantId,
      chatId: meta.chatId,
      sessionId: meta.sessionId,
    },
    orderBy: { seq: "desc" },
    take: Math.min(Math.max(meta.limit ?? 40, 1), 200),
    select: { role: true, text: true },
  });
  return rows.reverse();
}

/**
 * Durable chat session: persist a completed turn (user + assistant rows) ATOMICALLY, so the table
 * stays the durable record of the conversation even after the session workflow idle-expires. Mirrors
 * ChatService.appendTurn. Side effect (DB write) → activity.
 */
export async function appendChatTurn(meta: {
  tenantId: string;
  chatId: string;
  sessionId: string;
  userText: string;
  assistantText: string;
}): Promise<void> {
  if (!meta.sessionId) return;
  const prisma = getPrisma();
  const base = {
    tenantId: meta.tenantId,
    chatId: meta.chatId,
    sessionId: meta.sessionId,
  };
  await prisma.$transaction([
    prisma.chatMessage.create({
      data: { ...base, role: "user", text: meta.userText },
    }),
    prisma.chatMessage.create({
      data: { ...base, role: "assistant", text: meta.assistantText },
    }),
  ]);
}

export interface DateTimeResult {
  /** ISO-8601 string (UTC). */
  iso: string;
  /** Milliseconds since the Unix epoch. */
  epochMs: number;
}

/**
 * dateTime node — resolve a base time (the current clock when `base` is null, else
 * a passed epoch-ms number / ISO string) and apply an optional offset. The CLOCK
 * READ is the non-deterministic part, which is exactly why this is an activity and
 * not workflow code (CLAUDE.md rule 2/3). No secrets, no egress.
 */
export async function computeDateTime(input: {
  base: string | number | null;
  addSeconds?: number;
}): Promise<DateTimeResult> {
  let baseMs: number;
  if (input.base === null || input.base === undefined) {
    baseMs = Date.now();
  } else if (typeof input.base === "number") {
    baseMs = input.base;
  } else {
    const parsed = Date.parse(input.base);
    baseMs = Number.isNaN(parsed) ? Date.now() : parsed;
  }
  const epochMs = baseMs + (input.addSeconds ?? 0) * 1000;
  return { iso: new Date(epochMs).toISOString(), epochMs };
}

/** A child graph resolved for an executeSubWorkflow node, pinned to its version. */
export interface SubWorkflowGraph {
  graph: GraphDef;
  contentHash: string;
  version: number;
}

/**
 * Resolve the child graph for an `executeSubWorkflow` node: fetch the tenant's
 * latest saved graph for `workflowKey` and snapshot its content hash + version, so
 * the parent run pins an immutable child version (a later edit can't corrupt an
 * in-flight parent — same guarantee as top-level start). The DB read (I/O) lives
 * here, never in the deterministic workflow. A missing graph is a user error (save
 * it first) → non-retryable, so we don't burn Temporal retries on it.
 */
export async function resolveSubWorkflowGraph(meta: {
  tenantId: string;
  /** The env to resolve the child graph in (Slice 5b) — GraphDefinition is env-scoped, so a sandbox
   *  parent must pull the sandbox version of the child. Undefined for a pre-5b run → the tenant
   *  default env, where all pre-environments graphs live (byte-identical to the old cross-env read). */
  environmentId?: string;
  workflowKey: string;
}): Promise<SubWorkflowGraph> {
  const environmentId =
    meta.environmentId ?? (await getDefaultEnvironmentId(meta.tenantId));
  // Alias-resolve (#904). THE most important consumer of the alias table: a `workflowKey` inside
  // another graph's `executeSubWorkflow` / `forEach` node config (or a run's `errorWorkflowKey`) is
  // a reference we deliberately do NOT rewrite when the child is renamed — a JSON-body rewrite
  // across every version of every other graph in every env would be brittle, and a stale one fails
  // at RUN time, not save time. Resolving here is what makes the rename safe for those callers.
  const workflowKey = await resolveWorkflowKey(meta.tenantId, meta.workflowKey);
  const row = await getPrisma().graphDefinition.findFirst({
    where: {
      tenantId: meta.tenantId,
      environmentId,
      workflowKey,
    },
    orderBy: { version: "desc" },
  });
  if (!row) {
    throw ApplicationFailure.nonRetryable(
      `No saved graph for workflowKey '${meta.workflowKey}' — save it before calling it as a sub-workflow`,
      "SUBWORKFLOW_GRAPH_NOT_FOUND",
    );
  }
  const graph = row.graph as unknown as GraphDef;
  const contentHash = createHash("sha256")
    .update(canonicalize(graph))
    .digest("hex");
  return { graph, contentHash, version: row.version };
}

/**
 * Snapshot a FAILED run's ctx so it can be resumed at the node that died
 * (docs/design/RESUME-FROM-FAILED-NODE.md §2).
 *
 * The ctx goes to OBJECT STORAGE and only a claim-check reference reaches Postgres, so the
 * "node IDs only, never ctx output content" rule on the Execution table still holds. Same bucket and
 * lifecycle as the continueAsNew offload — this is the same data for the same reason, just written on
 * a different trigger.
 *
 * Three ways this legitimately does nothing, each of which makes resume refuse with a reason rather
 * than run against a hollow ctx:
 *   - `RESUME_SNAPSHOTS=off` — the kill switch.
 *   - no S3-backed store — `getObjectStore()` falls back to an in-process MemoryObjectStore that the
 *     API cannot read, so a "snapshot" there would resolve to nothing at resume time. Better to have
 *     written none at all than a reference that dead-ends.
 *   - any failure while writing it.
 *
 * NEVER throws: it runs on the failure path, and masking the original failure with a bookkeeping
 * error would be strictly worse than not offering a resume.
 */
export async function persistResumeSnapshot(meta: {
  workflowId: string;
  tenantId: string;
  ctx: Record<string, unknown>;
  stepCount: number;
  mergeArrivals?: Record<string, number>;
}): Promise<void> {
  try {
    if (!resumeSnapshotsEnabled()) return;
    // Durability check, not a capability check: MemoryObjectStore satisfies the interface but lives
    // in THIS process, so the API would never resolve the reference.
    if (storageProvider() !== "s3") return;

    const ref = await maybeOffload(meta.ctx, getObjectStore(), {
      keyPrefix: `resume/${meta.tenantId}`,
      thresholdBytes: 0, // always offload — the point is to get it OUT of Postgres
    });
    await getPrisma().execution.update({
      where: { workflowId: meta.workflowId },
      data: {
        resumeSnapshot: ref as Prisma.InputJsonValue,
        resumeStepCount: meta.stepCount,
        ...(meta.mergeArrivals
          ? { resumeMergeArrivals: meta.mergeArrivals as Prisma.InputJsonValue }
          : {}),
      },
    });
    // Size + ids only — never the ctx (privacy checklist: no run content in logs).
    log.info(
      {
        activity: "persistResumeSnapshot",
        workflowId: meta.workflowId,
        tenantId: meta.tenantId,
        stepCount: meta.stepCount,
        bytes: Buffer.byteLength(JSON.stringify(meta.ctx ?? null), "utf8"),
      },
      "stored a resume snapshot for a failed run",
    );
  } catch (err) {
    log.warn(
      {
        activity: "persistResumeSnapshot",
        workflowId: meta.workflowId,
        err: err instanceof Error ? err.message : String(err),
      },
      "could not store a resume snapshot; the run stays unresumable",
    );
  }
}

/**
 * Is self-healing enabled for this workflow (Phase 2)?
 *
 * One indexed read on the primary key, called only on the FAILURE path and only behind
 * `wf.patched("self-heal-v1")`. ABSENCE ⇒ FALSE — the setting is opt-in per (tenant, env,
 * workflowKey) and absent for almost everyone, so the overwhelmingly common answer is "no" and
 * the failing run goes on to fail exactly as it did before.
 *
 * NEVER THROWS. It runs beside the resume snapshot on a path whose one job is to report the run's
 * real failure; an error here that propagated would replace that failure with a bookkeeping one.
 * The caller wraps it too — belt and braces, because the ways Temporal can fail a CALL (an
 * unregistered activity, a timeout, retries exhausted) are not catchable inside it.
 *
 * Answering `false` on an error is the safe direction: a missed proposal costs a notification
 * nobody receives, while a spurious `true` spends a tenant's model tokens without being asked.
 */
export async function shouldSelfHeal(meta: {
  tenantId: string;
  environmentId?: string;
  workflowKey?: string;
}): Promise<boolean> {
  // A run with no workflowKey predates key tracking and has nothing to propose a fix TO; a run
  // with no environmentId predates env scoping and cannot be matched to an env-scoped setting.
  if (!meta.workflowKey || !meta.environmentId) return false;
  try {
    const row = await getPrisma().selfHealSetting.findUnique({
      where: {
        tenantId_environmentId_workflowKey: {
          tenantId: meta.tenantId,
          environmentId: meta.environmentId,
          workflowKey: meta.workflowKey,
        },
      },
      select: { enabled: true },
    });
    return row?.enabled === true;
  } catch (err) {
    log.warn(
      {
        activity: "shouldSelfHeal",
        tenantId: meta.tenantId,
        workflowKey: meta.workflowKey,
        err: err instanceof Error ? err.message : String(err),
      },
      "could not read the self-heal setting; treating the workflow as opted out",
    );
    return false;
  }
}
