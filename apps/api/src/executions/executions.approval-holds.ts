import { WorkflowNotFoundError, type Client } from "@temporalio/client";
import { stateQuery } from "@naary/contracts";
import { getPrisma } from "@naary/db";
import { awaitingRecord } from "./executions.helpers";

/**
 * "Which paused runs was this person the approver on?" — the read behind the
 * removal-time warning (#1053).
 *
 * WHY IT EXISTS. A `humanApproval` gate snapshots its approver routing into
 * `ctx.__approval` at PAUSE time and never re-reads it (the worker's
 * `prepareApproval`; the record's shape is `ApprovalAwaitingRecord`). The snapshot is
 * deliberate and stays: an in-flight run's routing must not shift under a later graph
 * edit, exactly as its graph version is pinned. It is not an authz hole either —
 * decide-time enforcement (`accessAssertApprover`) re-checks the LIVE database, so a
 * de-provisioned user is refused before they can approve. What the snapshot cannot do
 * is notice that the person it names has left, and that is a LIVENESS problem: with no
 * `timeoutHours` the gate is `wf.condition(...)` with no deadline, so the run parks
 * forever unless an owner/admin (or the HMAC signed link) decides it. Nothing told the
 * admin at removal time that this was about to happen.
 *
 * THE EMAIL/GROUP ASYMMETRY — the reason this is a FILTERED count, not `queryAwaiting`
 * with a `.filter()` on it. The snapshot freezes `approvers.emails[]` verbatim, but it
 * freezes groups as `{ id, name }` — IDS ONLY. Decide time then resolves group
 * membership LIVE (`groupMember.findFirst`). So the two routing modes strand very
 * differently:
 *
 *  - EMAIL-routed: frozen. Remove that person and nobody on the list can decide.
 *  - GROUP-routed: not stranded at all while anyone else is in the group — and it
 *    un-strands itself the moment someone is added to that group.
 *
 * Counting both alike would fire the banner on essentially every removal in a workspace
 * that routes compliance gates by group, which is the cry-wolf failure the warning is
 * supposed to avoid. So `needsOwnerOrAdmin` — the number the UI leads with — counts only
 * the runs with NO approver identity left, resolved against live data in two batched
 * reads for the whole scan.
 *
 * Not `queryAwaiting` itself: that does a per-run GRAPH read to render each approval
 * prompt, which this has no use for.
 */

/** Scanned newest-first; more awaiting runs than this ⇒ `partial` (a LOWER BOUND). */
const SCAN_MAX = 100;
/** Concurrent Temporal queries. One `stateQuery` per candidate run is the cost here. */
const SCAN_CONCURRENCY = 8;
/**
 * Wall-clock budget for the whole scan. This runs INSIDE a `DELETE` that a bulk
 * de-provision loop may call once per user, so it is deliberately short: a slow or
 * degraded Temporal must cost the removal ~2s, not ~2s × every awaiting run. Whatever
 * the budget cuts off is reported as `partial`, never as "none".
 */
const SCAN_BUDGET_MS = 2_000;
/** Runs echoed back in the response body (the counts stay whole). */
const RUNS_CAP = 20;

/** The removed person's approver identity, captured BEFORE the delete — their group
 *  rows are gone afterwards, so the ids cannot be re-read. */
export interface ApproverIdentity {
  /** Membership email, lower-cased by the caller or not — matching is insensitive. */
  email: string | null;
  /** `PermissionGroup` ids they belonged to in THIS workspace. */
  groupIds: string[];
}

export interface HeldApprovalRun {
  workflowId: string;
  workflowKey: string | null;
  /** The paused `humanApproval` node. */
  nodeId: string;
  /** No listed approver identity is left — only an owner/admin (or the signed link) can
   *  decide this now. */
  needsOwnerOrAdmin: boolean;
}

