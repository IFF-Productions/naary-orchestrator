import "./env"; // MUST be first — loads .env before @naary/* modules evaluate
import { captureError, flushSentry, initSentry } from "@naary/observability";

// Init Sentry before the worker boots. No-op unless SENTRY_DSN is set; events are
// scrubbed of secrets. (Capture is I/O — it lives here + in activities, NEVER in
// the deterministic workflow code.)
initSentry({ component: "worker" });

import { NativeConnection, Worker } from "@temporalio/worker";
import { TASK_QUEUE } from "@naary/contracts";
import { disconnectPrisma } from "@naary/db";
import { createLogger } from "@naary/logging";
import { createKeyEncryptor } from "@naary/secrets";
import * as activities from "./temporal/activities";

// Structured logger for worker BOOT code only. NOT imported by workflows.ts —
// logging is I/O and would break deterministic replay (CLAUDE.md Tier-1 rule 2).
const log = createLogger({ component: "worker" });

/**
 * The worker process: stateless and disposable (CLAUDE.md Tier-1 rule 7).
 * It bundles the deterministic workflow code, registers the activities, and
 * polls the task queue. Execution STATE lives in Temporal, not here — which is
 * why killing and restarting this process mid-pause is safe (see the README
 * durability runbook).
 */
async function run(): Promise<void> {
  // Fail fast at boot if ENCRYPTION_KEY is missing/invalid (mirrors the API),
  // rather than discovering it on the first agent activity (a burned retry).
  createKeyEncryptor();

  const address = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
  const connection = await NativeConnection.connect({ address });
  try {
    const worker = await Worker.create({
      connection,
      taskQueue: TASK_QUEUE,
      workflowsPath: require.resolve("./temporal/workflows"),
      activities,
    });
    log.info({ taskQueue: TASK_QUEUE, address }, "worker polling");
    await worker.run();
  } finally {
    await connection.close();
    await disconnectPrisma(); // close the pg pool the activities opened (Arch§4.9)
    await flushSentry();
  }
}

run().catch((err) => {
  log.fatal(
    { err: err instanceof Error ? err.message : String(err) },
    "worker fatal",
  );
  captureError(err, { where: "worker.run" });
  void flushSentry().finally(() => process.exit(1));
});
