import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Card, Icon } from "../../components";
import { api, type AwaitingApproval, UnauthorizedError } from "../../lib/api";

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
  const [items, setItems] = useState<AwaitingApproval[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [comments, setComments] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    try {
      setItems(await api.listAwaitingApprovals());
      setError(null);
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

  async function decide(item: AwaitingApproval, approved: boolean) {
    setBusy(item.workflowId);
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
    } catch {
      // The run may have just been decided elsewhere or timed out — reload to reconcile.
      await load();
    } finally {
      setBusy(null);
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
        Runs waiting on your decision. Approving continues the workflow;
        rejecting stops it.
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
                <div
                  style={{
                    fontSize: "var(--text-lg)",
                    fontWeight: "var(--weight-semibold)",
                    color: "var(--ink)",
                  }}
                >
                  {it.title}
                </div>
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
                  {it.workflowKey ?? "workflow"} · {ago(it.createdAt)}
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
                disabled={busy === it.workflowId}
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
                  disabled={busy === it.workflowId}
                  onClick={() => void decide(it, true)}
                >
                  Approve
                </Button>
                <Button
                  variant="danger"
                  disabled={busy === it.workflowId}
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
