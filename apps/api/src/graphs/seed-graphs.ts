import "../env"; // load DATABASE_URL before @naary/db evaluates
import { disconnectPrisma } from "@naary/db";
import { githubReviewGraph, sampleGraph, webhookSampleGraph } from "@naary/dsl";
import { GraphsService } from "./graphs.service";

/**
 * Seed a tenant's graph definitions (idempotent — re-running with the same graphs
 * is a no-op, by content hash):
 *   pnpm --filter @naary/api exec ts-node src/graphs/seed-graphs.ts <tenantId>
 *
 * - `default`       → the support-triage demo POST /executions starts
 * - `wf-default`    → the webhook sample flow
 * - `github-review` → the GitHub PR-review reference flow
 */
async function main(): Promise<void> {
  const tenantId = process.argv[2];
  if (!tenantId) {
    console.error("usage: ts-node src/graphs/seed-graphs.ts <tenantId>");
    process.exit(1);
  }
  const graphs = new GraphsService();
  const seeds: [string, string, typeof sampleGraph][] = [
    ["default", "Support triage (demo)", sampleGraph],
    ["wf-default", "Webhook sample", webhookSampleGraph],
    ["github-review", "GitHub PR review", githubReviewGraph],
  ];
  for (const [key, name, graph] of seeds) {
    const snap = await graphs.upsert(tenantId, key, name, graph);
    // eslint-disable-next-line no-console
    console.log(
      `seeded ${key} v${snap.version} (${snap.contentHash.slice(0, 12)}…)`,
    );
  }
  await disconnectPrisma();
  process.exit(0);
}

void main();