export interface HeldApprovals {
  /** Paused runs whose frozen approver snapshot named this person. */
  total: number;
  /** Of those, the ones with nobody left to decide. The headline number. */
  needsOwnerOrAdmin: number;
  /**
   * The counts are a LOWER BOUND: the candidate list was truncated, the time budget ran
   * out, or the lookup failed outright. `true` with zero counts means "could not check",
   * NOT "none" — the UI must not claim a clean removal it did not verify.
   */
  partial: boolean;
  /** Up to {@link RUNS_CAP} of them, `needsOwnerOrAdmin` first. */
  runs: HeldApprovalRun[];
}

export const NO_HELD_APPROVALS: HeldApprovals = {
  total: 0,
  needsOwnerOrAdmin: 0,
  partial: false,
  runs: [],
};

/** What could not be determined, stated as such (see {@link HeldApprovals.partial}). */
export const UNKNOWN_HELD_APPROVALS: HeldApprovals = {
  ...NO_HELD_APPROVALS,
  partial: true,
};

/**
 * Reject if `p` has not settled within `ms`. A degraded Temporal answers by HANGING, not by
 * erroring, so the pre-dispatch deadline check alone would not bound anything — the very
 * first batch of queries would sit there and hold up the `DELETE` that is waiting on this.
 * The timer is `unref`'d so a pending race can never keep the process alive.
 */
function raceDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0)
    return Promise.reject(new Error("approval scan budget exhausted"));
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("approval scan budget exhausted")),
        ms,
      );
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

/** One matched run, before the live remaining-approver resolution. */
interface Matched {
  workflowId: string;
  workflowKey: string | null;
  nodeId: string;
  /** Every email on the snapshot (the removed person's included — filtered out below). */
  emails: string[];
  /** Every group id on the snapshot. */
  groupIds: string[];
}

/**
 * Paused runs in `tenantId` whose approver snapshot names {@link identity}.
 *
 * BOUNDED on purpose (this is a request handler): at most {@link SCAN_MAX} candidate
 * runs, at most {@link SCAN_CONCURRENCY} Temporal queries in flight, and a hard
 * {@link SCAN_BUDGET_MS} deadline that each query is RACED against (not merely checked
 * before dispatch — an unreachable Temporal makes queries hang, and a hang is exactly the
 * case where the caller must not be held up).
 *
 * A `WorkflowNotFoundError` means that one run's history is gone; it is skipped and the
 * answer stays exact, as `queryAwaiting` treats it. ANY OTHER query failure is a service
 * problem, not a fact about that run, so it marks the answer {@link HeldApprovals.partial}
 * — otherwise a total Temporal outage would report "nothing stranded", which is the one
 * answer worse than saying nothing.
 *
 * NEVER THROWS. The caller is a member removal that has already committed; a failure to
 * report is not a reason to fail the removal, so every failure mode degrades to
 * {@link UNKNOWN_HELD_APPROVALS}.
 */
