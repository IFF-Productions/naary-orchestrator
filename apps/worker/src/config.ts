/**
 * Every environment variable `apps/worker` reads, in one file — with its parsing, its default, and
 * WHY that default. See docs/design/CONFIG-CENTRALIZATION.md (slice 2 of 3).
 *
 * NOT FOR WORKFLOW CODE. Nothing under `temporal/workflow/` may import this: reading the
 * environment during a workflow is I/O, and a replay on a differently-configured worker would
 * produce a different decision — the nondeterminism CLAUDE.md Tier-1 §2 forbids. Config belongs to
 * boot (worker.ts) and to activities. That property held before this slice and still holds:
 * `grep -rn 'process\.env' apps/worker/src/temporal/workflow/` is empty.
 *
 * FUNCTIONS, NOT CONSTANTS, for the same reason as the API's module: `export const FOO =
 * process.env.FOO` evaluates at import time, so dotenv boot-order (env.ts, imported first in
 * worker.ts) would silently become a correctness property of every variable. Each accessor takes
 * `env = process.env`, which is also the seam the worker-tuning tests already use.
 */

type Env = NodeJS.ProcessEnv;

// ---------------------------------------------------------------------------
// boot-required
// ---------------------------------------------------------------------------

/** Postgres connection string. No default — env.ts fails the boot without it. */
export function databaseUrl(env: Env = process.env): string | undefined {
  return env.DATABASE_URL;
}

/**
 * The master encryption key. Boot-validated (the worker decrypts tenant provider keys, so a bad
 * value must stop startup rather than surface on the first agent run) and never logged.
 */
export function encryptionKey(env: Env = process.env): string | undefined {
  return env.ENCRYPTION_KEY;
}

// ---------------------------------------------------------------------------
// links back to the SPA
// ---------------------------------------------------------------------------

/**
 * Candidates for the SPA's public base URL: `APP_BASE_URL`, then each `CORS_ORIGINS` entry.
 *
 * Two consumers, both of which must see the SAME list or the boot warning stops predicting the
 * runtime behaviour: env.ts warns at startup when none is usable, and the notification activity
 * resolves the actual link. Without a base, Slack/Teams alerts still send — with a bare run id and
 * no Approve/Reject buttons (#674).
 *
 * Returned unnormalized; each caller applies its own URL validation, which is what they did
 * inline before this slice.
 */
export function appBaseUrlCandidates(env: Env = process.env): string[] {
  return [env.APP_BASE_URL ?? "", ...(env.CORS_ORIGINS ?? "").split(",")];
}

// ---------------------------------------------------------------------------
// worker identity + capacity (Queue-mode Slice 1)
// ---------------------------------------------------------------------------

/** The task queue THIS process polls. One queue per process keeps the heartbeat identity 1:1 with
 *  a queue and the process-global slot gauge accurate. Default lives in @naary/contracts. */
export function workerTaskQueue(env: Env = process.env): string | undefined {
  return env.WORKER_TASK_QUEUE?.trim() || undefined;
}

/** The deployed version: the tag the deploy stamps, else a dev marker. Read through a function so
 *  it can't be frozen at import time before dotenv has run. */
export function workerVersion(env: Env = process.env): string {
  return env.SENTRY_RELEASE ?? env.APP_VERSION ?? "dev";
}

/** Emit fleet heartbeats. On by default; `WORKER_HEARTBEAT=off` opts out (the fleet view then
 *  shows this replica as offline by lastSeen age, which is the same as a crash). */
export function heartbeatEnabled(env: Env = process.env): boolean {
  return env.WORKER_HEARTBEAT !== "off";
}

/** Prometheus scrape port for the worker's own tiny metrics server. 0 disables it. */
export function metricsPort(env: Env = process.env): number {
  return Number(env.METRICS_PORT ?? 9091);
}

/**
 * A positive integer knob, or undefined ⇒ keep the Temporal SDK's own default.
 *
 * Undefined rather than a number of our own on purpose: `workerTuning()` spreads its result into
 * `Worker.create`, and an explicit `undefined` there would override the SDK default with nothing.
 * A zero, a negative, or a typo is treated as unset for the same reason — a bad capacity knob must
 * not take a worker down.
 */
export function positiveIntEnv(
  name: string,
  env: Env = process.env,
): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** Raw `WORKER_SHUTDOWN_GRACE`; the caller validates it against Temporal's Duration shape. */
export function workerShutdownGrace(
  env: Env = process.env,
): string | undefined {
  return env.WORKER_SHUTDOWN_GRACE;
}

// ---------------------------------------------------------------------------
// activities
// ---------------------------------------------------------------------------

/** Resume snapshots (#799). Default ON — a snapshot only helps if it was taken BEFORE the failure
 *  it recovers from, so it can't be opt-in per run. */
export function resumeSnapshotsEnabled(env: Env = process.env): boolean {
  return (env.RESUME_SNAPSHOTS ?? "on").toLowerCase() !== "off";
}

/** Object-store backend. A durability check, not a capability one: MemoryObjectStore satisfies the
 *  interface but lives in THIS process, so the API could never resolve the reference. */
export function storageProvider(env: Env = process.env): string | undefined {
  return env.STORAGE_PROVIDER;
}

/**
 * The MINIMAL env for a spawned coding CLI: enough to find binaries and a home directory, nothing
 * else. Never spread the worker's own env into a subprocess — that process can already read
 * `/proc/<pid>/environ` in the legacy in-worker path (#594), and ENCRYPTION_KEY must not be handed
 * to it outright as well.
 */
export function subprocessBaseEnv(env: Env = process.env): {
  PATH: string | undefined;
  HOME: string | undefined;
} {
  return { PATH: env.PATH, HOME: env.HOME };
}
