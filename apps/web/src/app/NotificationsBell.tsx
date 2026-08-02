import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Icon } from "../components";
import { api, getActiveWorkspace } from "../lib/api";
import { isFailure, runStatusUi } from "../lib/run-status";
import {
  NO_TRUST,
  approvalKey,
  browserDismissalStore,
  dismissAll,
  readDismissed,
  reconcileDismissed,
  runKey,
  sameIds,
  writeDismissed,
} from "./notifications-dismissed";

interface NotifItem {
  kind: "approval" | "failed";
  key: string;
  title: string;
  sub: string;
  at: string;
  to: string;
}

/** How many items the panel shows at once. The dismissal set is reconciled against ALL fetched
 *  items, never this slice — see notifications-dismissed.ts. */
const MAX_VISIBLE = 8;

/** Resolved once: `localStorage`, or null where it is unavailable/blocked. */
const STORE = browserDismissalStore();

/** Short relative time, e.g. "3m", "2h", "5d". */
function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/**
 * Topbar notifications: the things that actually need your attention — workflow runs paused for
 * approval + recently failed runs (the same events the webhook-notifications feature alerts on).
 * Polls every 45s; the unread dot is REAL (reflects the item count), not decorative.
 *
 * There is no server-side inbox behind this — the list is derived live from the two queries below
 * on every poll. "Clear all" therefore records the ids of what you have seen (per workspace, in
 * localStorage) and every later poll filters them out; see notifications-dismissed.ts for why that
 * stays per-item and self-pruning rather than becoming a mute switch.
 */
