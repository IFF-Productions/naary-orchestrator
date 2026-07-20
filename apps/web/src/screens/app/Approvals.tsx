import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Button,
  Card,
  Checkbox,
  Icon,
  Skeleton,
  Toast,
} from "../../components";
import { api, type AwaitingApproval, UnauthorizedError } from "../../lib/api";
import { PHONE_QUERY, useMediaQuery } from "../../lib/useMediaQuery";
import { useMode } from "../../mode";
import { DetailPanel } from "./approvals/DetailPanel";
import { QueueRow } from "./approvals/QueueRow";
import { isOverdue, isRecent, slaInfo } from "./approvals/urgency";

type Filter = "all" | "overdue" | "recent";

interface ToastItem {
  id: number;
  kind: "done" | "info" | "error";
  text: string;
  meta?: string;
}

/** Pill filter chip (All N / Overdue N / Recent N). */
function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        fontSize: "var(--text-sm)",
        padding: "5px 12px",
        borderRadius: "var(--radius-pill)",
        cursor: "pointer",
        fontFamily: "var(--font-sans)",
        fontWeight: "var(--weight-medium)",
        color: active ? "var(--ink)" : "var(--ink-faint)",
        background: active ? "var(--hover)" : "transparent",
        border: `1px solid ${active ? "var(--line-2)" : "transparent"}`,
        transition: "color .12s ease, background .12s ease",
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = "var(--hover)";
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = "transparent";
      }}
    >
      {children}
    </button>
  );
}

/** The design's "Inbox zero" card — green check tile, teaching copy. */
function InboxZero() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "80px 20px",
        textAlign: "center",
      }}
    >
      <div
        style={{
          width: 52,
          height: 52,
          borderRadius: 14,
          background: "var(--done-soft)",
          border:
            "1px solid color-mix(in srgb, var(--state-done) 40%, transparent)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          marginBottom: 14,
          color: "var(--state-done)",
        }}
      >
        <Icon name="check" size={26} strokeWidth={2.4} />
      </div>
      <div style={{ fontSize: 15, fontWeight: 600, color: "var(--ink)" }}>
        Inbox zero
      </div>
      <div
        style={{
          fontSize: 12.5,
          color: "var(--ink-faint)",
          marginTop: 4,
          maxWidth: 380,
        }}
      >
        No approvals waiting. Paused runs will appear here the moment they hit a
        gate.
      </div>
    </div>
  );
}

/**
 * Approvals inbox — the hero human-in-the-loop surface. Master-detail: every
 * run across the tenant that's paused for a human decision on the left (with
 * multi-select for batch decisions), full context + decide-in-place on the
 * right. Approve/reject inline with an optional audit-log comment; light 5s
 * polling keeps the queue live.
 */
