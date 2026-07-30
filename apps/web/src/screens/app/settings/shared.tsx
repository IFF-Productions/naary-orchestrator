// Shared primitives for the redesigned Settings screen sections (redesign:
// _design-reference/redesign/Naary Settings.dc.html). Sections render inside a
// bordered panel with hover rows; environments are echoed as color-coded chips.
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Button } from "../../../components";
import type { Environment } from "../../../lib/api";
import {
  type FixedPlacement,
  naturalSize,
  placeFixedPopover,
} from "../../../lib/popoverPlacement";
import { envAccent } from "../../../workspace/EnvironmentSwitcher";

/* ---------------- Row action menu ---------------- */

/** One item in a {@link RowMenu}. */
export interface RowMenuItem {
  label: string;
  onClick: () => void;
  /** Render in the destructive color (e.g. Delete). */
  danger?: boolean;
}

/**
 * Kebab (⋮) action menu for a settings row. The menu is rendered in a PORTAL with fixed positioning
 * anchored to the trigger, because the settings `panelStyle` uses `overflow: hidden` (for its rounded
 * corners) which otherwise CLIPS an in-flow absolutely-positioned menu — the bug where "Update value…"
 * was cut off inside the row on mobile. Closes on outside-click, Escape, or scroll/resize (so it can't
 * float detached from its row).
 *
 * ## Placement is clamped to the viewport, not just derived from the anchor (#511)
 *
 * `top: anchor.bottom + 4` with no clamp put the menu off the BOTTOM of a phone screen for any row
 * near the fold — and a settings list is as long as the workspace's secret count. Measured at
 * 390×844 on a 16-row list: menu bottom **885 / 844**, "Delete" **36px below the fold**. `fixed`
 * does not move with page scroll, and the listener below closes on scroll, so the one gesture that
 * would bring it into view destroyed it instead: the row's actions were unreachable, and the kebab
 * looked broken rather than obstructed.
 *
 * `placeFixedPopover` now flips the menu above the row when there is no room below and clamps to
 * every edge. It needs the menu's real height, so placement happens in a layout effect AFTER the
 * first paint (the old code computed it inside `toggle()`, before the menu existed — where a 2-item
 * and a 5-item menu are indistinguishable). The pre-placement frame is hidden with
 * `visibility: hidden` so nothing is ever painted at the unclamped position.
 */
export function RowMenu({
  label,
  items,
  disabled,
}: {
  label: string;
  items: RowMenuItem[];
  disabled?: boolean;
}) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<FixedPlacement | null>(null);

  useEffect(() => {
    if (!open) return;
    /**
     * Scrolling INSIDE the menu must not close it. The listener is on `window` in capture phase, so
     * it sees scroll from every descendant — and now that a tall menu gets `maxHeight` +
     * `overflow-y: auto`, scrolling its own list would otherwise dismiss it. Same origin-guard shape
     * as the keydown fix in #936: react only to events this element did not produce.
     */
    const close = (e: Event) => {
      if (
        e.type === "scroll" &&
        e.target instanceof Node &&
        menuRef.current?.contains(e.target)
      )
        return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    // Capture scroll from any ancestor; close so the fixed menu can't drift off its row.
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Measure the RENDERED menu, then clamp. Runs before the browser paints, so the unplaced frame
  // (still `visibility: hidden`) is never visible.
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current?.getBoundingClientRect();
    const menu = menuRef.current;
    if (!anchor || !menu) return;
    setPos(
      placeFixedPopover(anchor, naturalSize(menu), {
        width: window.innerWidth,
        height: window.innerHeight,
      }),
    );
  }, [open, items.length]);

  function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setPos(null);
    setOpen(true);
  }

  return (
    <div ref={anchorRef} style={{ position: "relative", flex: "none" }}>
      <Button
        variant="ghost"
        size="sm"
        icon="more"
        iconOnly
        aria-label={label}
        disabled={disabled}
        onClick={toggle}
      />
      {open &&
        createPortal(
          <>
            {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
            <div
              style={{ position: "fixed", inset: 0, zIndex: 40 }}
              onClick={() => setOpen(false)}
            />
            <div
              ref={menuRef}
              className="menu-pop"
              style={{
                position: "fixed",
                top: pos?.top ?? 0,
                left: pos?.left ?? 0,
                visibility: pos ? "visible" : "hidden",
                maxHeight: pos?.maxHeight,
                maxWidth: pos?.maxWidth,
                overflowY: "auto",
                zIndex: 41,
                minWidth: 150,
                background: "var(--card)",
                border: "1px solid var(--line-2)",
                borderRadius: "var(--radius-md)",
                boxShadow: "var(--shadow-card)",
                padding: 4,
              }}
            >
              {items.map((it) => (
                <button
                  key={it.label}
                  type="button"
                  className="naary-set-menu-item"
                  style={
                    it.danger ? { color: "var(--state-error)" } : undefined
                  }
                  onClick={() => {
                    setOpen(false);
                    it.onClick();
                  }}
                >
                  {it.label}
                </button>
              ))}
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}

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

/** Slack = channel hash; Teams = the two-person mark; Email = an envelope. Enough to
 *  tell rows apart. */
export function ChannelGlyph({
  type,
  size = 15,
  style,
}: {
  type: "slack" | "teams" | "email";
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
  if (type === "email")
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        style={{ flex: "none", ...style }}
        aria-hidden
      >
        <rect
          x="3.5"
          y="5.5"
          width="17"
          height="13"
          rx="2"
          stroke="currentColor"
          strokeWidth="1.7"
        />
        <path
          d="m4.5 7.5 7.5 6 7.5-6"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
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
