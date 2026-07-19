/**
 * Observe › Audit — the tenant's immutable activity log (AuditInterceptor rows)
 * restyled per the design: type-accent icon tile, actor + action line, mono
 * method/path meta, relative time. Filter chips map to the event families the
 * data actually supports (derived from method+path — there is no stored type).
 * The design's env chip is omitted: audit rows carry no environment.
 */
import type { AuditEvent } from "../../../lib/api";
import { Icon, type IconName } from "../../../components";
import {
  type AuditCategory,
  type AuditFilterId,
  AUDIT_FILTERS,
  auditCategory,
  filterAudit,
  relTime,
} from "./observe-model";
import { CardEmpty, panelCard, Seg } from "./ui";

const CATEGORY_UI: Record<AuditCategory, { icon: IconName; accent: string }> = {
  run: { icon: "play", accent: "var(--node-http)" },
  approval: { icon: "approval", accent: "var(--node-approval)" },
  workflow: { icon: "edit", accent: "var(--node-trigger)" },
  security: { icon: "key", accent: "var(--node-mcp)" },
  config: { icon: "settings", accent: "var(--mode-admin)" },
};

export function AuditTab({
  events,
  filter,
  onFilter,
  now,
}: {
  events: AuditEvent[] | null;
  filter: AuditFilterId;
  onFilter: (f: AuditFilterId) => void;
  now: number;
}) {
  const rows = events ? filterAudit(events, filter) : [];

  return (
    <div style={{ animation: "naaryFadeUp .25s ease" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 14,
          flexWrap: "wrap",
        }}
      >
        <div style={{ fontSize: 12.5, color: "var(--ink-2)" }}>
          Immutable log · every recorded change, actor and target
        </div>
        <div style={{ marginLeft: "auto" }}>
          <Seg
            options={AUDIT_FILTERS.map((f) => ({ id: f.id, label: f.label }))}
            value={filter}
            onChange={onFilter}
            small
            ariaLabel="Audit event filter"
          />
        </div>
      </div>

      <div style={{ ...panelCard, overflow: "hidden" }}>
        {events === null && (
          <CardEmpty height={120}>Loading audit log…</CardEmpty>
        )}
        {events !== null && rows.length === 0 && (
          <CardEmpty height={120}>
            {filter === "all"
              ? "No activity yet."
              : "No events of this kind yet."}
          </CardEmpty>
        )}

        {rows.map((e, i) => {
          const cat = auditCategory(e);
          const ui = CATEGORY_UI[cat];
          return (
            <div
              key={e.id}
              className="run-row"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 14,
                padding: "13px 18px",
                borderBottom:
                  i < rows.length - 1 ? "1px solid var(--line)" : undefined,
              }}
            >
              <span
                style={{
                  width: 32,
                  height: 32,
                  flex: "none",
                  borderRadius: 9,
                  border: `1px solid ${ui.accent}`,
                  color: ui.accent,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Icon name={ui.icon} size={15} />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 12.5,
                    color: "var(--ink)",
                    lineHeight: 1.4,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  <strong style={{ fontWeight: "var(--weight-semibold)" }}>
                    {e.actor}
                  </strong>{" "}
                  <span style={{ color: "var(--ink-soft)" }}>{e.action}</span>
                </div>
                <div
                  className="mono"
                  style={{
                    fontSize: "var(--text-xs)",
                    color: "var(--ink-3)",
                    marginTop: 2,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={`${e.method} ${e.path}`}
                >
                  {e.method} {e.path} · {e.statusCode}
                </div>
              </div>
              <span
                className="mono"
                title={new Date(e.createdAt).toLocaleString()}
                style={{
                  fontSize: "var(--text-xs)",
                  color: "var(--ink-3)",
                  width: 60,
                  textAlign: "right",
                  flex: "none",
                }}
              >
                {relTime(e.createdAt, now)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