export function NotificationsBell() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotifItem[] | null>(null);
  /** Dismissed items that this poll saw are still live — cleared, but not resolved. */
  const [hiddenCount, setHiddenCount] = useState(0);
  /** The last poll's FULL fetched list (pre-cap), so Clear all and its immediate re-render work
   *  from everything the server sent, not just the eight rows on screen. */
  const candidatesRef = useRef<NotifItem[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      // `null` (not `[]`) on failure: an errored query means "no data", which must never be read
      // as "these items are gone" — that would prune dismissals and resurrect cleared items.
      const [approvals, runs] = await Promise.all([
        api.listAwaitingApprovals().catch(() => null),
        api.listRuns().catch(() => null),
      ]);
      const approvalItems: NotifItem[] = (approvals ?? []).map((a) => ({
        kind: "approval",
        key: approvalKey(a.workflowId, a.nodeId),
        title: `Approval needed: ${a.title}`,
        sub: a.workflowName ?? a.workflowKey ?? a.workflowId,
        at: a.createdAt,
        to: `/app/runs/${a.workflowId}`,
      }));
      const failItems: NotifItem[] = (runs ?? [])
        .filter((r) => isFailure(r.status))
        .map((r) => ({
          kind: "failed",
          key: runKey(r.workflowId),
          title: `Run failed: ${r.workflowName ?? r.workflowKey ?? "workflow"}`,
          sub: runStatusUi(r.status).label,
          at: r.startedAt,
          to: `/app/runs/${r.workflowId}`,
        }));
      const candidates = [...approvalItems, ...failItems].sort((a, b) =>
        a.at < b.at ? 1 : -1,
      );
      candidatesRef.current = candidates;
      // Read storage fresh each poll rather than trusting React state: another tab may have
      // cleared, and the workspace may have changed since mount.
      const workspaceId = getActiveWorkspace();
      const stored = readDismissed(STORE, workspaceId);
      const { visible, persist, liveHiddenCount } = reconcileDismissed(
        candidates,
        stored,
        { approvals: approvals !== null, runs: runs !== null },
      );
      if (!sameIds(persist, stored))
        writeDismissed(STORE, workspaceId, persist);
      setItems(visible.slice(0, MAX_VISIBLE));
      setHiddenCount(liveHiddenCount);
    } catch {
      setItems([]);
    }
  }, []);

  /**
   * Clear all: dismiss every item this poll fetched — including any beyond the eight on screen,
   * because a button labelled "Clear all" that leaves a fresh page of rows behind reads as broken.
   * Still strictly per-id, so the next new approval or failure comes straight back.
   */
  const clearAll = useCallback(() => {
    const workspaceId = getActiveWorkspace();
    const candidates = candidatesRef.current;
    const next = dismissAll(
      readDismissed(STORE, workspaceId),
      candidates.map((c) => c.key),
    );
    writeDismissed(STORE, workspaceId, next);
    // NO_TRUST: this is the previous poll's data, so there is nothing new to prune against.
    const { visible, liveHiddenCount } = reconcileDismissed(
      candidates,
      next,
      NO_TRUST,
    );
    setItems(visible.slice(0, MAX_VISIBLE));
    setHiddenCount(liveHiddenCount);
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 45_000);
    return () => clearInterval(t);
  }, [load]);

  // Refetch when opening so the panel is fresh.
  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  // Click-away to close.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const count = items?.length ?? 0;

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        type="button"
        className="btn btn-secondary btn-icon"
        style={{ position: "relative" }}
        title="Notifications"
        aria-label={`Notifications${count ? ` (${count})` : ""}`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="bell" size={16} />
        {count > 0 && (
          <span
            style={{
              position: "absolute",
              top: -5,
              right: -5,
              minWidth: 16,
              height: 16,
              padding: "0 3px",
              // border-box + flex centering so the 1.5px ring is included in the box and the digit
              // is centred on BOTH axes (lineHeight-based centring drifts once the border is added).
              boxSizing: "border-box",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 999,
              background: "var(--state-error)",
              color: "#fff",
              fontSize: 9.5,
              fontWeight: 700,
              border: "1.5px solid var(--bg-2)",
            }}
          >
            {count > 9 ? "9+" : count}
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          className="menu-pop"
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            right: 0,
            width: 320,
            maxHeight: 420,
            overflowY: "auto",
            zIndex: 60,
            background: "var(--bg-2)",
            border: "1px solid var(--line)",
            borderRadius: 12,
            boxShadow: "0 12px 40px rgba(0,0,0,.32)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              padding: "11px 14px",
              borderBottom: "1px solid var(--line)",
              fontSize: 12.5,
              fontWeight: 600,
              color: "var(--ink)",
            }}
          >
            <span>Notifications</span>
            {count > 0 && (
              <button
                type="button"
                onClick={clearAll}
                aria-label="Clear all notifications"
                title="Dismiss these notifications. Pending approvals stay open in the Approvals inbox."
                style={{
                  all: "unset",
                  cursor: "pointer",
                  fontSize: 11.5,
                  fontWeight: 600,
                  color: "var(--brand)",
                }}
              >
                Clear all
              </button>
            )}
          </div>

          {items === null ? (
            <div style={{ padding: 16, fontSize: 12.5, color: "var(--ink-3)" }}>
              Loading…
            </div>
          ) : count === 0 ? (
            <div style={{ padding: 18, fontSize: 12.5, color: "var(--ink-2)" }}>
              {/* Never claim "all caught up" when the count is 0 only because things were
                  cleared — clearing dismisses the notification, not the work behind it. */}
              {hiddenCount > 0
                ? `Nothing new. ${hiddenCount} cleared ${hiddenCount === 1 ? "item is" : "items are"} still open — they stay in Approvals and Activity.`
                : "You're all caught up — no pending approvals or recent failures."}
            </div>
          ) : (
            items.map((it) => (
              <button
                key={it.key}
                type="button"
                onClick={() => {
                  navigate(it.to);
                  setOpen(false);
                }}
                style={{
                  all: "unset",
                  boxSizing: "border-box",
                  cursor: "pointer",
                  display: "flex",
                  gap: 10,
                  width: "100%",
                  padding: "11px 14px",
                  borderBottom: "1px solid var(--line)",
                }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    marginTop: 5,
                    flex: "none",
                    background:
                      it.kind === "approval"
                        ? "var(--brand)"
                        : "var(--state-error)",
                  }}
                />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span
                    style={{
                      display: "block",
                      fontSize: 12.5,
                      fontWeight: 600,
                      color: "var(--ink)",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {it.title}
                  </span>
                  <span
                    style={{
                      display: "block",
                      fontSize: 11,
                      color: "var(--ink-3)",
                      marginTop: 1,
                    }}
                  >
                    {it.sub} · {ago(it.at)}
                  </span>
                </span>
              </button>
            ))
          )}

          <button
            type="button"
            onClick={() => {
              navigate("/app/activity");
              setOpen(false);
            }}
            style={{
              all: "unset",
              boxSizing: "border-box",
              cursor: "pointer",
              display: "block",
              width: "100%",
              padding: "10px 14px",
              textAlign: "center",
              fontSize: 12,
              fontWeight: 600,
              color: "var(--brand)",
            }}
          >
            View activity
          </button>
        </div>
      )}
    </div>
  );
}
