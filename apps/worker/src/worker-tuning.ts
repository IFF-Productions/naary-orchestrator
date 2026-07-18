/**
 * Worker identity + per-replica capacity knobs (Queue-mode Slice 1). Kept in its own
 * side-effect-free module so it's unit-testable — importing worker.ts runs the boot (`run()`).
 */
import { hostname } from "node:os";

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
  shutdownGraceTime?: string;
}

/**
 * Per-replica capacity knobs. All optional — unset preserves the SDK defaults, so spreading this into
 * Worker.create never overrides a default with `undefined`. `shutdownGraceTime` is a Temporal
 * duration string (e.g. "30s") so in-flight activities drain on SIGTERM during a deploy.
 */
export function workerTuning(
  env: NodeJS.ProcessEnv = process.env,
): WorkerTuning {
  const grace = env.WORKER_SHUTDOWN_GRACE?.trim();
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
