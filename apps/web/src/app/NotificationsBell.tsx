import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Icon } from "../components";
import { api } from "../lib/api";
import { isFailure, runStatusUi } from "../lib/run-status";

interface NotifItem {
  kind: "approval" | "failed";
  key: string;
  title: string;
  sub: string;
  at: string;
  to: string;
}

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
 */
export function NotificationsBell() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotifItem[] | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const [approvals, runs] = await Promise.all([
        api.listAwaitingApprovals().catch(() => []),
        api.listRuns().catch(() => []),
      ]);
      const approvalItems: NotifItem[] = approvals.map((a) => ({
        kind: "approval",
        key: `ap-${a.workflowId}-${a.nodeId}`,
        title: `Approval needed: ${a.title}`,
        sub: a.workflowKey ?? a.workflowId,
        at: a.createdAt,
        to: `/app/runs/${a.workflowId}`,
      }));
      const failItems: NotifItem[] = runs
        .filter((r) => isFailure(r.status))
        .slice(0, 12)
        .map((r) => ({
          kind: "failed",
          key: `run-${r.workflowId}`,
          title: `Run failed: ${r.workflowKey ?? "workflow"}`,
          sub: runStatusUi(r.status).label,
          at: r.startedAt,
          to: `/app/runs/${r.workflowId}`,
        }));
      setItems(
        [...approvalItems, ...failItems]
          .sort((a, b) => (a.at < b.at ? 1 : -1))
          .slice(0, 8),
      );
    } catch {
      setItems([]);
    }
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
              padding: "11px 14px",
              borderBottom: "1px solid var(--line)",
              fontSize: 12.5,
              fontWeight: 600,
              color: "var(--ink)",
            }}
          >
            Notifications
          </div>

          {items === null ? (
            <div style={{ padding: 16, fontSize: 12.5, color: "var(--ink-3)" }}>
              Loading…
            </div>
          ) : count === 0 ? (
            <div style={{ padding: 18, fontSize: 12.5, color: "var(--ink-2)" }}>
              You're all caught up — no pending approvals or recent failures.
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
