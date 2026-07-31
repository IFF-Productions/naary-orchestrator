/**
 * A Temporal WORKER hosted inside the API process, polling only the self-healing queue.
 *
 * This is unusual enough to justify. `healRun` needs to generate a graph (GraphGeneratorService)
 * and, on approval, save one through the real save path (GraphsService — save-gate, content hash,
 * version increment, savedBy, form-asset ownership). Both are Nest services here. The main worker
 * has neither and there is no worker→API call path. The options were:
 *
 *   1. expose internal write endpoints and give the worker a service credential — a new
 *      service-to-service auth surface, for one feature;
 *   2. re-implement the generator and the save path in the worker — which drifts, demonstrably:
 *      HMAC approval-token minting already exists twice, each copy commented "must match" the
 *      other;
 *   3. run the activities where their dependencies already live.
 *
 * This is (3). Temporal routes by task queue, so a workflow started elsewhere runs here with no
 * coupling beyond a queue name both sides import from @naary/contracts.
 *
 * OPTIONAL AND FAIL-SOFT. The API's job is to serve requests; if this worker cannot start, that
 * must not take the API down with it. A failure here means proposals are not generated — the
 * feature is off — while every other route keeps working.
 */
import { Logger } from "@nestjs/common";
// NativeConnection, not the client's Connection: a Worker polls over the Rust core bridge and
// Worker.create will not accept a client connection.
import { NativeConnection, Worker } from "@temporalio/worker";
import { temporalConnectionConfig } from "@naary/temporal-config";
import { TASK_QUEUE_HEAL } from "@naary/contracts";
import { makeHealActivities } from "./heal-activities";
import type { GraphsService } from "../graphs/graphs.service";
import type { GraphGeneratorService } from "../graphs/graph-generator.service";
import type { Client } from "@temporalio/client";

const log = new Logger("HealWorker");

/** Set `SELF_HEAL_WORKER=off` to keep the API from polling — for a deployment that runs the heal
 *  worker as its own replica, or to disable the feature wholesale during an incident. */
function enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.SELF_HEAL_WORKER ?? "").toLowerCase() !== "off";
}

export interface HealWorkerHandle {
  shutdown(): Promise<void>;
}

export async function startHealWorker(deps: {
  graphs: GraphsService;
  generator: GraphGeneratorService;
  client: Client;
}): Promise<HealWorkerHandle | null> {
  if (!enabled()) {
    log.log("self-heal worker disabled (SELF_HEAL_WORKER=off)");
    return null;
  }
  try {
    const { address, namespace, tls, apiKey, metadata } =
      temporalConnectionConfig();
    // Its OWN connection, not the API client's. A worker polls continuously with long-lived
    // streams; sharing the request-serving connection would couple their failure modes.
    const connection = await NativeConnection.connect({
      address,
      tls,
      apiKey,
      metadata,
    });
    const worker = await Worker.create({
      connection,
      namespace,
      taskQueue: TASK_QUEUE_HEAL,
      workflowsPath: require.resolve("./heal-workflows"),
      activities: makeHealActivities(deps),
      // Small: one proposal at a time is plenty, and each is a model call. Capping this keeps a
      // burst of failures from turning the API process into a generation farm.
      maxConcurrentActivityTaskExecutions: 2,
      maxConcurrentWorkflowTaskExecutions: 4,
    });
    // KEEP the run promise. `Worker.shutdown()` returns void — it only SIGNALS shutdown — and
    // `run()` is what resolves once the worker has actually drained. Discarding it (the first
    // version did) meant `shutdown()` closed the connection while the worker could still be
    // polling on it, which is a shutdown-time error for something that had nothing wrong with it.
    //
    // (Review flagged this as "shutdown() returns a promise you didn't await". It doesn't — the
    // SDK types it `shutdown(): void`. The concern was right and the fix is a different one.)
    const running = worker.run().catch((err: unknown) => {
      log.error(
        `self-heal worker stopped: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    log.log(`self-heal worker polling ${TASK_QUEUE_HEAL}`);
    return {
      async shutdown() {
        worker.shutdown();
        await running;
        await connection.close().catch(() => undefined);
      },
    };
  } catch (err) {
    // Fail SOFT, and say so loudly. A proposal that is never generated is a feature not working;
    // an API that refuses to boot is an outage.
    log.error(
      `could not start the self-heal worker — proposals will not be generated: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}
