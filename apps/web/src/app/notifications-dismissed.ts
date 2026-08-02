/**
 * "Clear all" for the notifications bell — the pure half.
 *
 * The bell has NO server-side inbox. `NotificationsBell.tsx` DERIVES its list on every 45s poll
 * from two live queries: the approvals awaiting a decision, and the recently failed runs. So
 * "clear" cannot mean "delete" — there is nothing to delete, and anything merely dropped from
 * React state is back within 45 seconds, which is worse than no button at all.
 *
 * What "clear" means here is therefore: remember the IDs of the items you have already seen, in
 * localStorage, per workspace, and filter those ids out of every later poll. Two properties make
 * that safe, and they are the whole point of this module:
 *
 *   1. Dismissal is PER ITEM ID — never a "hide everything older than now" watermark. A new
 *      approval or a newly failed run has an id nobody has dismissed, so it still appears. A bell
 *      that could be permanently silenced would be a liability, not a feature.
 *   2. The stored set is PRUNED against what the poll actually returned, so it cannot grow without
 *      bound, and an item that genuinely recurs is not suppressed by a years-old entry.
 *
 * Pruning has one sharp edge, which is why `trust` exists. Each of the bell's two fetches degrades
 * to "no data" on error, independently. If a prune treated an errored fetch as "the server says
 * these items are gone", a single 500 on the runs query would drop every dismissed `run-` id from
 * storage — and every cleared failure would reappear on the next successful poll. Intermittent,
 * silent, and precisely the "my clear didn't stick" bug this feature exists to avoid. So a source
 * is pruned only when it was actually READ this poll.
 *
 * No React, no I/O of its own (the caller injects storage) — `apps/web`'s vitest environment is
 * "node", with no jsdom and no `localStorage`, so this shape is what makes the rules testable.
 */

/** The slice of `localStorage` this module needs. Injected so the rules are testable in node. */
export interface DismissalStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Which live query an item came from. Also the unit of "was this source readable this poll". */
export type NotifSource = "approvals" | "runs";

/** Whether each source was actually read this poll. `false` = the fetch failed and returned
 *  nothing — an absence of data, NOT evidence that the items are gone. */
export interface SourceTrust {
  approvals: boolean;
  runs: boolean;
}

/** Nothing was read — used when reconciling against an already-fetched list (e.g. right after the
 *  user clicks Clear all), where re-pruning would only risk dropping ids for no new information. */
export const NO_TRUST: SourceTrust = { approvals: false, runs: false };

const APPROVAL_PREFIX = "ap-";
const RUN_PREFIX = "run-";

/** Stable id for an awaiting-approval item: the run plus the node that is waiting. */
export function approvalKey(workflowId: string, nodeId: string): string {
  return `${APPROVAL_PREFIX}${workflowId}-${nodeId}`;
}

/** Stable id for a failed-run item. `workflowId` is the execution id, so a NEW failure of the
 *  same workflow is a NEW id — that is what lets a cleared failure not mask the next one. */
export function runKey(workflowId: string): string {
  return `${RUN_PREFIX}${workflowId}`;
}

/**
 * Which source an id belongs to, read back off its prefix, or null for anything this version does
 * not recognise (an id written by an older/newer build). The prefixes are minted above and parsed
 * here so the two never drift apart in two different files.
 */
export function sourceOf(id: string): NotifSource | null {
  if (id.startsWith(APPROVAL_PREFIX)) return "approvals";
  if (id.startsWith(RUN_PREFIX)) return "runs";
  return null;
}

/**
 * The storage key. Scoped PER WORKSPACE: the bell's data is workspace-scoped (every request
 * carries `X-Workspace-Id`), so clearing in one workspace must not hide a colleague-facing
 * approval in another. `null` (no workspace resolved yet) gets its own bucket rather than
 * sharing one workspace's bucket by accident.
 */
export function dismissedKey(workspaceId: string | null): string {
  return `naary.notifications.dismissed.${workspaceId ?? "none"}`;
}

/**
 * Read the dismissed ids. Anything unreadable — storage unavailable, malformed JSON, an array of
 * non-strings — is treated as "nothing dismissed". Failing OPEN is the right direction for this
 * one: the cost is that the user sees notifications they had cleared, and the alternative
 * (throwing) would take the whole bell down over a preference.
 */
