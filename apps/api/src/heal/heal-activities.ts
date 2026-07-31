/**
 * Activities for `healRun` (Phase 2), hosted in the API process.
 *
 * They live here rather than in the worker because what they do lives here: diagnosing needs the
 * CURRENT graph and the AI generator, and both are Nest services. See TASK_QUEUE_HEAL for the
 * alternatives that were rejected (a service-to-service HTTP surface; a second copy of the
 * generator and the save path).
 *
 * Built by a FACTORY that closes over the resolved services, because Temporal activities are
 * plain functions and Nest injection is constructor-based — the boot code resolves the providers
 * once and hands them in.
 */
import { Logger } from "@nestjs/common";
import type { Client } from "@temporalio/client";
import { stateQuery } from "@naary/contracts";
import { getPrisma } from "@naary/db";
import { buildFixInstruction, diffGraphs, type GraphDef } from "@naary/dsl";
import type { GraphsService } from "../graphs/graphs.service";
import type { GraphGeneratorService } from "../graphs/graph-generator.service";
import type { HealRunInput } from "./heal-workflow";
import { healFailureSignature } from "./heal-signature";

const log = new Logger("HealActivities");

/** What `diagnoseAndPropose` hands back; null means "nothing to propose". */
export interface ProposalRef {
  id: string;
}

export interface HealActivities {
  diagnoseAndPropose(input: HealRunInput): Promise<ProposalRef | null>;
  notifyProposal(input: { proposalId: string }): Promise<void>;
  expireProposal(input: { proposalId: string }): Promise<void>;
}

/** Longest we describe a failure in the inbox row. The full text lives in the run, not here. */
const SUMMARY_MAX = 400;