export async function findHeldApprovals(
  client: Client,
  tenantId: string,
  identity: ApproverIdentity,
  now: () => number = Date.now,
): Promise<HeldApprovals> {
  const email = identity.email?.trim().toLowerCase() || null;
  const ownGroups = new Set(identity.groupIds);
  // No identity to match on ⇒ nothing can name them. Not "partial": this is a complete
  // answer, and it costs zero Temporal queries.
  if (!email && ownGroups.size === 0) return NO_HELD_APPROVALS;

  try {
    const rows = await getPrisma().execution.findMany({
      where: { tenantId, status: "awaiting_approval" },
      orderBy: { createdAt: "desc" },
      take: SCAN_MAX + 1, // +1 only to detect truncation
      select: { workflowId: true, workflowKey: true },
    });
    let partial = rows.length > SCAN_MAX;
    const candidates = rows.slice(0, SCAN_MAX);

    const deadline = now() + SCAN_BUDGET_MS;
    const matched: Matched[] = [];
    let next = 0;
    let aborted = false; // a service-level failure — stop paying for more of them
    const worker = async (): Promise<void> => {
      for (;;) {
        if (aborted || next >= candidates.length) return;
        if (now() >= deadline) {
          partial = true; // the rest is unscanned — say so rather than imply "none"
          return;
        }
        const row = candidates[next++];
        let m: Matched | null = null;
        try {
          const s = await raceDeadline(
            client.workflow.getHandle(row.workflowId).query(stateQuery),
            deadline - now(),
          );
          // Decided/advanced since the read-model write, or closed → not awaiting.
          if (s.status !== "awaiting_approval") continue;
          const approvers = awaitingRecord(s)?.approvers;
          if (!approvers) continue; // an unrouted gate names nobody
          const emails = (approvers.emails ?? []).filter(Boolean);
          const groupIds = (approvers.groups ?? [])
            .map((g) => g.id)
            .filter(Boolean);
          const named =
            (email !== null && emails.some((e) => e.toLowerCase() === email)) ||
            groupIds.some((g) => ownGroups.has(g));
          if (!named) continue;
          m = {
            workflowId: row.workflowId,
            workflowKey: row.workflowKey,
            nodeId: s.currentNodeId,
            emails,
            groupIds,
          };
        } catch (e) {
          // A history that is genuinely gone is a FACT about that run — skip it and keep
          // the answer exact. Anything else is the service, and must not read as "none".
          if (e instanceof WorkflowNotFoundError) continue;
          partial = true;
          aborted = true;
          return;
        }
        matched.push(m);
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(SCAN_CONCURRENCY, candidates.length) },
        () => worker(),
      ),
    );

    const runs = await resolveRemaining(tenantId, email, matched);
    // needsOwnerOrAdmin first, so a capped list shows the ones that actually need a hand.
    runs.sort(
      (a, b) => Number(b.needsOwnerOrAdmin) - Number(a.needsOwnerOrAdmin),
    );
    return {
      total: runs.length,
      needsOwnerOrAdmin: runs.filter((r) => r.needsOwnerOrAdmin).length,
      partial,
      runs: runs.slice(0, RUNS_CAP),
    };
  } catch {
    return UNKNOWN_HELD_APPROVALS;
  }
}

/**
 * Fill in `needsOwnerOrAdmin` for every matched run in TWO batched reads, against live
 * data (so it must run AFTER the membership/group rows are deleted — the removed person
 * must not count as their own remaining approver).
 *
 * An email counts as remaining only if it still holds a Membership in this workspace; a
 * group counts as remaining only if it still has at least one member. Both are exactly
 * what `accessAssertApprover` will consult when someone tries to decide.
 */
async function resolveRemaining(
  tenantId: string,
  removedEmail: string | null,
  matched: Matched[],
): Promise<HeldApprovalRun[]> {
  if (matched.length === 0) return [];
  const prisma = getPrisma();
  const emails = [
    ...new Set(
      matched.flatMap((m) =>
        m.emails.map((e) => e.toLowerCase()).filter((e) => e !== removedEmail),
      ),
    ),
  ];
  const groupIds = [...new Set(matched.flatMap((m) => m.groupIds))];

  const [members, groupMembers] = await Promise.all([
    emails.length
      ? prisma.membership.findMany({
          where: { tenantId, email: { in: emails, mode: "insensitive" } },
          select: { email: true },
        })
      : Promise.resolve([] as { email: string | null }[]),
    groupIds.length
      ? prisma.groupMember.findMany({
          where: { groupId: { in: groupIds }, group: { tenantId } },
          select: { groupId: true },
        })
      : Promise.resolve([] as { groupId: string }[]),
  ]);
  const liveEmails = new Set(
    members.map((m) => (m.email ?? "").toLowerCase()).filter(Boolean),
  );
  const liveGroups = new Set(groupMembers.map((g) => g.groupId));

  return matched.map((m) => ({
    workflowId: m.workflowId,
    workflowKey: m.workflowKey,
    nodeId: m.nodeId,
    needsOwnerOrAdmin: !(
      m.emails.some(
        (e) =>
          e.toLowerCase() !== removedEmail && liveEmails.has(e.toLowerCase()),
      ) || m.groupIds.some((g) => liveGroups.has(g))
    ),
  }));
}
