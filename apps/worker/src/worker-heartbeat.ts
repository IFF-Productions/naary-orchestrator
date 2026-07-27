/**
 * Worker heartbeat (Queue-mode Slice 2): every {@link HEARTBEAT_INTERVAL_MS} this replica upserts a
 * WorkerHeartbeat row with its live slot usage, so the control plane's Worker view can show the
 * fleet. Written DIRECTLY to the DB (the worker already holds a prisma connection for the
 * execution/usage ledgers) — no extra API surface, no internal token.
 *
 * Best-effort by design: a heartbeat failure is logged and swallowed — it must NEVER affect run
 * execution (Tier-1 fail-safe philosophy). Infra telemetry only: NO tenant data, NO secrets.
 * Boot/infra code, not a workflow, so `Date.now()`/timers are fine (they'd only break replay in
 * workflows.ts).
 */
import { getPrisma } from "@naary/db";
import type { Logger } from "@naary/logging";
import { activeActivities } from "./temporal/activity-gauge";
import { WORKER_VERSION, workerIdentity } from "./worker-tuning";
import { heartbeatEnabled } from "./config";

export const HEARTBEAT_INTERVAL_MS = 15_000;

export interface HeartbeatInfo {
  taskQueue: string;
  host: string;
  /** Configured activity-slot capacity (WORKER_MAX_ACTIVITIES, else the SDK default). */
  maxActivities: number;
}

/** Build the row for one beat — the identity + config plus the live active-activity count. */
export function heartbeatRow(info: HeartbeatInfo, now: Date) {
  return {
    identity: workerIdentity(),
    taskQueue: info.taskQueue,
    version: WORKER_VERSION(),
    host: info.host,
    activeActivities: activeActivities(),
    maxActivities: info.maxActivities,
    lastSeen: now,
  };
}

/** Upsert one heartbeat. Never throws — resolves even on DB failure (logged by the caller). */
async function beat(info: HeartbeatInfo): Promise<void> {
  const row = heartbeatRow(info, new Date());
  const { identity, ...rest } = row;
  await getPrisma().workerHeartbeat.upsert({
    where: { identity },
    create: row,
    update: rest,
  });
}

/**
 * Start emitting heartbeats (immediately, then every interval). Returns a `stop()` that clears the
 * timer and best-effort deletes this replica's row so it leaves the fleet view promptly on a graceful
 * shutdown (a crash just goes stale — GET /workers marks it offline by lastSeen age). Off when
 * `WORKER_HEARTBEAT=off`.
 */
export function startHeartbeat(
  info: HeartbeatInfo,
  log: Pick<Logger, "warn">,
  env: NodeJS.ProcessEnv = process.env,
): { stop: () => Promise<void> } {
  if (!heartbeatEnabled(env)) return { stop: async () => {} };

  const tick = () => {
    void beat(info).catch((err) => {
      log.warn(
        { err: err instanceof Error ? err.name : "unknown" },
        "worker heartbeat failed (ignored)",
      );
    });
  };
  tick(); // appear in the fleet immediately
  const timer = setInterval(tick, HEARTBEAT_INTERVAL_MS);

  return {
    stop: async () => {
      clearInterval(timer);
      // Best-effort self-removal on graceful shutdown; ignore failure (staleness covers it).
      await getPrisma()
        .workerHeartbeat.delete({ where: { identity: workerIdentity() } })
        .catch(() => undefined);
    },
  };
}