export function makeHealActivities(deps: {
  graphs: GraphsService;
  generator: GraphGeneratorService;
  client: Client;
  notify?: (proposalId: string) => Promise<void>;
}): HealActivities {
  const { graphs, generator, client, notify } = deps;

  /**
   * Read the failed run's ctx and error by QUERYING the closed workflow.
   *
   * The parent could have passed its ctx directly — it had it in memory — but it only has its own
   * pinned SNAPSHOT of the graph, and the diagnosis must describe the node as the CURRENT graph
   * defines it (the same mistake Copilot caught in `useFixFromRun`). So the ctx is read here,
   * where the current graph is also available.
   *
   * A closed workflow can still be queried; that is proven against a real Temporal in
   * `closed-run-query.e2e.spec.ts`. Returns an empty ctx rather than throwing when the query is
   * unavailable — `buildFixInstruction` is then told the outputs were UNREADABLE, which is a
   * different and honest thing to say versus "the node reads nothing".
   */
  async function readClosedRun(
    runId: string,
  ): Promise<{ ctx: Record<string, unknown>; readable: boolean }> {
    try {
      const s = await client.workflow.getHandle(runId).query(stateQuery);
      const ctx = s.ctx;
      if (ctx && typeof ctx === "object" && !Array.isArray(ctx)) {
        return { ctx: ctx as Record<string, unknown>, readable: true };
      }
    } catch (err) {
      log.warn(
        `heal: could not read run ${runId} state: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return { ctx: {}, readable: false };
  }

  return {
    async diagnoseAndPropose(input) {
      const { tenantId, environmentId, workflowKey, runId } = input;
      if (!environmentId || !workflowKey) return null;

      const signature = healFailureSignature({
        failedNodeId: input.failedNodeId,
        failureKind: input.failureKind,
        message: input.failureMessage ?? null,
      });

      // DEDUPE BEFORE SPENDING ANYTHING. The partial unique index is the authority — it is what
      // makes the guarantee hold under a race — but relying on it alone means every duplicate
      // failure still pays for a model call and only gets rejected at INSERT. For a workflow
      // failing every 5 minutes that is the entire cost the dedupe exists to avoid.
      //
      // (The first version had this comment above the signature and no query beneath it, so it
      // described behaviour the code did not have. Review caught it.)
      const open = await getPrisma().workflowFixProposal.findFirst({
        where: {
          tenantId,
          environmentId,
          workflowKey,
          failureSignature: signature,
          status: { in: ["pending", "applying"] },
        },
        select: { id: true },
      });
      if (open) {
        log.log(
          `heal: ${workflowKey} already has an open proposal for this failure; not generating another`,
        );
        return null;
      }

      const current = await graphs.getLatest(
        tenantId,
        environmentId,
        workflowKey,
      );
      if (!current) return null; // the workflow is gone — nothing to fix

      const { ctx, readable } = await readClosedRun(runId);

      const { instruction } = buildFixInstruction({
        graph: current.graph,
        failedNodeId: input.failedNodeId,
        failureKind: input.failureKind,
        error: input.failureMessage ?? null,
        ctx,
        ctxAvailable: readable,
      });

      // The model call. Metered like any other — `editStream` returns a GenMeter, and billing a
      // heal exactly as a manual edit is billed is the point: this spends the tenant's BYOK
      // budget, so it must be visible in the same ledger.
      const { graph: proposed } = await generator.editStream(
        tenantId,
        environmentId,
        { previous: current.graph, instruction },
      );

      const diff = diffGraphs(current.graph, proposed as GraphDef);
      const total =
        diff.nodesAdded.length +
        diff.nodesRemoved.length +
        diff.nodesChanged.length +
        diff.edgesAdded.length +
        diff.edgesRemoved.length +
        (diff.startNodeChanged ? 1 : 0) +
        (diff.edgesReordered ? 1 : 0);

      // A "fix" that changes nothing is not a proposal. Storing it would put a row in someone's
      // inbox whose diff is empty and whose approval would write an identical version.
      if (total === 0) {
        log.log(`heal: model proposed no change for ${workflowKey}; dropping`);
        return null;
      }

      try {
        const row = await getPrisma().workflowFixProposal.create({
          data: {
            tenantId,
            environmentId,
            workflowKey,
            runId,
            failureSignature: signature,
            // The inbox line. The run's own error message — already on the run detail — never
            // node OUTPUT content, which stays out of this table entirely.
            failureSummary: `${input.failedNodeId}: ${
              input.failureMessage?.trim() || input.failureKind
            }`.slice(0, SUMMARY_MAX),
            baseVersion: current.version,
            proposedGraph: proposed as object,
            diffSummary: {
              add: diff.nodesAdded.length + diff.edgesAdded.length,
              chg:
                diff.nodesChanged.length +
                (diff.startNodeChanged ? 1 : 0) +
                (diff.edgesReordered ? 1 : 0),
              del: diff.nodesRemoved.length + diff.edgesRemoved.length,
              total,
            },
          },
          select: { id: true },
        });
        return { id: row.id };
      } catch (err) {
        // ONLY a unique-constraint violation means "the dedupe raced us", and only that is safe to
        // treat as success. Swallowing every error here would turn a DB outage into a silent
        // "nothing to propose" — a generated fix the tenant already paid for, dropped without a
        // trace. Anything else rethrows so the activity retries and the failure is visible.
        if ((err as { code?: string }).code === "P2002") {
          log.log(
            `heal: a pending proposal already exists for ${workflowKey} (${signature.slice(0, 60)}…)`,
          );
          return null;
        }
        throw err;
      }
    },

    async notifyProposal({ proposalId }) {
      // Wired to the existing notification channels by slice 6; until then the proposal is
      // reachable in the app. Deliberately not a silent no-op forever — it logs, so an
      // un-notified proposal is visible in the API log rather than only in the inbox.
      if (notify) {
        await notify(proposalId);
        return;
      }
      log.log(
        `heal: proposal ${proposalId} awaiting review (no channel wired)`,
      );
    },

    async expireProposal({ proposalId }) {
      // Only a PENDING row expires. A decision that landed in the same moment the timer fired must
      // win — the human acted, and overwriting that with "expired" would discard a real decision.
      await getPrisma().workflowFixProposal.updateMany({
        where: { id: proposalId, status: "pending" },
        data: { status: "expired" },
      });
    },
  };
}
