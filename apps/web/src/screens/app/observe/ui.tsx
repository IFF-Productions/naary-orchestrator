/**
 * Small presentational primitives shared by the Observe tabs — the design's
 * segmented pill control and the 14px-radius panel card.
 */
import type { CSSProperties, ReactNode } from "react";

export const panelCard: CSSProperties = {
  border: "1px solid var(--line-mid)",
  background: "var(--panel)",
  borderRadius: 14,
  boxShadow: "var(--shadow-card)",
};

/** Design's segmented control: --bg well, --line-2 border, active pill = --card. */
export function Seg<T extends string>({
  options,
  value,
  onChange,
  small,
  ariaLabel,
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
  small?: boolean;
  ariaLabel: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      style={{
        display: "inline-flex",
        gap: 3,
        background: "var(--bg)",
        border: "1px solid var(--line-2)",
        borderRadius: 9,
        padding: 3,
      }}
    >
      {options.map((o) => {
        const active = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            onClick={() => onChange(o.id)}
            aria-pressed={active}
            style={{
              border: "none",
              fontFamily: "inherit",
              fontSize: small ? 11 : 12,
              padding: small ? "4px 11px" : "5px 13px",
              borderRadius: 6,
              cursor: "pointer",
              fontWeight:
                "var(--weight-semibold)" as CSSProperties["fontWeight"],
              color: active ? "var(--ink)" : "var(--ink-faint)",
              background: active ? "var(--card)" : "transparent",
              transition: "background .12s, color .12s",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** 13px/700 card heading, matching the design's card titles. */
export function CardTitle({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        fontSize: "var(--text-body)",
        fontWeight: "var(--weight-bold)",
        color: "var(--ink)",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** Centered faint empty/loading text inside a card body. */
export function CardEmpty({
  height,
  children,
}: {
  height: number;
  children: ReactNode;
}) {
  return (
    <div style={{ height, display: "grid", placeItems: "center" }}>
      <span style={{ fontSize: "var(--text-sm)", color: "var(--ink-3)" }}>
        {children}
      </span>
    </div>
  );
}
