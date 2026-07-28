/**
 * Workflow evals (#575) — golden datasets and batch runs.
 *
 * The backend has been complete for a while (datasets, runs, per-case verdicts, the
 * `graphVersion`/`graphContentHash` snapshot, LLM-judge billed through the ledger); the feature was
 * simply unreachable outside `curl`, so nothing in the product could show a pass rate. This is the
 * client half.
 *
 * PRIVACY: a case result carries verdicts, scores and assertion LABELS only — never prompt or
 * completion text. That is a property of the API, and the UI must not go looking for more.
 */
import { http } from "./http";
import type { EvalCaseResult, EvalRun } from "./types";

export const evalsApi = {
  /** Named golden datasets for a workflow. */
  listEvalDatasets(
    workflowKey: string,
  ): Promise<{ name: string; cases: number }[]> {
    return http(`/graphs/${encodeURIComponent(workflowKey)}/evals/datasets`);
  },
  /** Batch runs, newest first — the run-history list. */
  listEvalRuns(workflowKey: string, limit?: number): Promise<EvalRun[]> {
    const q = limit ? `?limit=${limit}` : "";
    return http(`/graphs/${encodeURIComponent(workflowKey)}/evals/runs${q}`);
  },
  /**
   * One run with its per-case verdicts. Keyed by run id and NOT workflow-scoped, mirroring
   * `GET /executions/:id`.
   */
  getEvalRun(id: string): Promise<EvalRun & { cases: EvalCaseResult[] }> {
    return http(`/evals/runs/${encodeURIComponent(id)}`);
  },
};
