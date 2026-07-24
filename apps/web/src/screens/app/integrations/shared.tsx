// Shared styles, URL helpers, env chip, icon tile, kebab menu and copy button
// for the Integrations screen.
import type { ReactNode } from "react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "../../../components";

export const monoLabel: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-2xs)",
  fontWeight: "var(--weight-semibold)",
  letterSpacing: "var(--tracking-label)",
  color: "var(--ink-3)",
  textTransform: "uppercase",
};

/** The full, invokable webhook URL. The /hooks/:id ingress is reached through the same /api
 *  proxy the app uses (nginx rewrites /api/hooks/… → /hooks/…), so this URL is callable as-is. */
export const webhookUrl = (id: string): string =>
  `${window.location.origin}/api/hooks/${id}`;

/** The public, shareable URL of a hosted form — the `/f/:formId` page served outside auth. */
export const formUrl = (id: string): string =>
  `${window.location.origin}/f/${id}`;

/** The public, shareable URL of a hosted chat — the `/c/:chatId` page served outside auth. */
export const chatUrl = (id: string): string =>
  `${window.location.origin}/c/${id}`;

/** A copy-paste snippet to embed a hosted form/chat on the tenant's own site
 *  (docs/design/EMBEDDED-PUBLIC-PAGES.md, Slice 2). Uses the `embed.js` loader, which injects the
 *  chrome-less `?embed=1` iframe AND auto-resizes it to the content (via postMessage). Same-origin
 *  INSIDE the frame → no CORS; protection stays with Turnstile + rate limits + budget cap. */
export const embedSnippet = (id: string, kind: "form" | "chat"): string => {
  const origin = window.location.origin;
  return `<script src="${origin}/embed.js" async></script>\n<div data-naary-${kind}="${id}"></div>`;
};

/** Small copy-to-clipboard button with brief "Copied ✓" feedback. */
export function UrlCopy({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title="Copy URL"
      className="btn btn-sm btn-secondary"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(url);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard unavailable — the URL is still visible to copy manually */
        }
      }}
      style={{ flex: "none" }}
    >
      {copied ? "Copied ✓" : "Copy"}
    </button>
  );
}

/** A collapsible "Embed" affordance: reveals the copy-paste `<iframe>` snippet for a hosted
 *  form/chat (docs/design/EMBEDDED-PUBLIC-PAGES.md, Slice 1). */
export function EmbedSnippet({
  id,
  kind,
}: {
  id: string;
  kind: "form" | "chat";
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const snippet = embedSnippet(id, kind);
  return (
    <div style={{ marginTop: 8 }}>
      <button
        type="button"
        className="btn btn-sm btn-secondary"
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="template" size={12} /> {open ? "Hide embed" : "Embed"}
      </button>
      {open && (
        <div style={{ marginTop: 8 }}>
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginBottom: 6,
            }}
          >
            Paste this on your site to embed the {kind} — it loads our{" "}
            <code>embed.js</code>, which injects the widget and auto-sizes it.
            Stays protected by your bot &amp; rate limits.
          </div>
          <textarea
            readOnly
            value={snippet}
            onFocus={(e) => e.currentTarget.select()}
            rows={3}
            style={{
              width: "100%",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-2xs)",
              padding: "8px 10px",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--line-2)",
              background: "var(--surface)",
              color: "var(--ink)",
              resize: "vertical",
            }}
          />
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            style={{ marginTop: 6 }}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(snippet);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              } catch {
                /* clipboard unavailable — the snippet is selectable above */
              }
            }}
          >
            {copied ? "Copied ✓" : "Copy embed code"}
          </button>
        </div>
      )}
    </div>
  );
}

/* ===== Redesign shared pieces (env chip · icon tile · kebab menu · card shell) ===== */

const ENV_ACCENT: Record<string, string> = {
  sandbox: "var(--env-sandbox)",
  uat: "var(--env-uat)",
  prod: "var(--env-prod)",
};

/** Accent color for an environment slug (unknown/custom slugs render neutral). */
export const envAccent = (slug: string | null): string =>
  (slug && ENV_ACCENT[slug]) || "var(--ink-faint)";

/**
 * The environment pill every row echoes. All Integrations lists are env-scoped
 * server-side (the X-Environment-Id header), so a row's real binding is the
 * active environment — `slug` comes from useActiveEnvironment(); null renders
 * as the workspace default env.
 */
export function EnvChip({ slug }: { slug: string | null }) {
  const c = envAccent(slug);
  return (
    <span
      className="mono"
      style={{
        fontSize: 10,
        fontWeight: 600,
        color: c,
        border: `1px solid ${c}`,
        borderRadius: "var(--radius-pill)",
        padding: "2px 8px",
        flex: "none",
        lineHeight: 1.4,
        whiteSpace: "nowrap",
      }}
    >
      {slug ?? "default"}
    </span>
  );
}

