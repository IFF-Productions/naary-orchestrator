import type { CSSProperties } from "react";
import { Icon, type IconName } from "./Icon";

/* ---------------- SegmentedToggle ---------------- */
export function SegmentedToggle<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="segmented" role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={o.value === value}
          className={o.value === value ? "active" : ""}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ---------------- NodeCard ---------------- */
export type NodeType =
  | "trigger"
  | "agent"
  | "mcp"
  | "router"
  | "approval"
  | "http"
  | "end";

const NODE_ICON: Record<NodeType, IconName> = {
  trigger: "bolt",
  agent: "agent",
  mcp: "mcp",
  router: "router",
  approval: "approval",
  http: "http",
  end: "end",
};

export const NODE_ACCENT: Record<NodeType, string> = {
  trigger: "var(--node-trigger)",
  agent: "var(--node-agent)",
  mcp: "var(--node-mcp)",
  router: "var(--node-router)",
  approval: "var(--node-approval)",
  http: "var(--node-http)",
  end: "var(--node-end)",
};

const NODE_KIND_LABEL: Record<NodeType, string> = {
  trigger: "Trigger",
  agent: "Agent",
  mcp: "MCP Tool",
  router: "Router",
  approval: "Approval",
  http: "HTTP",
  end: "End",
};

export function NodeCard({
  type,
  title,
  output,
  tags,
  selected,
  ports = true,
  style,
}: {
  type: NodeType;
  title: string;
  output?: string;
  tags?: { label: string; accent?: boolean }[];
  selected?: boolean;
  ports?: boolean;
  style?: CSSProperties;
}) {
  const accent = NODE_ACCENT[type];
  return (
    <div
      className={`node${selected ? " selected" : ""}`}
      style={{
        borderColor: accent,
        ["--node-accent" as string]: accent,
        ...style,
      }}
    >
      <div className="accent" style={{ background: accent }} />
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 9,
          padding: "10px 11px 6px",
        }}
      >
        <span
          style={{
            width: 26,
            height: 26,
            borderRadius: 7,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: `color-mix(in srgb, ${accent} 18%, transparent)`,
            color: accent,
            flex: "none",
          }}
        >
          <Icon name={NODE_ICON[type]} size={14} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{title}</div>
          <div
            className="mono"
            style={{
              fontSize: 9,
              letterSpacing: "0.05em",
              color: "var(--ink-3)",
              textTransform: "uppercase",
            }}
          >
            {NODE_KIND_LABEL[type]}
          </div>
        </div>
      </div>
      {output && (
        <div
          className="mono"
          style={{ padding: "0 11px 8px", fontSize: 10, color: "var(--ink-2)" }}
        >
          → {output}
        </div>
      )}
      {tags && tags.length > 0 && (
        <div style={{ display: "flex", gap: 6, padding: "0 11px 11px" }}>
          {tags.map((t, i) => (
            <span
              key={i}
              className="mono"
              style={{
                fontSize: 10,
                fontWeight: 500,
                padding: "2px 7px",
                borderRadius: 5,
                color: t.accent ? accent : "var(--ink-2)",
                border: `1px solid ${
                  t.accent
                    ? `color-mix(in srgb, ${accent} 32%, transparent)`
                    : "var(--line-2)"
                }`,
                background: t.accent
                  ? `color-mix(in srgb, ${accent} 10%, transparent)`
                  : "transparent",
              }}
            >
              {t.label}
            </span>
          ))}
        </div>
      )}
      {ports && (
        <>
          <span className="port in" />
          <span className="port out" style={{ borderColor: accent }} />
        </>
      )}
    </div>
  );
}
