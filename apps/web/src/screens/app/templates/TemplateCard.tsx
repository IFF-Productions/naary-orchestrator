import { Icon } from "../../../components";
import type { TemplateView } from "./model";

/**
 * One gallery card: category-accent icon tile, name, description, the node-chain
 * icon strip (derived from the template's real graph), and a footer with the
 * node count, an approval indicator when the graph pauses for a human, and the
 * Preview affordance. The whole card opens the preview.
 */
export function TemplateCard({
  view,
  onPreview,
}: {
  view: TemplateView;
  onPreview: () => void;
}) {
  return (
    <div
      className="tpl-card"
      role="button"
      tabIndex={0}
      aria-label={`Preview ${view.name}`}
      onClick={onPreview}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onPreview();
        }
      }}
      style={{
        border: "1px solid var(--line-mid)",
        background: "var(--card)",
        borderRadius: "var(--radius-xl, 15px)",
        padding: 18,
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        gap: 13,
      }}
    >
      {/* icon tile + identity */}
      <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
        <span
          style={{
            width: 38,
            height: 38,
            flex: "none",
            borderRadius: 10,
            border: `1px solid ${view.category.accent}`,
            color: view.category.accent,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name={view.category.icon} size={19} />
        </span>
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: 14.5,
              fontWeight: "var(--weight-bold)",
              color: "var(--ink)",
            }}
          >
            {view.name}
          </div>
          <div
            className="mono"
            style={{
              fontSize: "var(--text-2xs)",
              color: "var(--ink-3)",
              marginTop: 2,
            }}
          >
            {view.category.name}
          </div>
        </div>
      </div>

      <div
        style={{
          fontSize: "var(--text-sm)",
          color: "var(--ink-2)",
          lineHeight: 1.55,
          minHeight: 38,
          flex: 1,
        }}
      >
        {view.description}
      </div>

      {/* node-chain strip — the template's real nodes in execution order */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          flexWrap: "wrap",
        }}
      >
        {view.chain.map((n, i) => (
          <span
            key={n.id}
            style={{ display: "flex", alignItems: "center", gap: 4 }}
          >
            {i > 0 && (
              <span style={{ color: "var(--ink-3)", fontSize: 11 }}>›</span>
            )}
            <span
              title={n.label}
              style={{
                width: 24,
                height: 24,
                flex: "none",
                borderRadius: 6,
                border: `1px solid ${n.accent}`,
                color: n.accent,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Icon name={n.icon} size={12} />
            </span>
          </span>
        ))}
      </div>

      {/* footer meta */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          borderTop: "1px solid var(--line)",
          paddingTop: 12,
          marginTop: 2,
        }}
      >
        <span
          className="mono"
          style={{
            fontSize: "var(--text-2xs)",
            color: "var(--ink-faint)",
            display: "flex",
            alignItems: "center",
            gap: 5,
          }}
        >
          <Icon name="workflow" size={12} />
          {view.nodeCount} nodes
        </span>
        {view.hasApproval && (
          <span
            style={{
              fontSize: 11,
              color: "var(--node-approval)",
              display: "flex",
              alignItems: "center",
              gap: 5,
            }}
          >
            <Icon name="approval" size={12} strokeWidth={2} />
            approval
          </span>
        )}
        <span
          style={{
            marginLeft: "auto",
            fontSize: "var(--text-xs)",
            color: "var(--brand)",
            fontWeight: "var(--weight-semibold)",
          }}
        >
          Preview →
        </span>
      </div>
    </div>
  );
}
