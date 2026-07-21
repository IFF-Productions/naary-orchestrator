import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { stateQuery, type ExecutionState } from "@naary/contracts";
import { getPrisma } from "@naary/db";
import type { Principal } from "../auth/tenant.decorator";
import { buildViewTerms } from "../permissions/permissions.service";
import { awaitingRecord, isTerminalStatus } from "./executions.helpers";
import { type RunSummary, TEMPORAL_FAILED_STATUS } from "./executions.types";
import type { ExecutionsDeps } from "./executions.queries";

/** In-service `run` assert (RBAC-GROUPS.md §4). Gates USER-principal-initiated starts
 *  only — trigger paths (webhook/form/chat/schedule) carry no principal by design. */
export async function accessAssertRun(
  deps: ExecutionsDeps,
  actor: Principal | undefined,
  workflowKey: string,
  environmentId: string,
): Promise<void> {
  if (!actor) return;
  await deps.perms().assertCan(actor, "run", workflowKey, environmentId);
}

/**
 * G3 (§8.4) — gate a SINGLE run surface on the run's own workflow. `view` for the read
 * surfaces (detail/history/graph), `run` for approve/cancel (run-control actions). No
 * actor (trigger/internal caller, the company rollup path, the PUBLIC signed-link
 * approval path) = never checked. Env-EXACT: the check resolves against the RUN'S OWN
 * environment (a legacy env-less row falls back to the tenant default, the env its graph
 * lived in — the same convention as approvalPrompt/rerun). A run with NO workflowKey
 * (pre-key-tracking) can't be matched against key-scoped grants — it is visible only to
 * UNRESTRICTED subjects (owner/admin, unrestricted tokens, the zero-grant cliff).
 */
export async function accessAssertRunAccess(
  deps: ExecutionsDeps,
  actor: Principal | undefined,
  action: "view" | "run",
  row: {
    tenantId: string;
    workflowKey: string | null;
    environmentId: string | null;
  },
): Promise<void> {
  if (!actor) return;
  const perms = deps.perms();
  // Bypassed subjects short-circuit here — no env resolution (no extra DB read) on the
  // common owner/admin/unrestricted path.
  const eff = await perms.getEffective(actor);
  if (!eff.restricted) return;
  if (row.workflowKey === null) {
    throw new ForbiddenException(
      `You don't have permission to ${action === "run" ? "act on" : "view"} this run. ` +
        "Ask a workspace owner or admin for access.",
    );
  }
  const envId =
    row.environmentId ?? (await deps.environments.defaultEnvId(row.tenantId));
  await perms.assertCan(actor, action, row.workflowKey, envId);
}

/**
 * G3 (§8.4) — the Runs-list view filter for a RESTRICTED subject, as a Prisma where
 * fragment, or null when the caller is unrestricted / absent (the query stays
 * byte-identical — the common path). Pushed INTO the where clause (not post-filtered)
 * so keyset pagination stays EXACT: every fetched row is viewable, pages run full, and
 * the cursor math never sees hidden rows. Env-exact per §8.5: one OR term per tenant
 * environment from the subject's effective view there ({all} ⇒ every key in that env,
 * else the key list); rows with a NULL environmentId (pre-env rows) count as the
 * DEFAULT env's; rows with a NULL workflowKey are visible only to unrestricted
 * subjects, so a restricted subject's terms always constrain workflowKey.
 */
export async function accessRunViewFilter(
  deps: ExecutionsDeps,
  actor: Principal | undefined,
  tenantId: string,
): Promise<Record<string, unknown> | null> {
  if (!actor) return null;
  // The per-env terms come from the SHARED builder (permissions.service.ts) — the same
  // semantics filter the usage/insights ledger, so the two surfaces can't drift.
  const viewTerms = await buildViewTerms(deps.perms(), actor, () =>
    deps.environments.list(tenantId),
  );
  if (viewTerms === null) return null;
  const terms = viewTerms.map((t) => ({
    ...(t.view.all
      ? { workflowKey: { not: null } }
      : { workflowKey: { in: t.view.keys } }),
    ...(t.includesNullEnv
      ? { OR: [{ environmentId: t.environmentId }, { environmentId: null }] }
      : { environmentId: t.environmentId }),
  }));
  // No terms ⇒ nothing viewable anywhere: `OR: []` matches no rows (deny-by-default).
  return { OR: terms };
}

/**
 * Decide-time approver enforcement (REDESIGN-FUNCTIONALITY-GAPS.md Slice 1). Reads the
 * awaiting record the worker snapshotted at pause time (ctx.__approval via stateQuery —
 * the RUN'S OWN config snapshot, immune to later graph edits). Semantics:
 *  - gate has no `approvers` (or the run predates the snapshot) → unchanged behavior;
 *  - workspace owner/admin USER principals bypass (consistent with RBAC-GROUPS §4 —
 *    PermissionsService.subjectKey gates only `member` users and tokens);
 *  - user principals match by email (case-insensitive) OR GroupMember membership (uid)
 *    in a listed group;
 *  - restricted `nry_` token principals match via GroupTokenMember (tokenId). A token
 *    WITHOUT a tokenId stamp (unenforced workspace) has no group identity and no email,
 *    so it cannot match a routed gate — fail CLOSED with the same 403;
 *  - absent actor (internal callers; the PUBLIC signed-link path uses decideByToken and
 *    stays HMAC-authorized) → never checked.
 * A closed/undecidable run skips the check — the signal path right after produces the
 * proper 409/404.
 */
