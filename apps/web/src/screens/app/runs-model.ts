/**
 * The Runs list's pure data layer (#1044) — reading a paged response, appending a page, and
 * turning a failure into something a person can read.
 *
 * It exists because the screen could render NOTHING. `Runs.tsx` destructured the response
 * directly (`const { items: rows } = await api.listRunsPage(…); setRuns(rows)`), so a 200 whose
 * body had no `items` key set the list to `undefined` — and `undefined` is neither `null` (no
 * loading skeleton) nor length 0 (no empty state), and nothing threw (no error banner). The user
 * got a blank page indistinguishable from "still loading", which is precisely the dead end that
 * cost a diagnosis round-trip on #1038.
 *
 * So the rule here is: a response that does not match the contract is an ERROR with a stated
 * reason, never a silent empty list. Pure and dependency-free so it is testable in `apps/web`'s
 * node (no-jsdom) vitest environment.
 */
import { HttpError, UnauthorizedError } from "../../lib/api";
import type { RunSummary } from "../../lib/api";
import { isRejected, isSystemFailure } from "../../lib/run-status";
import { fmtDurMs } from "./run-detail/run-view-model";

/** Real run duration (worker-stamped finishedAt − createdAt); "—" until recorded —
 *  in-flight runs and runs predating the stamp have none (Slice 2, never faked). */
export function durText(ms: number | null): string {
  return ms === null ? "—" : fmtDurMs(ms);
}

/** Compact relative time from an ISO timestamp (no date lib). */
export function ago(iso: string): string {
  const then = new Date(iso).getTime();
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Filter tabs → which statuses they include (All = everything). */
export const FILTERS: { label: string; match: (s: string) => boolean }[] = [
  { label: "All", match: () => true },
  {
    label: "Waiting",
    // Both human-in-the-loop pauses: approval AND wait(webhook) (PR #192).
    match: (s) => s === "awaiting_approval" || s === "awaiting_webhook",
  },
  { label: "Running", match: (s) => s === "running" },
  { label: "Completed", match: (s) => s === "completed" },
  // "Failed" is what BROKE; "Rejected" is what a human said no to at an approval gate.
  // Lumping them together made a working approval flow look like an outage.
  { label: "Failed", match: isSystemFailure },
  { label: "Rejected", match: isRejected },
];

/** One page of runs as the Runs screen consumes it: rows plus the cursor for the next page
 *  (null on the last page). */
export interface RunPageView {
  items: RunSummary[];
  nextCursor: string | null;
}

/**
 * The server answered, but not with the shape `GET /executions/page` promises. Its own error type
 * so the screen can tell it apart from "the API is unreachable" — the two have completely
 * different fixes, and saying the wrong one sends the reader looking in the wrong place.
 */
export class UnexpectedResponseError extends Error {
  constructor(detail: string) {
    super(
      `The runs list came back in a shape this app doesn't understand (${detail}). ` +
        "The app and the API may be running different versions.",
    );
    this.name = "UnexpectedResponseError";
  }
}

/**
 * Validate + normalize one page of runs. THROWS `UnexpectedResponseError` rather than returning a
 * half-empty object: every caller writes the result straight into screen state, so a lenient
 * `?? []` here would restore the original bug in a quieter form — a list that says "No runs yet"
 * when the truth is "this app could not read the answer".
 *
 * `nextCursor` is normalized instead: anything that is not a string means "no further pages",
 * which is the safe reading — the worst case is a missing "Load more", not a button wired to a
 * cursor that isn't one.
 */
export function readRunPage(raw: unknown): RunPageView {
  if (raw === null || typeof raw !== "object")
    throw new UnexpectedResponseError(
      raw === undefined || raw === null
        ? "an empty response"
        : `a ${typeof raw}`,
    );
  if (Array.isArray(raw))
    // The un-paged `GET /executions` shape. A real mismatch worth naming: it means something is
    // answering the paged route with the list route's body.
    throw new UnexpectedResponseError("a bare array, not a page");
  const page = raw as { items?: unknown; nextCursor?: unknown };
  if (!Array.isArray(page.items))
    throw new UnexpectedResponseError(
      page.items === undefined ? 'no "items" array' : '"items" is not an array',
    );
  return {
    items: page.items as RunSummary[],
    nextCursor:
      typeof page.nextCursor === "string" && page.nextCursor
        ? page.nextCursor
        : null,
  };
}

/**
 * Append a page to the rows already on screen, deduped on `workflowId` (a run can legitimately
 * appear in two pages when a concurrent archive shifts the keyset boundary).
 *
 * Validation happens HERE, before any state is touched, because in the component this ran inside
 * a `setRuns(prev => …)` updater. React only evaluates an updater eagerly when the queue is empty;
 * otherwise it runs during a LATER render — outside `loadMore`'s try/catch. So a malformed page 2
 * threw either into the inline banner or straight past it to the error boundary depending on
 * timing, and the second case blanked a screen that was showing perfectly good rows. Validating
 * before the updater makes the failure deterministic: the banner, always.
 */
export function appendRunPage(
  prev: RunSummary[] | null,
  page: unknown,
): RunSummary[] {
  const { items } = readRunPage(page);
  const seen = new Set((prev ?? []).map((r) => r.workflowId));
  return [...(prev ?? []), ...items.filter((r) => !seen.has(r.workflowId))];
}

/**
 * The message the screen shows for a failed load. Every branch says something specific: a blank
 * screen and a bare "something went wrong" are the same non-answer, and this list is the first
 * place a user looks when a deployment is half-rolled.
 */
export function runsLoadErrorMessage(e: unknown, fallback: string): string {
  if (e instanceof UnauthorizedError)
    return "Not authenticated — sign in (or set an API token) to see runs.";
  // Its own message already names the mismatch and the likely cause (a version skew).
  if (e instanceof UnexpectedResponseError) return e.message;
  // A status is the single most useful thing for a reader to quote in a bug report.
  if (e instanceof HttpError) return `${fallback} (HTTP ${e.status})`;
  return fallback;
}
