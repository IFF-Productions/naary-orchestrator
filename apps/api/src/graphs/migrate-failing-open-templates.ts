import "../env"; // load DATABASE_URL before @naary/db evaluates
import { disconnectPrisma, getPrisma } from "@naary/db";
import type { GraphDef } from "@naary/dsl";
import {
  applyMigration,
  formatReport,
  type GraphRow,
  planMigration,
} from "./failing-open-migration";
import { GraphsService } from "./graphs.service";

/**
 * Ops CLI: fix the graphs forked from the templates that failed OPEN (#1016).
 *
 * `moderation`, `github-issue-triage` and `jira-ticket` shipped with an agent that asked for
 * JSON in its prompt but declared no `outputSchema`, so every field read downstream was
 * `undefined`. #1015 fixed the templates; a template is COPIED at instantiation, so this reaches
 * the graphs tenants already forked. The moderation one matters most: its gate failed open —
 * every submission auto-accepted, human review unreachable.
 *
 * Runbook:
 *
 *   # 1. Preview. Reports every affected workflow, per tenant, and writes NOTHING.
 *   pnpm --filter @naary/api exec node -r @swc/register src/graphs/migrate-failing-open-templates.ts
 *
 *   # 2. Read the report. `WOULD MIGRATE` lines are exact forks; `FLAGGED ONLY` lines are
 *   #    graphs that merely look similar and are never touched by this script.
 *
 *   # 3. Apply. Writes a NEW version per affected workflow; the previous version stays in
 *   #    history for rollback, attributed and annotated with why it changed.
 *   pnpm --filter @naary/api exec node -r @swc/register src/graphs/migrate-failing-open-templates.ts --apply
 *
 * DRY RUN IS THE DEFAULT — `--apply` is the only thing that writes. This inverts the usual
 * `--dry-run` opt-in of `rotate-master-key.ts` on purpose: this sweep edits tenant-authored
 * workflows and publishes a new LATEST version, which changes what runs in production for an
 * active workflow. That is the point (the alternative is leaving a safety control broken), but
 * it has to be a decision someone made after reading the report, not the default behaviour of
 * running the command.
 *
 * In-flight runs are unaffected: a run is started with the graph BYTES as its first Temporal
 * workflow argument (`executions.service.ts` startGraph), so it walks the snapshot it began
 * with and never re-reads the definition. The one exception is a `executeSubWorkflow` / `forEach`
 * child, which resolves the child's latest version when that node runs — so a parked parent
 * whose child gets migrated will call the FIXED child, which is the desired direction here.
 *
 * Exits non-zero if any workflow failed to save, so a runbook can catch a partial sweep.
 */
async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");

  // The LATEST version of every workflow, in every environment, for every tenant. Not filtered
  // by workflowKey: a template is forked into a NEW workflow under a key the USER chooses (the
  // Templates screen derives it from the display name), so the key tells us nothing about
  // provenance. `distinct` + a workflowKey-led order pushes a Postgres DISTINCT ON, so only the
  // newest body per key crosses the wire — the `connectionUsageCounts` pattern.
  //
  // No alias resolution needed on the way back into `upsert` (which REFUSES a retired key):
  // `WorkflowKeyRenameService` rewrites `GraphDefinition.workflowKey` itself
  // (`tx.graphDefinition.updateMany({ where: byKey, data: move })`), so a row's key is always
  // the live one. Reading it back out is reading the current name by construction.
  //
  // One pass, everything in memory. This is a one-off ops sweep over graph definitions (not
  // runs), so the working set is small; if a deployment ever outgrows that, batch by tenant.
  const rows = await getPrisma().graphDefinition.findMany({
    orderBy: [
      { tenantId: "asc" },
      { environmentId: "asc" },
      { workflowKey: "asc" },
      { version: "desc" },
    ],
    distinct: ["tenantId", "environmentId", "workflowKey"],
    select: {
      tenantId: true,
      environmentId: true,
      workflowKey: true,
      name: true,
      version: true,
      graph: true,
    },
  });

  const graphRows: GraphRow[] = rows.map((r) => ({
    tenantId: r.tenantId,
    environmentId: r.environmentId,
    workflowKey: r.workflowKey,
    name: r.name,
    version: r.version,
    graph: r.graph as unknown as GraphDef,
  }));

  const plan = planMigration(graphRows);
  const report = await applyMigration(new GraphsService(), plan, {
    dryRun: !apply,
  });

  for (const line of formatReport(report)) {
    // eslint-disable-next-line no-console
    console.log(line);
  }

  const failed = report.outcomes.filter((o) => o.error).length;
  await disconnectPrisma();
  process.exit(failed > 0 ? 1 : 0);
}

void main();