/** Square outlined icon tile (the design's provider/app type glyph). */
export function IconTile({
  name,
  color,
  size = 36,
}: {
  name: IconName;
  color: string;
  size?: number;
}) {
  return (
    <span
      style={{
        width: size,
        height: size,
        flex: "none",
        borderRadius: "var(--radius-md)",
        border: `1px solid ${color}`,
        color,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Icon name={name} size={Math.round(size / 2)} />
    </span>
  );
}

/** Letter tile for model providers (no brand glyphs in the icon set). */
export function LetterTile({
  letter,
  color,
  size = 36,
}: {
  letter: string;
  color: string;
  size?: number;
}) {
  return (
    <span
      style={{
        width: size,
        height: size,
        flex: "none",
        borderRadius: "var(--radius-md)",
        border: `1px solid ${color}`,
        color,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontWeight: "var(--weight-bold)",
        fontSize: "var(--text-md)",
      }}
    >
      {letter}
    </span>
  );
}

export interface KebabItem {
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

/** Row-level "⋮" actions menu (rotate / edit / remove …). */
export function KebabMenu({ items }: { items: KebabItem[] }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  // The dropdown is PORTALED to <body> with fixed positioning anchored to the button. The row
  // sits inside `cardShell` (overflow:hidden), which would otherwise CLIP an absolutely-positioned
  // menu — the "3-dots menu is hidden/not viewable" bug. Fixed + portal escapes every ancestor's
  // overflow. Right-aligned under the button; re-anchored on scroll/resize.
  const [pos, setPos] = useState<{ top: number; right: number }>({
    top: 0,
    right: 0,
  });
  const place = useCallback(() => {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
  }, []);
  useLayoutEffect(() => {
    if (!open) return;
    place();
    // Capture-phase scroll catches scrolling in ANY ancestor scroll container, not just window.
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, place]);
  return (
    <div style={{ position: "relative", flex: "none" }}>
      <button
        ref={btnRef}
        type="button"
        className="btn btn-sm btn-secondary btn-icon"
        aria-label="Actions"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="more" size={14} />
      </button>
      {open &&
        createPortal(
          <>
            <div
              style={{ position: "fixed", inset: 0, zIndex: 60 }}
              onClick={() => setOpen(false)}
            />
            <div
              className="menu-pop"
              style={{
                position: "fixed",
                top: pos.top,
                right: pos.right,
                zIndex: 61,
                minWidth: 170,
                background: "var(--card)",
                border: "1px solid var(--line-mid)",
                borderRadius: "var(--radius-md)",
                boxShadow: "var(--shadow-card)",
                padding: 4,
              }}
            >
              {items.map((it) => (
                <button
                  key={it.label}
                  type="button"
                  disabled={it.disabled}
                  onClick={() => {
                    setOpen(false);
                    it.onClick();
                  }}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    padding: "7px 10px",
                    border: "none",
                    background: "transparent",
                    borderRadius: "var(--radius-sm)",
                    cursor: it.disabled ? "default" : "pointer",
                    transition: "background .12s ease",
                    fontFamily: "inherit",
                    fontSize: "var(--text-sm)",
                    fontWeight: "var(--weight-medium)",
                    color: it.disabled
                      ? "var(--ink-3)"
                      : it.danger
                        ? "var(--state-error)"
                        : "var(--ink-soft)",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "var(--hover)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "transparent";
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

/** The bordered panel every tab's list/card sits in. */
export const cardShell: React.CSSProperties = {
  background: "var(--card)",
  border: "1px solid var(--line-mid)",
  borderRadius: "var(--radius-xl)",
  boxShadow: "var(--shadow-card)",
  overflow: "hidden",
};

/**
 * A `cardShell` list that scrolls sideways below `minWidth` instead of crushing its
 * rows. Row lists here pack a URL/name (which would ellipsize to nothing) next to
 * fixed-width copy/status/action controls; on a narrow phone that overflows the page
 * body. A min-width scroll container keeps the row intact and the page body still.
 */
export function ScrollList({
  minWidth = 520,
  marginBottom,
  children,
}: {
  minWidth?: number;
  marginBottom?: number;
  children: ReactNode;
}) {
  return (
    <div style={{ ...cardShell, marginBottom }}>
      <div style={{ overflowX: "auto" }}>
        <div style={{ minWidth }}>{children}</div>
      </div>
    </div>
  );
}

/** A tab's intro line under its section title. */
export const introStyle: React.CSSProperties = {
  fontSize: "var(--text-body)",
  color: "var(--ink-2)",
  lineHeight: "var(--leading-snug)",
};

export const fieldStyle: React.CSSProperties = {
  width: "100%",
  padding: "7px 9px",
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--line-2)",
  background: "var(--card)",
  color: "var(--ink)",
  fontSize: "var(--text-body)",
};
export const fieldLabel: React.CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--ink-2)",
  display: "block",
  marginBottom: 6,
};