export async function accessAssertApprover(
  deps: ExecutionsDeps,
  actor: Principal | undefined,
  workflowId: string,
  tenantId: string,
): Promise<void> {
  if (!actor) return;
  let state: ExecutionState;
  try {
    state = await deps.client.workflow.getHandle(workflowId).query(stateQuery);
  } catch {
    return; // closed/gone — the signal below yields the right 409/404
  }
  if (state.status !== "awaiting_approval") return;
  const approvers = awaitingRecord(state)?.approvers;
  if (!approvers) return;
  const emails = (approvers.emails ?? []).filter((e) => !!e);
  const groupIds = (approvers.groups ?? []).map((g) => g.id).filter(Boolean);
  if (emails.length === 0 && groupIds.length === 0) return;
  // Owner/admin USER principals bypass.
  if (actor.userId && (actor.role === "owner" || actor.role === "admin")) {
    return;
  }
  // Email match (user principals).
  if (
    actor.userId &&
    actor.email &&
    emails.some((e) => e.toLowerCase() === actor.email?.toLowerCase())
  ) {
    return;
  }
  // Group membership: uid via GroupMember, token via GroupTokenMember — tenant-scoped
  // through the group relation so a same-id group of another tenant can never match.
  if (groupIds.length > 0) {
    const prisma = getPrisma();
    if (actor.tokenId) {
      const m = await prisma.groupTokenMember.findFirst({
        where: {
          tokenId: actor.tokenId,
          groupId: { in: groupIds },
          group: { tenantId },
        },
        select: { groupId: true },
      });
      if (m) return;
    } else if (actor.userId) {
      const m = await prisma.groupMember.findFirst({
        where: {
          userId: actor.userId,
          groupId: { in: groupIds },
          group: { tenantId },
        },
        select: { groupId: true },
      });
      if (m) return;
    }
  }
  throw new ForbiddenException(
    "This approval is restricted to its listed approvers. " +
      "Ask one of them to decide, or a workspace owner/admin.",
  );
}

/** Resolve a humanApproval node's title/instructions from the tenant's stored graph. */
export async function accessApprovalPrompt(
  deps: ExecutionsDeps,
  tenantId: string,
  environmentId: string | null,
  workflowKey: string | null,
  nodeId: string,
): Promise<{ title: string; instructions: string | null }> {
  if (!workflowKey) return { title: "Approval required", instructions: null };
  // Best-effort read of the graph for the node's title, IN THE RUN'S OWN ENV (Slice 6) — the run
  // is env-tagged now, so a sandbox run's prompt reads the sandbox graph. A pre-Slice-6 run has no
  // env tag → fall back to the tenant default (where its graph lived).
  const envId =
    environmentId ?? (await deps.environments.defaultEnvId(tenantId));
  const snap = await deps.graphs
    .getLatest(tenantId, envId, workflowKey)
    .catch(() => null);
  const node = snap?.graph.nodes.find((n) => n.id === nodeId);
  const cfg = (node?.config ?? {}) as {
    title?: string;
    instructions?: string;
  };
  return {
    title: cfg.title?.trim() || "Approval required",
    instructions: cfg.instructions?.trim() || null,
  };
}

/** Map one Execution read-model row to a RunSummary (with the non-terminal
 *  Temporal-failure reconcile described on {@link ExecutionsService.list}). */
export async function accessToRunSummary(
  deps: ExecutionsDeps,
  r: {
    workflowId: string;
    workflowKey: string | null;
    status: string;
    costUsd: unknown;
    createdAt: Date;
    finishedAt: Date | null;
    failureKind: string | null;
    archivedAt: Date | null;
    graphVersion: number | null;
  },
): Promise<RunSummary> {
  const createdAt = r.createdAt.toISOString();
  const base = {
    workflowId: r.workflowId,
    workflowKey: r.workflowKey,
    costUsd: r.costUsd !== null ? Number(r.costUsd) : null,
    // startedAt currently mirrors the DB row time; createdAt reads the DB field
    // directly (per its docstring) rather than aliasing startedAt, so a future
    // real Temporal start time can diverge without silently moving createdAt.
    startedAt: createdAt,
    createdAt,
    // Slice 2: worker-stamped terminal time → durationMs. Both null for runs that
    // predate the stamp / closed only at the Temporal level — the UI keeps "—".
    finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
    durationMs: r.finishedAt
      ? Math.max(0, r.finishedAt.getTime() - r.createdAt.getTime())
      : null,
    failureKind: r.failureKind,
    archived: r.archivedAt !== null,
    graphVersion: r.graphVersion,
  };
  if (isTerminalStatus(r.status)) {
    return { ...base, status: r.status as RunSummary["status"] };
  }
  // Non-terminal in PG → reconcile against Temporal (cheap describe only) so
  // a workflow that threw (Temporal-FAILED) isn't shown as forever-running.
  try {
    const desc = await deps.client.workflow.getHandle(r.workflowId).describe();
    const failed = TEMPORAL_FAILED_STATUS[desc.status.name];
    return {
      ...base,
      status: failed ?? (r.status as RunSummary["status"]),
    };
  } catch {
    return { ...base, status: r.status as RunSummary["status"] };
  }
}

/** 404 if the execution is unknown, 403 if it belongs to another tenant. Returns the
 *  row so callers can gate on its workflowKey/environmentId without a second read. */
export async function accessAssertOwner(
  workflowId: string,
  tenantId: string,
): Promise<{
  tenantId: string;
  workflowKey: string | null;
  environmentId: string | null;
}> {
  const row = await getPrisma().execution.findUnique({
    where: { workflowId },
  });
  if (!row) throw new NotFoundException("Execution not found");
  if (row.tenantId !== tenantId) {
    throw new ForbiddenException("Execution belongs to another tenant");
  }
  return row;
}
