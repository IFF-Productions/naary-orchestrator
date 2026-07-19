/**
 * "Recent activity" — the latest audit-log events (the same source the
 * Activity screen renders: GET /tenants/:id/audit). Tone dot derives from the
 * recorded outcome: HTTP >= 400 → error red, approval decisions → done green,
 * other mutations → ember, everything else → grey.
 */
import { Link } from "react-router-dom";
import type { AuditEvent } from "../../../lib/api";
import { ago } from "./overview-model";

function toneDot(e: AuditEvent): string {
  if (e.statusCode >= 400) return "var(--state-error)";
  if (/approv/i.test(e.action) || /\/approve/.test(e.path))
    return "var(--state-done)";
  if (e.method !== "GET") return "var(--brand)";
  return "var(--ink-faint)";
}

export function ActivityCard({
  events,
  loading,
}: {
  /** null = the audit feed couldn't load (card degrades honestly). */
  events: AuditEvent[] | null;
  loading: boolean;
  max?: number;
}) {
  const shown = (events ?? []).slice(0, 5);
  return (
    <div
      style={{
        border: "1px solid var(--line-mid)",
        background: "var(--card)",
        borderRadius: 14,
        padding: "16px 18px",
        flex: 1,
        boxShadow: "var(--shadow-card)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          marginBottom: 13,
        }}
      >
        <div
          style={{
            fontSize: "var(--text-body)",
            fontWeight: "var(--weight-bold)",
            color: "var(--ink)",
          }}
        >
          Recent activity
        </div>
        <Link
          to="/app/activity"
          style={{
            marginLeft: "auto",
            fontSize: "var(--text-sm)",
            color: "var(--brand)",
            fontWeight: "var(--weight-semibold)",
            textDecoration: "none",
          }}
        >
          All activity →
        </Link>
      </div>

      {shown.length === 0 ? (
        <div
          style={{
            fontSize: "var(--text-body)",
            color: "var(--ink-3)",
            padding: "8px 0",
          }}
        >
          {loading ? "Loading…" : events === null ? "—" : "No activity yet."}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {shown.map((e) => (
            <div
              key={e.id}
              style={{ display: "flex", alignItems: "flex-start", gap: 10 }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  flex: "none",
                  marginTop: 5,
                  background: toneDot(e),
                }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: "var(--text-sm)",
                    color: "var(--ink-soft)",
                    lineHeight: 1.4,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    display: "-webkit-box",
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: "vertical",
                  }}
                >
                  {e.action}
                </div>
                <div
                  className="mono"
                  style={{
                    fontSize: "var(--text-2xs)",
                    color: "var(--ink-3)",
                    marginTop: 1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {e.actor} · {ago(e.createdAt)}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
