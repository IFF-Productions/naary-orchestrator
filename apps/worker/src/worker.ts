import "./env"; // MUST be first — loads .env before @naary/* modules evaluate
import { initMetrics } from "@naary/metrics";
import {
  captureError,
  flushSentry,
  initOtlp,
  initSentry,
  shutdownOtlp,
  traceActivities,
} from "@naary/observability";

// Init Sentry before the worker boots. No-op unless SENTRY_DSN is set; events are
// scrubbed of secrets. (Capture is I/O — it lives here + in activities, NEVER in
// the deterministic workflow code.)
initSentry({ component: "worker" });
// Tag metrics with the component + collect default Node/process metrics.
initMetrics({ component: "worker" });
// Wire the OTLP metric exporter (Datadog/OTLP). No-op unless OTEL_EXPORTER_OTLP_ENDPOINT
// is set; attributes are scrubbed on egress (see @naary/observability otlp.ts).
initOtlp({ component: "worker" });

import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { hostname } from "node:os";
import { join } from "node:path";
import { NativeConnection, Worker } from "@temporalio/worker";
import { disconnectPrisma } from "@naary/db";
import { createLogger } from "@naary/logging";
import { metricsContentType, renderMetrics } from "@naary/metrics";
import { assertSecretProviderConfig, createKeyEncryptor } from "@naary/secrets";
import { temporalConnectionConfig } from "@naary/temporal-config";
import { sentryTraceActivityInterceptors } from "./temporal/activity-trace-interceptor";
import * as activities from "./temporal/activities";
import { logActivities } from "./temporal/log-activities";
import { countActivities } from "./temporal/activity-gauge";
import { startHeartbeat } from "./worker-heartbeat";
import {
  resolveTaskQueue,
  workerIdentity,
  workerTuning,
} from "./worker-tuning";

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
  // Same reasoning for the external secret store (#458): a `SECRET_PROVIDER=vault` with
  // missing VAULT_ADDR/VAULT_TOKEN must stop startup, not fail inside the first agent
  // activity. Logs the MODE only — never the token. The api asserts the same thing in
  // SecretsModule, so a half-configured fleet can't have the api writing to Vault while a
  // worker reads from Postgres.
  log.info({ secretStore: assertSecretProviderConfig() }, "secret store mode");

  const metricsServer = startMetricsServer();

  // The queue this process polls (Queue-mode §3.3): default `orchestrator`; a heavy worker sets
  // WORKER_TASK_QUEUE=orchestrator-heavy. One queue per process → one heartbeat identity.
  const taskQueue = resolveTaskQueue();

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
    // Prefer the PREBUILT workflow bundle (produced at image-build time by
    // scripts/build-workflow-bundle.cjs) so the worker does NOT run an in-process webpack
    // compile at boot — that ~4.3MB build spiked RSS and OOM-killed the worker during 2x-scale
    // rolling deploys on the 8GB box (fix #676). Fall back to runtime bundling from source when
    // the file is absent (local dev / a plain checkout), so `npm run worker` is unchanged.
    const prebuiltBundlePath = join(
      __dirname,
      "..",
      "dist",
      "workflow-bundle.js",
    );
    const usePrebuilt = existsSync(prebuiltBundlePath);
    log.info(
      { source: usePrebuilt ? "prebuilt-bundle" : "runtime-bundle" },
      "workflow code source",
    );
    const worker = await Worker.create({
      connection,
      namespace,
      taskQueue,
      // Identify this replica on every Temporal poller (Queue-mode Slice 1) so the fleet can be
      // told apart; the registry keys on it. Capacity/drain knobs come from env (unset → defaults).
      identity: workerIdentity(),
      ...workerTuning(),
      // Prebuilt: load the finished V8-isolate bundle (no webpack at boot). Dev: bundle from
      // source. With a prebuilt bundle, workflowsPath is ignored — so set only one.
      ...(usePrebuilt
        ? { workflowBundle: { codePath: prebuiltBundlePath } }
        : { workflowsPath: require.resolve("./temporal/workflows") }),
      // Wrap each activity inner→outer: countActivities tracks live slot usage (the heartbeat
      // reports it); logActivities emits a completion line so every side-effecting node is visible;
      // traceActivities opens the `activity.<name>` span AROUND that log so the line is stamped with
      // the span's trace id (→ Sentry Logs). All preserve the object keys, so Temporal's
      // dispatch-by-name is unchanged.
      activities: traceActivities(
        logActivities(countActivities(activities), log),
      ),
      // Distributed tracing across the Temporal boundary (one connected Sentry trace for
      // API→workflow→activity). The WORKFLOW-side interceptor is sandbox-bundled: with a prebuilt
      // bundle it's baked in via bundleWorkflowCode's workflowInterceptorModules (Worker.create's
      // workflowModules would be IGNORED there — Temporal warns), so only pass it in the
      // runtime-bundle path. The ACTIVITY interceptor runs in the main thread → always here.
      interceptors: {
        ...(usePrebuilt
          ? {}
          : {
              workflowModules: [
                require.resolve("./temporal/workflow-trace-interceptors"),
              ],
            }),
        activity: [sentryTraceActivityInterceptors],
      },
    });
    log.info(
      {
        taskQueue,
        address,
        namespace,
        identity: workerIdentity(),
        ...workerTuning(),
      },
      "worker polling",
    );
    // Fleet heartbeat: emit live slot usage to the WorkerHeartbeat registry while polling. Best-effort
    // (never affects execution). maxActivities = the configured cap, else the SDK default (100).
    const heartbeat = startHeartbeat(
      {
        taskQueue,
        host: hostname(),
        maxActivities:
          workerTuning().maxConcurrentActivityTaskExecutions ?? 100,
      },
      log,
    );
    try {
      await worker.run();
    } finally {
      await heartbeat.stop();
    }
  } finally {
    metricsServer?.close();
    await connection.close();
    await disconnectPrisma(); // close the pg pool the activities opened (Arch§4.9)
    await flushSentry();
    await shutdownOtlp(); // flush buffered OTLP metrics before exit (batched ~60s)
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
