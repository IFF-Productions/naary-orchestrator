/**
 * Read-models for the evals card (#575) — pure, so the interesting decisions are testable without
 * mounting a screen.
 *
 * The point of the card is the comparison the issue names: *"vN passed 18/20 vs vN-1 20/20"*. That
 * needs a pass rate per GRAPH VERSION, not per run, because a version can be re-run.
 */
import type { EvalRun } from "../../../lib/api";

/** A run's outcome as a fraction, or null when it measured nothing. */
export function passRate(run: {
  passed: number;
  totalCases: number;
}): number | null {
  return run.totalCases > 0 ? run.passed / run.totalCases : null;
}

export interface VersionScore {
  graphVersion: number;
  /** Latest run for this version — a re-run supersedes an earlier one. */
  passed: number;
  totalCases: number;
  rate: number | null;
  runId: string;
  startedAt: string;
}

/**
 * Latest run per graph version, ascending by version — the series a trend renders from.
 *
 * LATEST, not best and not first: re-running a version after fixing a flaky case should move the
 * number, and showing the best run would flatter it. Ties on `startedAt` fall back to run id so the
 * result is deterministic rather than dependent on the API's ordering.
 */
export function scoresByVersion(runs: EvalRun[]): VersionScore[] {
  const best = new Map<number, EvalRun>();
  for (const r of runs) {
    const cur = best.get(r.graphVersion);
    if (
      !cur ||
      r.startedAt > cur.startedAt ||
      (r.startedAt === cur.startedAt && r.id > cur.id)
    )
      best.set(r.graphVersion, r);
  }
  return [...best.values()]
    .sort((a, b) => a.graphVersion - b.graphVersion)
    .map((r) => ({
      graphVersion: r.graphVersion,
      passed: r.passed,
      totalCases: r.totalCases,
      rate: passRate(r),
      runId: r.id,
      startedAt: r.startedAt,
    }));
}

/**
 * The promote-screen sentence, or null when there is nothing honest to say.
 *
 * Returns null with fewer than two versions — "18/20" alone is not a comparison, and inventing a
 * baseline would be worse than staying quiet.
 */
export function versionComparison(runs: EvalRun[]): string | null {
  const s = scoresByVersion(runs);
  if (s.length < 2) return null;
  const [prev, latest] = [s[s.length - 2], s[s.length - 1]];
  return `v${latest.graphVersion} passed ${latest.passed}/${latest.totalCases} vs v${prev.graphVersion}'s ${prev.passed}/${prev.totalCases}`;
}

/** done / running / failed — drives the row's dot colour without inventing states. */
export function runState(run: EvalRun): "done" | "running" | "error" {
  if (run.status === "running" || !run.finishedAt) return "running";
  return run.errored > 0 || run.failed > 0 ? "error" : "done";
}
