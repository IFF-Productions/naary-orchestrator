import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Card, Icon } from "../../components";
import { api, type AwaitingApproval, UnauthorizedError } from "../../lib/api";
import { useMode } from "../../mode";

/** Compact relative time from an ISO timestamp (no date lib). */
function ago(iso: string): string {
  const s = Math.max(
    0,
    Math.round((Date.now() - new Date(iso).getTime()) / 1000),
  );
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * Approvals inbox — every run across the tenant that's paused for a human decision,
 * shown WITH its prompt (title/instructions from the graph) so a reviewer can act
 * without opening each run. Approve/reject inline, with an optional reason.
 */
export function Approvals() {
  const navigate = useNavigate();
  const { mode } = useMode();
  const simple = mode === "simple";
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
    } catch {
      // The run may have just been decided elsewhere or timed out — reload to reconcile.
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

  return (
    <div style={{ padding: "24px 28px", maxWidth: 820 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 6,
        }}
      >
        <Icon name="approval" />
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
      <p
        style={{
          color: "var(--ink-2)",
          fontSize: "var(--text-body)",
          marginTop: 0,
        }}
      >
        Runs waiting on your decision. Approving continues the{" "}
        {simple ? "automation" : "workflow"}; rejecting stops it.
      </p>

      {error && (
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
      )}

      {notice && (
        <Card>
          <div
            style={{
              color: "var(--ink-2)",
              fontSize: "var(--text-body)",
            }}
          >
            {notice}
          </div>
        </Card>
      )}

      {!error && items?.length === 0 && (
        <Card>
          <div
            style={{
              color: "var(--ink-3)",
              fontSize: "var(--text-md)",
              padding: "8px 2px",
            }}
          >
            Nothing waiting for approval right now. 🎉
          </div>
        </Card>
      )}

      {(items?.length ?? 0) > 0 &&
        (() => {
          const ids = items?.map((x) => x.workflowId) ?? [];
          const allSelected =
            ids.length > 0 && ids.every((id) => selected.has(id));
          const count = selected.size;
          return (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                flexWrap: "wrap",
                gap: 10,
                padding: "10px 12px",
                marginBottom: 12,
                borderRadius: "var(--radius-sm)",
                border: "1px solid var(--line)",
                background: "var(--surface-2, var(--card))",
              }}
            >
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: "var(--text-body)",
                  color: "var(--ink-2)",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={allSelected}
                  disabled={batchBusy}
                  onChange={(e) =>
                    setSelected(e.target.checked ? new Set(ids) : new Set())
                  }
                />
                {count > 0 ? `${count} selected` : "Select all"}
              </label>
              <input
                value={batchReason}
                onChange={(e) => setBatchReason(e.target.value)}
                placeholder="Reason for the batch (optional)"
                disabled={batchBusy || count === 0}
                style={{
                  flex: "1 1 200px",
                  minWidth: 160,
                  padding: "7px 10px",
                  borderRadius: "var(--radius-sm)",
                  border: "1px solid var(--line)",
                  background: "var(--card)",
                  color: "var(--ink)",
                  fontSize: "var(--text-body)",
                }}
              />
              <Button
                variant="positive"
                disabled={batchBusy || count === 0}
                onClick={() => void decideBatch(true)}
              >
                Approve selected
              </Button>
              <Button
                variant="danger"
                disabled={batchBusy || count === 0}
                onClick={() => void decideBatch(false)}
              >
                Reject selected
              </Button>
            </div>
          );
        })()}

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {items?.map((it) => (
          <Card key={it.workflowId}>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                }}
              >
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    fontSize: "var(--text-lg)",
                    fontWeight: "var(--weight-semibold)",
                    color: "var(--ink)",
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(it.workflowId)}
                    disabled={batchBusy || busy === it.workflowId}
                    onChange={() => toggle(it.workflowId)}
                  />
                  {it.title}
                </label>
                <button
                  type="button"
                  onClick={() => navigate(`/app/runs/${it.workflowId}`)}
                  title="Open the run"
                  style={{
                    background: "none",
                    border: "none",
                    color: "var(--ink-3)",
                    fontSize: "var(--text-xs)",
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                  }}
                >
                  {it.workflowKey ?? (simple ? "automation" : "workflow")} ·{" "}
                  {ago(it.createdAt)}
                </button>
              </div>
              {it.instructions && (
                <div
                  style={{
                    fontSize: "var(--text-body)",
                    color: "var(--ink-2)",
                    lineHeight: "var(--leading-snug)",
                  }}
                >
                  {it.instructions}
                </div>
              )}
              <input
                value={comments[it.workflowId] ?? ""}
                onChange={(e) =>
                  setComments((c) => ({
                    ...c,
                    [it.workflowId]: e.target.value,
                  }))
                }
                placeholder="Add a reason (optional)"
                disabled={busy === it.workflowId || batchBusy}
                style={{
                  padding: "7px 10px",
                  borderRadius: "var(--radius-sm)",
                  border: "1px solid var(--line)",
                  background: "var(--card)",
                  color: "var(--ink)",
                  fontSize: "var(--text-body)",
                }}
              />
              <div style={{ display: "flex", gap: 8 }}>
                <Button
                  variant="positive"
                  disabled={busy === it.workflowId || batchBusy}
                  onClick={() => void decide(it, true)}
                >
                  Approve
                </Button>
                <Button
                  variant="danger"
                  disabled={busy === it.workflowId || batchBusy}
                  onClick={() => void decide(it, false)}
                >
                  Reject
                </Button>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
