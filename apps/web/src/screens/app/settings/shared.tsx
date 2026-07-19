// Shared primitives for the redesigned Settings screen sections (redesign:
// _design-reference/redesign/Naary Settings.dc.html). Sections render inside a
// bordered panel with hover rows; environments are echoed as color-coded chips.
import type { CSSProperties, ReactNode } from "react";
import type { Environment } from "../../../lib/api";
import { envAccent } from "../../../workspace/EnvironmentSwitcher";

/* ---------------- Section chrome ---------------- */

/** 20px/700 section title with an optional right-aligned action (the ember CTA). */
export function SectionHeader({
  title,
  action,
}: {
  title: string;
  action?: ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "space-between",
        gap: 12,
        marginBottom: 6,
        flexWrap: "wrap",
      }}
    >
      <div
        style={{
          fontSize: 20,
          fontWeight: "var(--weight-bold)",
          letterSpacing: "-.01em",
          color: "var(--ink)",
        }}
      >
        {title}
      </div>
      {action}
    </div>
  );
}

/** The intro line under a section title. */
export function SectionIntro({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: 12.5,
        color: "var(--ink-2)",
        marginBottom: 18,
        lineHeight: 1.5,
        maxWidth: 640,
      }}
    >
      {children}
    </div>
  );
}

/** The bordered rounded container the design uses for row lists / matrices. */
export const panelStyle: CSSProperties = {
  border: "1px solid var(--line-mid)",
  background: "var(--panel)",
  borderRadius: 14,
  overflow: "hidden",
};

/** Inline error line (auth / validation / network) shown inside a section. */
export function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: "var(--text-sm)",
        color: "var(--state-error)",
        margin: "0 0 12px",
      }}
    >
      {children}
    </div>
  );
}

/* ---------------- Environment chip ---------------- */

/** Color-coded env pill (mono, outlined) — same accent convention as the shell. */
export function EnvChip({
  env,
  onClick,
  selected,
}: {
  env: Pick<Environment, "slug" | "name">;
  /** When set the chip is a picker button; `selected` fills it with the env tint. */
  onClick?: () => void;
  selected?: boolean;
}) {
  const accent = envAccent(env);
  const style: CSSProperties = {
    fontSize: 10,
    fontWeight: "var(--weight-semibold)",
    fontFamily: "var(--font-mono)",
    color: accent,
    border: `1px solid ${accent}`,
    borderRadius: 20,
    padding: "2px 8px",
    flex: "none",
    background:
      onClick && selected
        ? `color-mix(in srgb, ${accent} 16%, transparent)`
        : "transparent",
    opacity: onClick && !selected ? 0.55 : 1,
    cursor: onClick ? "pointer" : undefined,
    lineHeight: 1.5,
  };
  if (!onClick) return <span style={style}>{env.name}</span>;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      style={style}
    >
      {env.name}
    </button>
  );
}

/* ---------------- Small glyphs (files-local; the shared Icon set stays untouched) ---------------- */

function Glyph({
  d,
  size = 15,
  strokeWidth = 1.7,
  style,
}: {
  d: string;
  size?: number;
  strokeWidth?: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      style={{ flex: "none", ...style }}
      aria-hidden
    >
      <path
        d={d}
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Padlock (secrets rows). */
export function LockGlyph({ style }: { style?: CSSProperties }) {
  return (
    <svg
      width={15}
      height={15}
      viewBox="0 0 24 24"
      fill="none"
      style={{ flex: "none", ...style }}
      aria-hidden
    >
      <rect
        x="5"
        y="10"
        width="14"
        height="10"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <path
        d="M8 10V7.5a4 4 0 0 1 8 0V10"
        stroke="currentColor"
        strokeWidth="1.7"
      />
    </svg>
  );
}

/** Slack = channel hash; Teams = the two-person mark. Enough to tell rows apart. */
export function ChannelGlyph({
  type,
  size = 15,
  style,
}: {
  type: "slack" | "teams";
  size?: number;
  style?: CSSProperties;
}) {
  if (type === "slack")
    return (
      <Glyph
        d="M9.5 4 8 20M16 4l-1.5 16M5 9h15M4 15h15"
        size={size}
        style={style}
      />
    );
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      style={{ flex: "none", ...style }}
      aria-hidden
    >
      <circle cx="9" cy="8" r="3" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M3.5 19a5.5 5.5 0 0 1 11 0M16 6a3 3 0 0 1 0 6M17 14.5a5.5 5.5 0 0 1 3.5 4.5"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** The teal "decide-in-place" pill — real feature: approval messages carry
 *  Approve / Reject buttons so approvers act without leaving Slack/Teams. */
export function DecideInPlaceChip() {
  return (
    <span
      title="Approval messages carry Approve / Reject buttons — decide without leaving the channel"
      style={{
        fontSize: 10,
        fontWeight: "var(--weight-semibold)",
        fontFamily: "var(--font-mono)",
        color: "var(--node-approval)",
        border: "1px solid var(--node-approval)",
        borderRadius: 20,
        padding: "3px 9px",
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        flex: "none",
        lineHeight: 1.4,
      }}
    >
      <svg width={11} height={11} viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
          d="M5 12.5 10 17.5 19.5 7"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      decide-in-place
    </span>
  );
}
