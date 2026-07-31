/**
 * `healRun` — the self-healing workflow (Phase 2).
 *
 * A failed run launches this detached; it diagnoses the failure, proposes a graph edit, tells
 * someone, and then WAITS — possibly for days — for a human to approve or reject. Nothing is
 * written to the workflow by this code.
 *
 * WHY A WORKFLOW AND NOT A JOB. The wait is the whole feature. "Generate, notify, then hold state
 * until a person acts, and expire cleanly if they never do" is exactly what durable execution is
 * for, and CLAUDE.md's Tier-1 rule 5 says so outright: human approval is a Signal + condition(),
 * never a poll or a sleep-loop. A cron sweeping a status column would be the wrong tool in a
 * codebase whose entire differentiator is that it does not need one.
 *
 * WHY IT LIVES IN THE API. Diagnosing needs the graph generator and applying needs the save path
 * (save-gate, content hash, version increment, savedBy) — both Nest services here. The main worker
 * has neither, so this workflow and its activities run on their own task queue, polled by a
 * Temporal worker hosted in the API process. The interpreter starts it BY NAME and never carries
 * this code.
 *
 * WHY APPROVAL IS NOT APPLIED HERE. The API's approve endpoint calls `graphs.save()` with the
 * acting principal, which runs the `edit` save-gate — so authorization is enforced by the same
 * code path a manual save uses instead of a second implementation beside the workflow. By the time
 * the signal below arrives, the write has already happened; the workflow records the outcome and
 * stops waiting.
 *
 * DETERMINISTIC WORKFLOW CODE — no I/O, no clock, no randomness. Everything real is an activity.
 */
import * as wf from "@temporalio/workflow";
import { healDecisionSignal, type HealDecisionInput } from "@naary/contracts";
// The INTERFACE, not the module: heal-activities exports a factory (it closes over Nest
// services), so `typeof import(...)` describes the factory rather than the activities.
import type { HealActivities } from "./heal-activities";

/** What the interpreter hands over when a run fails. No run CONTENT — the diagnosis reads that
 *  in-activity, where the current graph is also available. */
export interface HealRunInput {
  runId: string;
  tenantId: string;
  environmentId?: string;
  workflowKey?: string;
  failedNodeId: string;
  failureKind: string;
  /**
   * The failure's message, used to make the dedupe signature SPECIFIC — without it, two different
   * errors on the same node and kind share one signature, so the second is never proposed. The
   * volatile parts (ids, timestamps, numbers) are normalized away in healFailureSignature.
   */
  failureMessage?: string;
}

/**
 * How long a proposal waits before lapsing.
 *
 * It expires rather than lingering because an un-actioned proposal is not harmless: it holds the
 * pending-signature slot, so the SAME failure recurring is deduped against a proposal nobody is
 * going to look at, and the workflow would otherwise sit open forever. Seven days matches
 * APPROVAL_LINK_TTL_SECONDS, so the link in the notification and the proposal it points at stop
 * being valid together — a link that outlives its proposal is a dead end, and a proposal that
 * outlives its link can only be actioned in-app.
 */
const PROPOSAL_TTL_MS = 7 * 24 * 3600 * 1000;

const { diagnoseAndPropose, notifyProposal, expireProposal } =
  wf.proxyActivities<HealActivities>({
    // Generating a fix is a model call; the shared 1-minute budget elsewhere is not enough.
    startToCloseTimeout: "10 minutes",
    // Two attempts, not three: a failed diagnosis costs a proposal nobody sees, while every
    // attempt spends the tenant's BYOK tokens. Retry a transient blip, don't grind.
    retry: { maximumAttempts: 2 },
  });

export async function healRun(input: HealRunInput): Promise<void> {
  let decision: HealDecisionInput | undefined;
  wf.setHandler(healDecisionSignal, (d) => {
    decision = d;
  });

  // Diagnose + persist the proposal. Returns null when there is nothing to do — most often
  // because an OPEN proposal already exists for this exact failure signature, which is how a
  // workflow failing every 5 minutes produces one proposal rather than 288.
  const proposal = await diagnoseAndPropose(input);
  if (!proposal) return;

  // Best-effort: a proposal nobody was told about is still reviewable in the app, so a notify
  // failure must not discard it.
  try {
    await notifyProposal({ proposalId: proposal.id });
  } catch {
    /* the proposal stands on its own — the inbox still lists it */
  }

  // The durable wait. Survives worker restarts and deploys; costs nothing while idle.
  const decided = await wf.condition(
    () => decision !== undefined,
    PROPOSAL_TTL_MS,
  );

  if (!decided) {
    // Nobody acted. Mark it expired so the signature slot frees up and the same failure can be
    // proposed again — otherwise one ignored proposal silences that failure permanently.
    await expireProposal({ proposalId: proposal.id });
  }
  // On a decision there is nothing left to do: the API already recorded it, and applied the fix
  // if it was approved. Returning closes the workflow.
}