export function readDismissed(
  store: DismissalStore | null,
  workspaceId: string | null,
): string[] {
  if (!store) return [];
  let raw: string | null = null;
  try {
    raw = store.getItem(dismissedKey(workspaceId));
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const v of parsed) {
      if (typeof v !== "string" || !v || seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
    return out;
  } catch {
    return [];
  }
}

/** Persist the dismissed ids (removing the key entirely when the set is empty, so a user who
 *  clears and then works through everything leaves nothing behind). Never throws. */
export function writeDismissed(
  store: DismissalStore | null,
  workspaceId: string | null,
  ids: readonly string[],
): void {
  if (!store) return;
  try {
    const key = dismissedKey(workspaceId);
    if (ids.length === 0) store.removeItem(key);
    else store.setItem(key, JSON.stringify(ids));
  } catch {
    // Storage unavailable — the write is simply skipped. Be clear about the consequence rather
    // than promising a durability we do not provide: the bell re-derives from `readDismissed` on
    // every poll, so a dismissal that could not be written comes back on the next one.
  }
}

/** Add the given ids to the dismissed set, preserving order and ignoring duplicates. */
export function dismissAll(
  stored: readonly string[],
  ids: readonly string[],
): string[] {
  const out = [...stored];
  const seen = new Set(stored);
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Order-sensitive equality, used to avoid rewriting storage on every poll when nothing changed. */
export function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** The minimum an item needs for these rules to apply to it. */
export interface Dismissable {
  key: string;
}

export interface Reconciled<T extends Dismissable> {
  /** The items to render: everything fetched that has not been dismissed. */
  visible: T[];
  /** The dismissed set to persist — pruned, but only for sources that were actually read. */
  persist: string[];
  /** How many dismissed items are KNOWN to still be live right now (a cleared-but-still-pending
   *  approval). Counted only against data we actually have, so a failed fetch reports 0 rather
   *  than claiming things are open that we could not see. */
  liveHiddenCount: number;
}

/**
 * The one rule that matters, applied to a single poll's worth of data.
 *
 * `candidates` must be the FULL fetched set, before any display cap. Reconciling against the
 * visible slice would prune every dismissed id that happens to sit outside the window — and those
 * items would pop straight back the moment the window moved.
 */
export function reconcileDismissed<T extends Dismissable>(
  candidates: readonly T[],
  stored: readonly string[],
  trust: SourceTrust,
): Reconciled<T> {
  const live = new Set(candidates.map((c) => c.key));
  const persist = stored.filter((id) => {
    if (live.has(id)) return true;
    const source = sourceOf(id);
    // Unrecognised ids are dropped only once BOTH sources were read — with a complete picture in
    // hand, an id matching nothing is genuinely stale rather than merely unfetched.
    if (source === null) return !(trust.approvals && trust.runs);
    // Absent from a source we could not read this poll ⇒ no information, so keep the dismissal.
    return !trust[source];
  });
  const dismissed = new Set(persist);
  return {
    visible: candidates.filter((c) => !dismissed.has(c.key)),
    persist,
    liveHiddenCount: persist.filter((id) => live.has(id)).length,
  };
}

/**
 * One poll's worth of reconciliation, INCLUDING the case where the user hit Clear all while that
 * poll was still in flight.
 *
 * Clearing can only dismiss the ids the app has actually seen — the last COMPLETED poll's. A poll
 * whose fetch was issued before the click but which resolves after it describes the very state the
 * user was clearing, and it can legitimately contain ids the previous poll did not have (an
 * approval that arrived in between). Rendering those a moment after the click is indistinguishable
 * from "Clear all didn't work", so `clearedDuringPoll` folds them into the same clear.
 *
 * This is bounded on purpose: only a poll already in flight at the moment of the click is covered.
 * A poll STARTED afterwards is untouched, so a genuinely new approval or failure still arrives —
 * the per-id guarantee is not weakened into "mute everything for a while".
 */
export function reconcilePoll<T extends Dismissable>(
  candidates: readonly T[],
  stored: readonly string[],
  trust: SourceTrust,
  clearedDuringPoll: boolean,
): Reconciled<T> {
  const effective = clearedDuringPoll
    ? dismissAll(
        stored,
        candidates.map((c) => c.key),
      )
    : stored;
  return reconcileDismissed(candidates, effective, trust);
}

/** `localStorage` if this environment has a usable one, else null (SSR, sandboxed iframe, a
 *  browser with storage disabled — merely TOUCHING it can throw, so the probe is guarded). */
export function browserDismissalStore(): DismissalStore | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}