export function Approvals() {
  const navigate = useNavigate();
  const { mode } = useMode();
  const simple = mode === "simple";
  const phone = useMediaQuery(PHONE_QUERY);

  const [items, setItems] = useState<AwaitingApproval[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [comments, setComments] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  // Multi-select for batch decisions. `selected` holds workflowIds; `batchBusy` locks
  // every control (single + batch) while a batch call is in flight.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchReason, setBatchReason] = useState("");
  // Master-detail focus (which request the right panel shows) + queue filter.
  const [focusId, setFocusId] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  // Decide-in-place feedback.
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const toastId = useRef(0);

  function pushToast(kind: ToastItem["kind"], text: string, meta?: string) {
    const id = ++toastId.current;
    setToasts((ts) => [...ts, { id, kind, text, meta }]);
    toastTimers.current.push(
      setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 2600),
    );
  }
  useEffect(() => () => toastTimers.current.forEach(clearTimeout), []);

  async function load() {
    try {
      const next = await api.listAwaitingApprovals();
      setItems(next);
      setError(null);
      // Drop selections for runs that are no longer awaiting (decided elsewhere / timed out).
      const live = new Set(next.map((x) => x.workflowId));
      setSelected((s) => {
        const kept = [...s].filter((id) => live.has(id));
        return kept.length === s.size ? s : new Set(kept);
      });
    } catch (e) {
      setError(
        e instanceof UnauthorizedError
          ? "Not authenticated — sign in (or set an API token) to see approvals."
          : "Could not reach the control plane (apps/api on :3000).",
      );
    }
  }

  useEffect(() => {
    void load();
    // Light polling so a newly-paused run appears without a manual refresh.
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, []);

  const now = Date.now();
  // Real due-by tones when the gate has an SLA (dueAt), waiting-age otherwise.
  const infoOf = (it: AwaitingApproval) => slaInfo(it.createdAt, it.dueAt, now);
  const all = items ?? [];
  const overdueCount = all.filter((it) => isOverdue(infoOf(it))).length;
  const recentCount = all.filter((it) => isRecent(infoOf(it))).length;
  const visible = all.filter((it) =>
    filter === "overdue"
      ? isOverdue(infoOf(it))
      : filter === "recent"
        ? isRecent(infoOf(it))
        : true,
  );

  // Keep the detail panel pointed at something visible: follow the queue as
  // rows are decided away or the filter changes.
  useEffect(() => {
    if (items === null) return;
    if (visible.length === 0) {
      if (focusId !== null) setFocusId(null);
      return;
    }
    if (!focusId || !visible.some((x) => x.workflowId === focusId))
      setFocusId(visible[0].workflowId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- derived from items+filter
  }, [items, filter, focusId]);

  function toggle(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function decide(item: AwaitingApproval, approved: boolean) {
    setBusy(item.workflowId);
    setNotice(null);
    try {
      await api.approve(
        item.workflowId,
        approved,
        comments[item.workflowId]?.trim(),
      );
      // Drop it from the list immediately; the poll reconciles the rest.
      setItems((xs) =>
        (xs ?? []).filter((x) => x.workflowId !== item.workflowId),
      );
      setSelected((s) => {
        if (!s.has(item.workflowId)) return s;
        const next = new Set(s);
        next.delete(item.workflowId);
        return next;
      });
      pushToast(
        approved ? "done" : "info",
        approved ? "Approved" : "Rejected",
        item.title,
      );
    } catch {
      // The run may have just been decided elsewhere or timed out — reload to reconcile.
      pushToast("error", "Couldn't record the decision — refreshed the queue.");
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function decideBatch(approved: boolean) {
    const ids = [...selected];
    if (ids.length === 0) return;
    setBatchBusy(true);
    setNotice(null);
    try {
      const results = await api.approveBatch(
        ids,
        approved,
        batchReason.trim() || undefined,
      );
      const okIds = new Set(
        results.filter((r) => r.ok).map((r) => r.workflowId),
      );
      // Drop the runs that were decided; KEEP any that slipped so the reviewer still sees them.
      setItems((xs) => (xs ?? []).filter((x) => !okIds.has(x.workflowId)));
      setSelected((s) => new Set([...s].filter((id) => !okIds.has(id))));
      const failed = results.length - okIds.size;
      if (okIds.size > 0)
        pushToast(
          approved ? "done" : "info",
          `${approved ? "Approved" : "Rejected"} ${okIds.size} request${okIds.size === 1 ? "" : "s"}`,
          "bulk decision",
        );
      if (failed > 0) {
        setNotice(
          `${okIds.size} ${approved ? "approved" : "rejected"}, ${failed} could not be decided (already decided, closed, or timed out) — refreshed.`,
        );
        await load();
      } else {
        setBatchReason("");
      }
    } catch {
      await load();
    } finally {
      setBatchBusy(false);
    }
  }

  // Manual "Remind now" — re-fires the approval notification to the run env's channels.
  const [remindBusy, setRemindBusy] = useState<string | null>(null);
  async function remind(item: AwaitingApproval) {
    setRemindBusy(item.workflowId);
    try {
      const res = await api.remindApproval(item.workflowId);
      pushToast(
        "done",
        res.sent > 0
          ? `Reminder sent to ${res.sent} channel${res.sent === 1 ? "" : "s"}`
          : "No enabled notification channels to remind",
        item.title,
      );
    } catch {
      pushToast("error", "Couldn't send the reminder — refreshed the queue.");
      await load();
    } finally {
      setRemindBusy(null);
    }
  }

  const focused = visible.find((x) => x.workflowId === focusId) ?? null;
  const visibleIds = visible.map((x) => x.workflowId);
  const allSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const selCount = selected.size;
  const loading = items === null && !error;

  const filterBar = (
    <div
      style={{
        minHeight: 52,
        flex: "none",
        borderBottom: "1px solid var(--line)",
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 9,
        padding: "8px 20px",
      }}
    >
      <span
        title={allSelected ? "Clear selection" : "Select all"}
        style={{ display: "inline-flex", marginRight: 2 }}
      >
        <Checkbox
          checked={allSelected}
          onChange={(v) => {
            if (batchBusy) return;
            setSelected(v ? new Set(visibleIds) : new Set());
          }}
        />
      </span>
      {selCount === 0 ? (
        <>
          <FilterChip
            active={filter === "all"}
            onClick={() => setFilter("all")}
          >
            All {all.length}
          </FilterChip>
          <FilterChip
            active={filter === "overdue"}
            onClick={() => setFilter("overdue")}
          >
            Overdue {overdueCount}
          </FilterChip>
          <FilterChip
            active={filter === "recent"}
            onClick={() => setFilter("recent")}
          >
            Recent {recentCount}
          </FilterChip>
          {!phone && (
            <span
              style={{
                marginLeft: "auto",
                fontSize: 11.5,
                color: "var(--ink-faint)",
              }}
            >
              Select rows to decide in bulk
            </span>
          )}
        </>
      ) : (
        <>
          <span
            style={{
              fontSize: 12.5,
              fontWeight: "var(--weight-semibold)",
              color: "var(--ink)",
            }}
          >
            {selCount} selected
          </span>
          <input
            value={batchReason}
            onChange={(e) => setBatchReason(e.target.value)}
            placeholder="Reason for the batch (optional)"
            disabled={batchBusy}
            style={{
              flex: "1 1 160px",
              minWidth: 120,
              maxWidth: 280,
              padding: "7px 10px",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--line-2)",
              background: "var(--card)",
              color: "var(--ink)",
              fontSize: "var(--text-sm)",
              fontFamily: "var(--font-sans)",
              outline: "none",
            }}
          />
          <Button
            variant="positive"
            icon="check"
            loading={batchBusy}
            onClick={() => void decideBatch(true)}
          >
            Approve {selCount}
          </Button>
          <Button
            variant="danger"
            disabled={batchBusy}
            onClick={() => void decideBatch(false)}
          >
            Reject {selCount}
          </Button>
          <Button
            variant="ghost"
            disabled={batchBusy}
            onClick={() => setSelected(new Set())}
          >
            Clear
          </Button>
        </>
      )}
    </div>
  );

  const queueList = (
    <div
      className="scroll"
      style={{
        flex: phone ? undefined : 1,
        overflowY: phone ? undefined : "auto",
        padding: "12px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 5,
      }}
    >
      {loading &&
        Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} height={58} radius={11} />
        ))}
      {!loading && visible.length === 0 && !error && <InboxZero />}
      {visible.map((it) => (
        <QueueRow
          key={it.workflowId}
          item={it}
          waiting={infoOf(it)}
          active={it.workflowId === focusId}
          checked={selected.has(it.workflowId)}
          disabled={batchBusy || busy === it.workflowId}
          onFocus={() => setFocusId(it.workflowId)}
          onToggleCheck={() => toggle(it.workflowId)}
        />
      ))}
    </div>
  );

  const detail = focused ? (
    // Keyed by the focused request so switching rows fades the new context in.
    <div
      key={focused.workflowId}
      style={{ animation: "naaryFadeUp .25s ease" }}
    >
      <DetailPanel
        item={focused}
        waiting={infoOf(focused)}
        simple={simple}
        comment={comments[focused.workflowId] ?? ""}
        onCommentChange={(v) =>
          setComments((c) => ({ ...c, [focused.workflowId]: v }))
        }
        onDecide={(approved) => void decide(focused, approved)}
        onOpenRun={() => navigate(`/app/runs/${focused.workflowId}`)}
        onRemind={() => void remind(focused)}
        remindBusy={remindBusy === focused.workflowId}
        disabled={batchBusy || busy === focused.workflowId}
        busy={busy === focused.workflowId}
      />
    </div>
  ) : (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        minHeight: 120,
        padding: 40,
        textAlign: "center",
        color: "var(--ink-faint)",
        fontSize: "var(--text-body)",
      }}
    >
      Select a request to see its context.
    </div>
  );

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        // Fill the shell's content region (52px context bar + 44px breadcrumb)
        // so the queue and detail panel scroll independently on desktop.
        height: phone ? undefined : "calc(100vh - 96px)",
        minHeight: 0,
      }}
    >
      {/* header */}
      <div
        style={{
          flex: "none",
          padding: phone ? "16px 16px 12px" : "20px 28px 14px",
          display: "flex",
          alignItems: "baseline",
          flexWrap: "wrap",
          gap: 10,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Icon name="approval" style={{ color: "var(--node-approval)" }} />
          <h1
            style={{
              fontSize: "var(--text-title)",
              fontWeight: "var(--weight-bold)",
              letterSpacing: "var(--tracking-tight)",
              color: "var(--ink)",
              margin: 0,
            }}
          >
            Approvals
          </h1>
        </div>
        <span
          style={{
            fontSize: 11.5,
            color: "var(--ink-faint)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {items === null
            ? "…"
            : `${all.length} pending · ${overdueCount} overdue`}
        </span>
        <span
          style={{
            flexBasis: "100%",
            fontSize: "var(--text-body)",
            color: "var(--ink-2)",
          }}
        >
          Runs waiting on your decision. Approving continues the{" "}
          {simple ? "automation" : "workflow"}; rejecting stops it.
        </span>
      </div>

      {error && (
        <div style={{ padding: phone ? "0 16px 12px" : "0 28px 12px" }}>
          <Card>
            <div
              style={{
                color: "var(--state-error)",
                fontSize: "var(--text-body)",
              }}
            >
              {error}
            </div>
          </Card>
        </div>
      )}

      {notice && (
        <div style={{ padding: phone ? "0 16px 12px" : "0 28px 12px" }}>
          <Card>
            <div
              style={{ color: "var(--ink-2)", fontSize: "var(--text-body)" }}
            >
              {notice}
            </div>
          </Card>
        </div>
      )}

      {/* master–detail */}
      <div
        style={{
          flex: phone ? undefined : 1,
          minHeight: 0,
          display: "flex",
          flexDirection: phone ? "column" : "row",
          borderTop: "1px solid var(--line)",
        }}
      >
        {/* queue */}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            borderRight: phone ? undefined : "1px solid var(--line)",
          }}
        >
          {filterBar}
          {queueList}
        </div>

        {/* detail (472px on desktop, stacked below the list on phone).
            Hidden at inbox zero and while the control plane is unreachable. */}
        {!(items !== null && all.length === 0) &&
          !(items === null && error) && (
            <div
              className="scroll"
              style={{
                width: phone ? undefined : "clamp(340px, 38vw, 472px)",
                flex: "none",
                overflowY: phone ? undefined : "auto",
                background: "var(--panel)",
                borderTop: phone ? "1px solid var(--line)" : undefined,
              }}
            >
              {loading ? (
                <div
                  style={{
                    padding: 22,
                    display: "flex",
                    flexDirection: "column",
                    gap: 12,
                  }}
                >
                  <Skeleton height={40} radius={10} />
                  <Skeleton height={16} width="60%" />
                  <Skeleton height={90} radius={11} />
                </div>
              ) : (
                detail
              )}
            </div>
          )}
      </div>

      {/* decide-in-place toasts (bottom-right, slide+scale in, auto-dismiss) */}
      <div
        style={{
          position: "fixed",
          right: 24,
          bottom: 22,
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-end",
          gap: 9,
          zIndex: 60,
        }}
      >
        {/* the shared Toast primitive animates in (naaryToastIn) by itself */}
        {toasts.map((t) => (
          <div key={t.id}>
            <Toast
              kind={t.kind}
              onDismiss={() =>
                setToasts((ts) => ts.filter((x) => x.id !== t.id))
              }
            >
              <span style={{ fontWeight: "var(--weight-medium)" }}>
                {t.text}
              </span>
              {t.meta && (
                <span
                  style={{
                    marginLeft: 10,
                    fontSize: "var(--text-xs)",
                    fontFamily: "var(--font-mono)",
                    color: "var(--ink-faint)",
                  }}
                >
                  {t.meta}
                </span>
              )}
            </Toast>
          </div>
        ))}
      </div>
    </div>
  );
}
