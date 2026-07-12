import "./env"; // MUST be first — loads .env before @naary/* modules evaluate
import { initMetrics } from "@naary/metrics";
import {
  captureError,
  flushSentry,
  initSentry,
  traceActivities,
} from "@naary/observability";

// Init Sentry before the worker boots. No-op unless SENTRY_DSN is set; events are
// scrubbed of secrets. (Capture is I/O — it lives here + in activities, NEVER in
// the deterministic workflow code.)
initSentry({ component: "worker" });
// Tag metrics with the component + collect default Node/process metrics.
initMetrics({ component: "worker" });

import { createServer } from "node:http";
import { NativeConnection, Worker } from "@temporalio/worker";
import { TASK_QUEUE } from "@naary/contracts";
import { disconnectPrisma } from "@naary/db";
import { createLogger } from "@naary/logging";
import { metricsContentType, renderMetrics } from "@naary/metrics";
import { createKeyEncryptor } from "@naary/secrets";
import { temporalConnectionConfig } from "@naary/temporal-config";
import * as activities from "./temporal/activities";

// Structured logger for worker BOOT code only. NOT imported by workflows.ts —
// logging is I/O and would break deterministic replay (CLAUDE.md Tier-1 rule 2).
const log = createLogger({ component: "worker" });

/** The worker has no HTTP server, so expose /metrics on its own small server for
 *  Prometheus to scrape. Off if METRICS_PORT=0. */
function startMetricsServer(): { close: () => void } | undefined {
  const port = Number(process.env.METRICS_PORT ?? 9091);
  if (!port) return undefined;
  const server = createServer((req, res) => {
    if (req.url === "/metrics") {
      renderMetrics()
        .then((text) => {
          res.writeHead(200, { "content-type": metricsContentType });
          res.end(text);
        })
        .catch(() => {
          res.writeHead(500);
          res.end();
        });
    } else if (req.url === "/healthz") {
      res.writeHead(200);
      res.end("ok");
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(port, () => log.info({ port }, "worker metrics server"));
  return { close: () => server.close() };
}

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

  const metricsServer = startMetricsServer();

  // Connection options (TLS / API-key / namespace) from env, defaulting to the
  // local dev server — Temporal Cloud needs only env, no code change.
  const { address, namespace, tls, apiKey, metadata } =
    temporalConnectionConfig();
  const connection = await NativeConnection.connect({
    address,
    tls,
    apiKey,
    metadata,
  });
  try {
    const worker = await Worker.create({
      connection,
      namespace,
      taskQueue: TASK_QUEUE,
      workflowsPath: require.resolve("./temporal/workflows"),
      // Wrap each activity so its execution is a span (activity.<name>). Preserves the
      // object keys, so Temporal's dispatch-by-name is unchanged. Each activity span is a
      // ROOT span (its own trace) — trace context can't cross the Temporal boundary without
      // putting non-deterministic data through workflow code; correlate via tenantId/executionId.
      activities: traceActivities(activities),
    });
    log.info({ taskQueue: TASK_QUEUE, address, namespace }, "worker polling");
    await worker.run();
  } finally {
    metricsServer?.close();
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
