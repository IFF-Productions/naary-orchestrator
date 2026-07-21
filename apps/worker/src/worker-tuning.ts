/**
 * Worker identity + per-replica capacity knobs (Queue-mode Slice 1). Kept in its own
 * side-effect-free module so it's unit-testable — importing worker.ts runs the boot (`run()`).
 */
import { hostname } from "node:os";
import type { WorkerOptions } from "@temporalio/worker";
import { TASK_QUEUE } from "@naary/contracts";

/** The task queue THIS worker process polls (Queue-mode §3.3). Default `orchestrator`; a heavy
 *  worker sets WORKER_TASK_QUEUE=orchestrator-heavy. ONE queue per process keeps the heartbeat
 *  identity (workerIdentity) 1:1 with a queue and the process-global slot gauge accurate. */
export function resolveTaskQueue(env: NodeJS.ProcessEnv = process.env): string {
  return env.WORKER_TASK_QUEUE?.trim() || TASK_QUEUE;
}

/** Temporal's Duration, derived from WorkerOptions rather than imported from
 *  @temporalio/common — common isn't a direct dep, and adding it would create a second
 *  version pin to keep in lockstep (the @temporalio/* version-skew hazard). */
type Duration = NonNullable<WorkerOptions["shutdownGraceTime"]>;

/** Validate an env value against Temporal's Duration string shape ("30s", "500ms", "1.5m", …).
 *  Invalid/absent → undefined, preserving the SDK's default rather than crashing boot on a typo
 *  (a bad grace value must not take the worker down — it only tunes drain time). */
function parseDuration(v: string | undefined): Duration | undefined {
  const s = v?.trim();
  if (!s) return undefined;
  return /^\d+(\.\d+)?\s?(ms|s|m|h|d|w|y)$/.test(s)
    ? (s as Duration)
    : undefined;
}

/** The deployed version — the tag the deploy stamps (SENTRY_RELEASE), else a dev marker. */
export const WORKER_VERSION =
  process.env.SENTRY_RELEASE ?? process.env.APP_VERSION ?? "dev";

/** A stable, human-readable identity for THIS worker replica, surfaced on every Temporal poller
 *  (and reused by the fleet registry): `<host>/<pid>/<version>`. Lets the fleet be told apart. */
export const workerIdentity = (): string =>
  `${hostname()}/${process.pid}/${WORKER_VERSION}`;

/** A positive integer from env, or undefined (→ the SDK default, so today's behavior is unchanged
 *  unless an operator explicitly sets a knob). */
export function envInt(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export interface WorkerTuning {
  maxConcurrentActivityTaskExecutions?: number;
  maxConcurrentWorkflowTaskExecutions?: number;
  maxCachedWorkflows?: number;
  /** Temporal Duration (e.g. "30s"). Typed as Duration, not string — Worker.create rejects the
   *  wider type (the env value is validated to match Duration's template shape below). */
  shutdownGraceTime?: Duration;
}

/**
 * Per-replica capacity knobs. All optional — unset preserves the SDK defaults, so spreading this into
 * Worker.create never overrides a default with `undefined`. `shutdownGraceTime` is a Temporal
 * duration string (e.g. "30s") so in-flight activities drain on SIGTERM during a deploy.
 */
export function workerTuning(
  env: NodeJS.ProcessEnv = process.env,
): WorkerTuning {
  const grace = parseDuration(env.WORKER_SHUTDOWN_GRACE);
  const activities = envInt("WORKER_MAX_ACTIVITIES", env);
  const workflowTasks = envInt("WORKER_MAX_WORKFLOW_TASKS", env);
  const cached = envInt("WORKER_MAX_CACHED_WORKFLOWS", env);
  return {
    ...(activities !== undefined && {
      maxConcurrentActivityTaskExecutions: activities,
    }),
    ...(workflowTasks !== undefined && {
      maxConcurrentWorkflowTaskExecutions: workflowTasks,
    }),
    ...(cached !== undefined && { maxCachedWorkflows: cached }),
    ...(grace ? { shutdownGraceTime: grace } : {}),
  };
}
