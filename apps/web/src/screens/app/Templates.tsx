import { useNavigate } from "react-router-dom";
import { Card, Icon, NODE_ACCENT } from "../../components";
import { templates, type TemplateRow } from "../../lib/mock";

export function Templates() {
  const navigate = useNavigate();

  return (
    <div style={{ padding: "22px 28px 40px" }}>
      {/* header */}
      <div style={{ marginBottom: 18 }}>
        <div
          style={{
            fontSize: 21,
            fontWeight: 700,
            color: "var(--ink)",
            letterSpacing: "-0.01em",
          }}
        >
          Templates
        </div>
        <div style={{ fontSize: 12.5, color: "var(--ink-2)", marginTop: 2 }}>
          Production-ready agent workflows — fork in one click.
        </div>
      </div>

      {/* grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3,1fr)",
          gap: 14,
        }}
      >
        {templates.map((t) => (
          <TemplateCard
            key={t.name}
            t={t}
            onUse={() => navigate("/app/canvas")}
          />
        ))}
      </div>
    </div>
  );
}

function TemplateCard({ t, onUse }: { t: TemplateRow; onUse: () => void }) {
  const accent = NODE_ACCENT[t.accent];
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
            borderRadius: 10,
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
            fontSize: 10,
            color: "var(--ink-3)",
            background: "var(--surface)",
            border: "1px solid var(--line)",
            padding: "2px 7px",
            borderRadius: 5,
          }}
        >
          {t.nodes} nodes
        </span>
      </div>

      <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)" }}>
        {t.name}
      </div>
      <div
        style={{
          fontSize: 12,
          color: "var(--ink-2)",
          marginTop: 5,
          lineHeight: 1.5,
          flex: 1,
        }}
      >
        {t.desc}
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
          style={{ fontSize: 10.5, color: "var(--ink-3)" }}
        >
          {t.tag}
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
            fontSize: 11.5,
            fontWeight: 600,
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
