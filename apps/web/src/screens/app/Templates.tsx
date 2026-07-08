import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, Icon, NODE_ACCENT, type NodeType } from "../../components";
import { api, type TemplateSummary, UnauthorizedError } from "../../lib/api";

// The API payload carries no presentation accent, so cycle the node palette by
// index (mirrors the old mock) to keep each card visually distinct.
const ACCENTS: NodeType[] = [
  "trigger",
  "agent",
  "mcp",
  "router",
  "http",
  "approval",
];

export function Templates() {
  const navigate = useNavigate();
  const [templates, setTemplates] = useState<TemplateSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .listTemplates()
      .then((rows) => {
        if (!alive) return;
        setTemplates(rows);
        setError(null);
      })
      .catch((e) => {
        if (!alive) return;
        setError(
          e instanceof UnauthorizedError
            ? "Not authenticated — sign in (or set an API token) to see templates."
            : "Could not reach the control plane (apps/api on :3000).",
        );
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div style={{ padding: "22px 28px 40px" }}>
      {/* header */}
      <div style={{ marginBottom: 18 }}>
        <div
          style={{
            fontSize: "var(--text-title)",
            fontWeight: "var(--weight-bold)",
            color: "var(--ink)",
            letterSpacing: "var(--tracking-tight)",
          }}
        >
          Templates
        </div>
        <div
          style={{
            fontSize: "var(--text-body)",
            color: "var(--ink-2)",
            marginTop: 4,
          }}
        >
          Production-ready agent workflows — fork in one click.
        </div>
      </div>

      {error && (
        <div
          style={{
            marginBottom: 14,
            padding: "9px 12px",
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

      {templates === null && !error && (
        <div style={{ fontSize: "var(--text-body)", color: "var(--ink-3)" }}>
          Loading…
        </div>
      )}

      {templates?.length === 0 && (
        <div style={{ fontSize: "var(--text-body)", color: "var(--ink-3)" }}>
          No templates available.
        </div>
      )}

      {/* grid */}
      {templates && templates.length > 0 && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
            gap: 14,
          }}
        >
          {templates.map((t, i) => (
            <TemplateCard
              key={t.key}
              t={t}
              accent={ACCENTS[i % ACCENTS.length]}
              onUse={() =>
                navigate(`/app/canvas?template=${encodeURIComponent(t.key)}`)
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TemplateCard({
  t,
  accent: accentType,
  onUse,
}: {
  t: TemplateSummary;
  accent: NodeType;
  onUse: () => void;
}) {
  const accent = NODE_ACCENT[accentType];
  return (
    <Card
      onClick={onUse}
      style={{
        padding: 17,
        display: "flex",
        flexDirection: "column",
        cursor: "pointer",
      }}
    >
      {/* icon + node count */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 12,
        }}
      >
        <span
          style={{
            width: 38,
            height: 38,
            borderRadius: "var(--radius-md)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flex: "none",
            background: `color-mix(in srgb, ${accent} 16%, transparent)`,
            color: accent,
          }}
        >
          <Icon name="workflow" size={19} />
        </span>
        <span
          className="mono"
          style={{
            fontSize: "var(--text-2xs)",
            color: "var(--ink-3)",
            background: "var(--surface)",
            border: "1px solid var(--line)",
            padding: "2px 7px",
            borderRadius: "var(--radius-xs)",
          }}
        >
          {t.nodeCount} nodes
        </span>
      </div>

      <div
        style={{
          fontSize: "var(--text-md)",
          fontWeight: "var(--weight-semibold)",
          color: "var(--ink)",
        }}
      >
        {t.name}
      </div>
      <div
        style={{
          fontSize: "var(--text-sm)",
          color: "var(--ink-2)",
          marginTop: 5,
          lineHeight: 1.5,
          flex: 1,
        }}
      >
        {t.description}
      </div>

      {/* footer */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginTop: 14,
        }}
      >
        <span
          className="mono"
          style={{ fontSize: "var(--text-2xs)", color: "var(--ink-3)" }}
        >
          {t.key}
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onUse();
          }}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            border: "none",
            background: "transparent",
            cursor: "pointer",
            padding: 0,
            fontSize: "var(--text-xs)",
            fontWeight: "var(--weight-semibold)",
            color: "var(--brand)",
          }}
        >
          Use template
          <Icon name="chevron-right" size={13} strokeWidth={2} />
        </button>
      </div>
    </Card>
  );
}
