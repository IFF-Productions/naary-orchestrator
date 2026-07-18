/**
 * Terminal-status detection + polling loop for `naary runs watch`. Kept separate from
 * the command wiring so the loop can be driven with an injected fetch + clock in tests.
 * `Date.now()`/`setTimeout` are fine here — this is a plain Node CLI, NOT workflow code.
 */

/** Statuses at which a run is done and polling stops. */
export const TERMINAL_STATUSES = [
  "completed",
  "rejected",
  "failed",
  "timed_out",
  "terminated",
  "canceled",
  "budget_exceeded",
  "circuit_open",
  "invalid_graph",
] as const;

export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

const TERMINAL_SET = new Set<string>(TERMINAL_STATUSES);

export function isTerminal(status: string | undefined | null): boolean {
  return status != null && TERMINAL_SET.has(status);
}

/** The only status considered a "success" for `--exit-code`. */
export function isSuccess(status: string | undefined | null): boolean {
  return status === "completed";
}

/** Map a terminal status to a process exit code: 0 only for `completed`. */
export function exitCodeFor(status: string | undefined | null): number {
  return isSuccess(status) ? 0 : 1;
}

export interface RunSnapshot {
  runId: string;
  status: string;
  currentNodeId?: string | null;
  output?: unknown;
}

export interface WatchDeps {
  /** Fetch a run's current snapshot. */
  getRun: (id: string) => Promise<RunSnapshot>;
  /** Called on the first observation and on every status change. */
  onTransition: (status: string, snapshot: RunSnapshot) => void;
  /** Sleep for `ms`. Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Poll interval in milliseconds. */
  intervalMs?: number;
  /** Safety cap on iterations (avoids an unbounded loop in tests / hangs). */
  maxPolls?: number;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Poll a run until it reaches a terminal status (or `maxPolls` is hit), reporting the
 * initial status and each transition. Resolves with the final snapshot.
 */
export async function watchRun(
  id: string,
  deps: WatchDeps,
): Promise<RunSnapshot> {
  const sleep = deps.sleep ?? defaultSleep;
  const intervalMs = deps.intervalMs ?? 3000;
  const maxPolls = deps.maxPolls ?? Number.POSITIVE_INFINITY;

  let last: string | undefined;
  let snapshot = await deps.getRun(id);
  let polls = 1;
  deps.onTransition(snapshot.status, snapshot);
  last = snapshot.status;

  while (!isTerminal(snapshot.status) && polls < maxPolls) {
    await sleep(intervalMs);
    snapshot = await deps.getRun(id);
    polls++;
    if (snapshot.status !== last) {
      deps.onTransition(snapshot.status, snapshot);
      last = snapshot.status;
    }
  }
  return snapshot;
}
