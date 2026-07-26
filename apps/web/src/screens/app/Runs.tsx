import {
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router-dom";
import { Button, Icon, Skeleton, StatusPill } from "../../components";
import { api, type RunSummary, UnauthorizedError } from "../../lib/api";
import { PHONE_QUERY, useMediaQuery } from "../../lib/useMediaQuery";
import {
  isRejected,
  isSystemFailure,
  isTerminal,
  runStatusUi,
} from "../../lib/run-status";
import { useMode } from "../../mode";
import { RerunMenu, VersionBadge } from "./RerunMenu";
import { fmtDurMs } from "./run-detail/run-view-model";

const COLS = "28px 1.4fr 1fr 0.5fr 0.8fr 0.6fr 0.6fr 0.7fr 0.6fr";

/** Real run duration (worker-stamped finishedAt − createdAt); "—" until recorded —
 *  in-flight runs and runs predating the stamp have none (Slice 2, never faked). */
function durText(ms: number | null): string {
  return ms === null ? "—" : fmtDurMs(ms);
}

/** Compact relative time from an ISO timestamp (no date lib). */
function ago(iso: string): string {
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
const FILTERS: { label: string; match: (s: string) => boolean }[] = [
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

export function Runs() {
  const navigate = useNavigate();
  const { mode } = useMode();
  const simple = mode === "simple";
  // On phone the 8-column grid can't fit — each run renders as a stacked card instead.
  const phone = useMediaQuery(PHONE_QUERY);
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  // The search box drives a SERVER-side search over the run's contained data (trigger input) plus
  // its id/workflow (#463). `query` is the live input; `debouncedQuery` is what's sent (see effect
  // below) so we don't refetch on every keystroke.
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [filter, setFilter] = useState("All");
  const [starting, setStarting] = useState(false);
  // Set of in-flight archive/restore ids — a Set (not a single id) so archiving two rows in
  // quick succession disables each independently instead of the second clobbering the first.
  const [archiving, setArchiving] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Multi-select for bulk actions (archive/restore + approve/deny). `selected` holds
  // workflowIds; `bulkBusy` locks every control while a batch call is in flight.
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [bulkBusy, setBulkBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // Monotonic request id: concurrent loads (initial / Refresh / view toggle) can resolve out
  // of order — only the newest is allowed to write `runs`, so a slow earlier request (e.g. the
  // other view) can't clobber the current one.
  const loadSeq = useRef(0);

  async function load(archived = showArchived, q = debouncedQuery) {
    const seq = ++loadSeq.current;
    try {
      const rows = await api.listRuns(archived, q);
      if (seq !== loadSeq.current) return; // superseded by a newer load
      setRuns(rows);
      setError(null);
      // Drop selections for runs that dropped off the list (archived elsewhere, aged out).
      const live = new Set(rows.map((r) => r.workflowId));
      setSelected((s) => {
        const kept = [...s].filter((id) => live.has(id));
        return kept.length === s.size ? s : new Set(kept);
      });
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setError(
        e instanceof UnauthorizedError
          ? "Not authenticated — sign in (or set an API token) to see runs."
          : "Could not reach the control plane (apps/api on :3000).",
      );
    }
  }

  // Debounce the search box so a server search fires ~300ms after typing stops, not per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(t);
  }, [query]);

  // Single source of loads: (re)fetch whenever the view (archived) or the debounced search changes.
  // The seq guard in load() drops out-of-order responses. biome-ignore: `load` is a stable closure
  // recreated each render; keying on the two inputs is the intended trigger.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — load reads latest state.
  useEffect(() => {
    void load(showArchived, debouncedQuery);
  }, [showArchived, debouncedQuery]);

  function toggleArchivedView() {
    const next = !showArchived;
    setShowArchived(next);
    setRuns(null);
    setSelected(new Set()); // selection is per-view
    setNotice(null);
    // The load effect (keyed on showArchived) does the refetch — no explicit load() here.
  }

  function toggleSelect(id: string, e: ReactMouseEvent) {
    e.stopPropagation(); // don't navigate into the run
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  // Archive (or restore, in the archived view) every selected run in one call. Successes leave
  // the current list; any that slip (not owned / already gone) stay + are reported.
  async function bulkArchive() {
    const ids = [...selected];
    if (ids.length === 0) return;
    setBulkBusy(true);
    setNotice(null);
    setError(null);
    try {
      const results = await api.archiveBatch(ids, !showArchived);
      const okIds = new Set(
        results.filter((r) => r.ok).map((r) => r.workflowId),
      );
      setRuns((prev) => prev?.filter((r) => !okIds.has(r.workflowId)) ?? null);
      setSelected((s) => new Set([...s].filter((id) => !okIds.has(id))));
      const failed = results.length - okIds.size;
      const verb = showArchived ? "restored" : "archived";
      if (failed > 0)
        setNotice(`${okIds.size} ${verb}, ${failed} could not be updated.`);
    } catch {
      setError("Bulk archive failed — please retry.");
    } finally {
      setBulkBusy(false);
    }
  }

  // Approve/deny every selected run that's awaiting a decision. approveBatch tolerates runs
  // that aren't awaiting (they come back ok:false), so we report how many actually decided.
  async function bulkDecide(approved: boolean) {
    const ids = [...selected];
    if (ids.length === 0) return;
    setBulkBusy(true);
    setNotice(null);
    setError(null);
    try {
      const results = await api.approveBatch(ids, approved);
      const okCount = results.filter((r) => r.ok).length;
      const failed = results.length - okCount;
      setNotice(
        `${okCount} ${approved ? "approved" : "denied"}` +
          (failed > 0 ? `, ${failed} were not awaiting a decision.` : "."),
      );
      setSelected(new Set());
      await load(); // statuses changed — refresh
    } catch {
      setError("Bulk decision failed — please retry.");
    } finally {
      setBulkBusy(false);
    }
  }

  // Cancel every selected run that's still running/paused. cancelBatch tolerates already-terminal
  // (or not-owned) runs — they come back ok:false — so we report how many actually cancelled.
  async function bulkCancel() {
    const ids = [...selected];
    if (ids.length === 0) return;
    setBulkBusy(true);
    setNotice(null);
    setError(null);
    try {
      const results = await api.cancelBatch(ids);
      const okCount = results.filter((r) => r.ok).length;
      const failed = results.length - okCount;
      setNotice(
        `${okCount} cancelled` +
          (failed > 0 ? `, ${failed} were already finished.` : "."),
      );
      setSelected(new Set());
      await load(); // statuses changed — refresh
    } catch {
      setError("Bulk cancel failed — please retry.");
    } finally {
      setBulkBusy(false);
    }
  }

  // Archive (active view) or restore (archived view). Either way the run leaves the
  // current list — it moves to the other view — so we drop it optimistically.
  async function toggleArchive(
    id: string,
    archived: boolean,
    e: ReactMouseEvent,
  ) {
    e.stopPropagation();
    setArchiving((s) => new Set(s).add(id));
    setError(null);
    try {
      await (archived ? api.unarchiveRun(id) : api.archiveRun(id));
      setRuns((prev) => prev?.filter((r) => r.workflowId !== id) ?? null);
    } catch {
      setError(
        archived ? "Could not restore the run." : "Could not archive the run.",
      );
    } finally {
      setArchiving((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
    }
  }

  const activeFilter = FILTERS.find((f) => f.label === filter) ?? FILTERS[0];
  // The search box is served SERVER-side now (#463): the fetched `runs` are already filtered by
  // contained data + id/workflow, so we only apply the status tab client-side. (A client `query`
  // filter here would wrongly hide data-only matches the server returned.)
  const rows = (runs ?? []).filter((r) => activeFilter.match(r.status));

  // Selection derived state. Select-all applies to the CURRENTLY VISIBLE rows. Approve/Deny are
  // only meaningful for runs paused on a humanApproval node (awaiting_approval).
  const allVisibleSelected =
    rows.length > 0 && rows.every((r) => selected.has(r.workflowId));
  const approvableSelected = (runs ?? []).filter(
    (r) => selected.has(r.workflowId) && r.status === "awaiting_approval",
  ).length;
  // Cancellable = selected runs that aren't already terminal (running or paused).
  const cancellableSelected = (runs ?? []).filter(
    (r) => selected.has(r.workflowId) && !isTerminal(r.status),
  ).length;
  function toggleSelectAll() {
    setSelected((s) => {
      const everyChecked =
        rows.length > 0 && rows.every((r) => s.has(r.workflowId));
      if (everyChecked) {
        const n = new Set(s);
        for (const r of rows) n.delete(r.workflowId);
        return n;
      }
      return new Set([...s, ...rows.map((r) => r.workflowId)]);
    });
  }

  async function startRun() {
    setStarting(true);
    setError(null);
    try {
      const { workflowId } = await api.startExecution();
      navigate(`/app/runs/${encodeURIComponent(workflowId)}`);
    } catch (e) {
      setError(
        e instanceof UnauthorizedError
          ? "Not authenticated — sign in (or set an API token) first."
          : "Could not start a run. Is the default graph seeded? (POST /executions)",
      );
    } finally {
      setStarting(false);
    }
  }

  return (
    <div
      style={{
        padding: phone ? "16px 14px 32px" : "24px 28px 40px",
        animation: "naaryFadeUp .25s ease",
      }}
    >
      <div
        style={{
          display: "flex",
          // Phone: stack the title over the (wrapping) action buttons so nothing runs off-screen.
          flexDirection: phone ? "column" : "row",
          alignItems: phone ? "stretch" : "center",
          justifyContent: "space-between",
          gap: phone ? 12 : 0,
          marginBottom: 16,
        }}
      >
        <div>
          <div
            style={{
              fontSize: "var(--text-title)",
              fontWeight: "var(--weight-bold)",
              letterSpacing: "-0.01em",
            }}
          >
            Runs
          </div>
          <div
            style={{
              fontSize: "var(--text-sm)",
              color: "var(--ink-2)",
              marginTop: 2,
            }}
          >
            {showArchived
              ? `Archived runs${runs ? ` · ${runs.length}` : ""}`
              : simple
                ? `Every time your automations ran${runs ? ` · ${runs.length} recent` : ""}`
                : `Durable execution log${runs ? ` · ${runs.length} recent` : ""}`}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {!simple && !showArchived && (
            <Button icon="play" onClick={startRun} loading={starting}>
              {starting ? "Starting…" : "Start test run"}
            </Button>
          )}
          <Button
            icon="archive"
            variant={showArchived ? "primary" : "secondary"}
            onClick={toggleArchivedView}
          >
            {showArchived ? "Back to runs" : "Archived"}
          </Button>
          <Button icon="refresh" onClick={() => void load()}>
            Refresh
          </Button>
        </div>
      </div>

      {error && (
        <div
          style={{
            marginBottom: 14,
            padding: "8px 12px",
            borderRadius: "var(--radius-sm)",
            background: "var(--error-soft)",
            border:
              "1px solid color-mix(in srgb, var(--state-error) 40%, transparent)",
            color: "var(--state-error)",
            fontSize: "var(--text-sm)",
          }}
        >
          {error}
        </div>
      )}

      {notice && (
        <div
          style={{
            marginBottom: 14,
            padding: "8px 12px",
            borderRadius: "var(--radius-sm)",
            background: "var(--surface)",
            border: "1px solid var(--line)",
            color: "var(--ink-2)",
            fontSize: "var(--text-sm)",
          }}
        >
          {notice}
        </div>
      )}

      {/* Bulk action bar — appears when rows are selected. */}
      {selected.size > 0 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 8,
            marginBottom: 14,
            padding: "9px 12px",
            borderRadius: "var(--radius-sm)",
            border: "1px solid var(--line-2)",
            background: "var(--card-2)",
          }}
        >
          <span
            style={{
              fontSize: "var(--text-sm)",
              fontWeight: "var(--weight-semibold)",
              color: "var(--ink)",
            }}
          >
            {selected.size} selected
          </span>
          <div style={{ flex: 1 }} />
          {!showArchived && (
            <>
              <Button
                size="sm"
                variant="positive"
                disabled={bulkBusy || approvableSelected === 0}
                title={
                  approvableSelected === 0
                    ? "None of the selected runs are awaiting approval"
                    : `Approve ${approvableSelected} awaiting run(s)`
                }
                onClick={() => void bulkDecide(true)}
              >
                Approve
                {approvableSelected > 0 ? ` (${approvableSelected})` : ""}
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={bulkBusy || approvableSelected === 0}
                onClick={() => void bulkDecide(false)}
              >
                Deny{approvableSelected > 0 ? ` (${approvableSelected})` : ""}
              </Button>
              <Button
                size="sm"
                variant="danger"
                icon="x"
                disabled={bulkBusy || cancellableSelected === 0}
                title={
                  cancellableSelected === 0
                    ? "None of the selected runs are still running"
                    : `Cancel ${cancellableSelected} running/paused run(s)`
                }
                onClick={() => void bulkCancel()}
              >
                Cancel
                {cancellableSelected > 0 ? ` (${cancellableSelected})` : ""}
              </Button>
            </>
          )}
          <Button
            size="sm"
            variant="secondary"
            icon={showArchived ? "eye" : "archive"}
            disabled={bulkBusy}
            onClick={() => void bulkArchive()}
          >
            {showArchived ? "Restore selected" : "Archive selected"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={bulkBusy}
            onClick={() => setSelected(new Set())}
          >
            Clear
          </Button>
        </div>
      )}

      <div
        style={{
          display: "flex",
          // Phone: stack the (scrollable) filter tabs over a full-width search box.
          flexDirection: phone ? "column" : "row",
          alignItems: phone ? "stretch" : "center",
          gap: 10,
          marginBottom: 14,
        }}
      >
        <div
          style={{
            display: "flex",
            background: "var(--surface)",
            border: "1px solid var(--line)",
            borderRadius: "var(--radius-sm)",
            padding: 3,
            gap: 2,
            // Tabs can outrun a narrow screen — let them scroll rather than clip/wrap.
            overflowX: "auto",
          }}
        >
          {FILTERS.map((f) => {
            const active = f.label === filter;
            const count = (runs ?? []).filter((r) => f.match(r.status)).length;
            return (
              <button
                key={f.label}
                type="button"
                onClick={() => setFilter(f.label)}
                style={{
                  border: "none",
                  cursor: "pointer",
                  fontSize: "var(--text-sm)",
                  fontWeight: active
                    ? "var(--weight-semibold)"
                    : "var(--weight-regular)",
                  color: active ? "var(--ink)" : "var(--ink-2)",
                  background: active ? "var(--card-2)" : "transparent",
                  padding: "5px 12px",
                  borderRadius: "var(--radius-xs)",
                  transition: "background 140ms ease, color 140ms ease",
                  flex: "none",
                  whiteSpace: "nowrap",
                }}
              >
                {f.label}
                {runs ? ` ${count}` : ""}
              </button>
            );
          })}
        </div>
        <div
          className="input-wrap"
          style={{
            width: phone ? "100%" : 260,
            height: 34,
            padding: "0 11px",
          }}
        >
          <Icon name="search" size={14} style={{ color: "var(--ink-3)" }} />
          <input
            className="bare mono"
            style={{ height: 32, fontSize: "var(--text-xs)" }}
            placeholder={
              simple
                ? "search runs by data or id…"
                : "search runs by data, id, or workflow…"
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        {/* Column header — desktop/tablet only; on phone the cards are self-labelling. */}
        {!phone && (
          <div
            className="mono"
            style={{
              display: "grid",
              gridTemplateColumns: COLS,
              gap: 10,
              padding: "10px 18px",
              borderBottom: "1px solid var(--line)",
              fontSize: "var(--text-2xs)",
              fontWeight: "var(--weight-semibold)",
              letterSpacing: "0.08em",
              color: "var(--ink-3)",
              textTransform: "uppercase",
            }}
          >
            <span style={{ display: "flex", alignItems: "center" }}>
              <input
                type="checkbox"
                aria-label="Select all runs"
                title="Select all"
                checked={allVisibleSelected}
                disabled={rows.length === 0 || bulkBusy}
                onChange={toggleSelectAll}
              />
            </span>
            <span>Run</span>
            <span>{simple ? "Automation" : "Workflow"}</span>
            <span>Version</span>
            <span>Status</span>
            <span>Cost</span>
            <span>Duration</span>
            <span>Started</span>
            <span />
          </div>
        )}

        {/* Phone: the column header (and its select-all) is hidden, so surface a select-all
            control here — otherwise bulk actions would be unreachable on mobile. */}
        {phone && rows.length > 0 && (
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "10px 16px",
              borderBottom: "1px solid var(--line)",
              fontSize: "var(--text-xs)",
              color: "var(--ink-2)",
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              aria-label="Select all runs"
              checked={allVisibleSelected}
              disabled={bulkBusy}
              onChange={toggleSelectAll}
            />
            {allVisibleSelected ? "Deselect all" : "Select all"}
          </label>
        )}

        {runs === null &&
          !error &&
          Array.from({ length: 6 }).map((_, i) =>
            phone ? (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length skeleton placeholder
                key={i}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                  padding: "12px 16px",
                  borderBottom: "1px solid var(--line)",
                }}
              >
                <Skeleton width={72} height={20} radius={10} />
                <Skeleton width="70%" />
                <Skeleton width="45%" />
              </div>
            ) : (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length skeleton placeholder
                key={i}
                style={{
                  display: "grid",
                  gridTemplateColumns: COLS,
                  gap: 10,
                  padding: "12px 18px",
                  borderBottom: "1px solid var(--line)",
                  alignItems: "center",
                }}
              >
                <Skeleton width={16} height={16} radius={4} />
                <Skeleton width="72%" />
                <Skeleton width="55%" />
                <Skeleton width={26} />
                <Skeleton width={64} height={20} radius={10} />
                <Skeleton width="50%" />
                <Skeleton width="45%" />
                <Skeleton width="60%" />
                <span />
              </div>
            ),
          )}
        {runs?.length === 0 && (
          <div
            style={{
              padding: 18,
              fontSize: "var(--text-body)",
              color: "var(--ink-3)",
            }}
          >
            {showArchived
              ? "No archived runs — use the archive button on a run to hide it here."
              : simple
                ? "No runs yet — open an automation and press “Run now”."
                : "No runs yet — start one from the canvas or “Start test run”."}
          </div>
        )}

        {rows.map((r) => {
          const go = () =>
            navigate(`/app/runs/${encodeURIComponent(r.workflowId)}`);
          const selectBox = (
            <input
              type="checkbox"
              aria-label={`Select run ${r.workflowId}`}
              checked={selected.has(r.workflowId)}
              disabled={bulkBusy}
              onClick={(e) => toggleSelect(r.workflowId, e)}
              onChange={() => {}}
            />
          );
          const actions = (
            <>
              {isTerminal(r.status) && (
                <RerunMenu
                  runId={r.workflowId}
                  workflowKey={r.workflowKey}
                  currentVersion={r.graphVersion}
                  onRerun={(newId) =>
                    navigate(`/app/runs/${encodeURIComponent(newId)}`)
                  }
                  onError={setError}
                />
              )}
              <Button
                size="sm"
                variant="secondary"
                icon={r.archived ? "eye" : "archive"}
                iconOnly
                title={
                  r.archived
                    ? "Restore to the Runs list"
                    : "Archive — hide from this list"
                }
                aria-label={
                  r.archived
                    ? "Restore to the Runs list"
                    : "Archive — hide from this list"
                }
                disabled={archiving.has(r.workflowId)}
                onClick={(e) => void toggleArchive(r.workflowId, r.archived, e)}
              />
            </>
          );

          // Phone: a stacked, self-labelling card instead of an 8-column grid row.
          if (phone) {
            return (
              <div
                key={r.workflowId}
                onClick={go}
                className="run-row"
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                  padding: "12px 16px",
                  borderBottom: "1px solid var(--line)",
                  cursor: "pointer",
                  background: selected.has(r.workflowId)
                    ? "var(--brand-soft)"
                    : undefined,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 10,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      minWidth: 0,
                    }}
                  >
                    {selectBox}
                    <StatusPill {...runStatusUi(r.status)} />
                  </div>
                  <span
                    className="mono"
                    style={{
                      fontSize: "var(--text-2xs)",
                      color: "var(--ink-3)",
                      flex: "none",
                    }}
                  >
                    {ago(r.startedAt)}
                  </span>
                </div>
                <div style={{ minWidth: 0 }}>
                  <div
                    className="mono"
                    style={{
                      fontSize: "var(--text-xs)",
                      color: "var(--ink-2)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {r.workflowKey ?? "—"}
                  </div>
                  <div
                    className="mono"
                    style={{
                      fontSize: "var(--text-2xs)",
                      color: "var(--brand)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {r.workflowId}
                  </div>
                </div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 10,
                  }}
                >
                  <div
                    className="mono"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      fontSize: "var(--text-2xs)",
                      color: "var(--ink-3)",
                    }}
                  >
                    <span>
                      {r.costUsd === null ? "—" : `$${r.costUsd.toFixed(4)}`}
                    </span>
                    {/* Real duration when recorded (Slice 2) — phone card keeps it terse. */}
                    {r.durationMs !== null && (
                      <span>{durText(r.durationMs)}</span>
                    )}
                    <VersionBadge version={r.graphVersion} />
                  </div>
                  <span style={{ display: "flex", gap: 6 }}>{actions}</span>
                </div>
              </div>
            );
          }

          return (
            <div
              key={r.workflowId}
              onClick={go}
              className="run-row"
              style={{
                display: "grid",
                gridTemplateColumns: COLS,
                gap: 10,
                padding: "12px 18px",
                borderBottom: "1px solid var(--line)",
                alignItems: "center",
                cursor: "pointer",
                background: selected.has(r.workflowId)
                  ? "var(--brand-soft)"
                  : undefined,
              }}
            >
              <span style={{ display: "flex", alignItems: "center" }}>
                {selectBox}
              </span>
              <span
                className="mono"
                style={{
                  fontSize: "var(--text-xs)",
                  color: "var(--brand)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {r.workflowId}
              </span>
              <span
                className="mono"
                style={{ fontSize: "var(--text-xs)", color: "var(--ink-2)" }}
              >
                {r.workflowKey ?? "—"}
              </span>
              <span>
                <VersionBadge version={r.graphVersion} />
              </span>
              <span>
                <StatusPill {...runStatusUi(r.status)} />
              </span>
              <span
                className="mono"
                style={{ fontSize: "var(--text-xs)", color: "var(--ink-2)" }}
              >
                {r.costUsd === null ? "—" : `$${r.costUsd.toFixed(4)}`}
              </span>
              <span
                className="mono"
                style={{ fontSize: "var(--text-xs)", color: "var(--ink-2)" }}
              >
                {durText(r.durationMs)}
              </span>
              <span
                className="mono"
                style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}
              >
                {ago(r.startedAt)}
              </span>
              <span
                style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}
              >
                {actions}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
