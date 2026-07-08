import { useEffect, useState } from "react";
import { Card, Icon } from "../../components";
import { api, type AuditEvent, UnauthorizedError } from "../../lib/api";

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
 * Activity feed — the tenant's audit log: who did what, when. Every mutating
 * request (save a workflow, decide an approval, add a connection, change a key…)
 * is captured server-side by the AuditInterceptor.
 */
export function Activity() {
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const me = await api.getMe();
        const rows = await api.getAuditLog(me.tenantId);
        if (live) setEvents(rows);
      } catch (e) {
        if (live)
          setError(
            e instanceof UnauthorizedError
              ? "Sign in to view activity."
              : "Could not reach the control plane (apps/api on :3000).",
          );
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  return (
    <div style={{ padding: "24px 28px", maxWidth: 820 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 4,
        }}
      >
        <Icon name="activity" />
        <h1
          style={{
            fontSize: "var(--text-title)",
            fontWeight: "var(--weight-bold)",
            color: "var(--ink)",
            letterSpacing: "var(--tracking-tight)",
            margin: 0,
          }}
        >
          Activity
        </h1>
      </div>
      <p
        style={{
          color: "var(--ink-2)",
          fontSize: "var(--text-body)",
          marginTop: 0,
        }}
      >
        A record of changes in this workspace — who did what, and when.
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

      {!error && events?.length === 0 && (
        <Card>
          <div
            style={{
              color: "var(--ink-3)",
              fontSize: "var(--text-body)",
              padding: "8px 2px",
            }}
          >
            No activity yet.
          </div>
        </Card>
      )}

      {events && events.length > 0 && (
        <Card style={{ padding: 0 }}>
          {events.map((e, i) => (
            <div
              key={e.id}
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 12,
                padding: "12px 16px",
                borderTop: i === 0 ? "none" : "1px solid var(--line)",
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{ fontSize: "var(--text-body)", color: "var(--ink)" }}
                >
                  {e.action}
                </div>
                <div
                  className="mono"
                  style={{
                    fontSize: "var(--text-xs)",
                    color: "var(--ink-3)",
                    marginTop: 2,
                  }}
                >
                  {e.actor}
                </div>
              </div>
              <div
                style={{
                  fontSize: "var(--text-xs)",
                  color: "var(--ink-3)",
                  whiteSpace: "nowrap",
                }}
                title={new Date(e.createdAt).toLocaleString()}
              >
                {ago(e.createdAt)}
              </div>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
