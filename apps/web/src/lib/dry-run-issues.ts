/**
 * DRY RUN → canvas issues (#832).
 *
 * Pure, so the interesting decisions are testable without a canvas:
 *
 *  - a FAILED check becomes a row you can click to jump to its node;
 *  - a SKIPPED check does not. It is not a problem, and inventing a row for it would bury the
 *    real failures under noise;
 *  - but a skipped check is not a pass either, so it is COUNTED and reported in the summary.
 *    "0 problems" must never be allowed to imply "everything was checked" — the credential probe
 *    reaches 32 of 38 providers since #835 (GitHub included, PAT and App install alike), and a flow
 *    whose only integration is one of the remaining six verifies nothing about its token.
 */
import type { DryRunResult } from "./api/types";
import type { CanvasIssue } from "../screens/canvas/CanvasIssuesPanel";

/** What the check found, in the words the summary line uses. */
export interface DryRunSummary {
  /**
   * Did the check RUN and come back clean? False when it found problems — and false when the
   * check itself failed, which is the case that matters: zero issues must never be allowed to
   * render as a pass just because nothing was collected.
   */
  ok: boolean;
  /** Failed checks — the rows shown in the panel. */
  issues: CanvasIssue[];
  /** Connections actually called. */
  probed: number;
  /** Connections we had no safe way to probe: their credentials are UNVERIFIED. */
  unprobeable: number;
  /** One sentence for the toast / panel header. Always states what was NOT checked. */
  message: string;
}

const LABEL: Record<string, string> = {
  config: "config",
  request: "request",
  credential: "connection",
};

export function summarizeDryRun(result: DryRunResult): DryRunSummary {
  const issues: CanvasIssue[] = [];
  for (const node of result.nodes) {
    for (const check of node.checks) {
      if (check.ok || check.skipped) continue;
      issues.push({
        nodeId: node.nodeId,
        field: LABEL[check.kind] ?? check.kind,
        ref: undefined,
        message:
          check.message ??
          `The ${LABEL[check.kind] ?? check.kind} check failed.`,
        kind: "check",
      });
    }
  }

  const many = result.unprobeable > 1;
  const unverified =
    result.unprobeable > 0
      ? ` ${result.unprobeable} connection${many ? "s" : ""} could not be checked — ` +
        `${many ? "those providers have" : "this provider has"} no read that is safe to call ` +
        `blind, so ${many ? "their" : "its"} credentials are still unverified.`
      : "";

  const message = issues.length
    ? `${issues.length} problem${issues.length > 1 ? "s" : ""} found before running anything.${unverified}`
    : `No problems found. ${result.probed} connection${result.probed === 1 ? "" : "s"} verified.${unverified}`;

  return {
    ok: issues.length === 0,
    issues,
    probed: result.probed,
    unprobeable: result.unprobeable,
    message,
  };
}
