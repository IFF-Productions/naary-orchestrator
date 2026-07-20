import type { CSSProperties, ReactNode } from "react";
import { Icon, type IconName, Logo } from "../../components";

/**
 * Shared chrome for the BRANDED PUBLIC pages (/f/:formId, /c/:chatId, /approve/:workflowId) —
 * the surfaces outsiders see, rendered OUTSIDE the app shell and outside auth (redesign:
 * "Naary Public Pages" + the Approvals public view). Warm striped backdrop, floating card,
 * ember brand tile, lock footer. Theme comes from the global ThemeProvider (it wraps ALL
 * routes and stamps data-theme on <html>), so dark/light both work here; dark is the default.
 */

/* Page-scoped keyframes + the one thing inline styles can't do: focus border tint. */
const PUBLIC_CSS = `
@keyframes naaryPubDot { 0%, 80%, 100% { opacity: .25; transform: translateY(0); } 40% { opacity: 1; transform: translateY(-2px); } }
@keyframes naaryPubPop { 0% { transform: scale(.4); opacity: 0; } 60% { transform: scale(1.15); } 100% { transform: scale(1); opacity: 1; } }
.naary-public input:focus, .naary-public textarea:focus { border-color: var(--brand) !important; outline: none; }
/* Touch targets ≥44px on phone + tablet (≤1024). Scoped to text controls only —
   NOT buttons — so the reason chips and the 36px chat send button keep their size. */
@media (max-width: 1024px) {
  .naary-public input, .naary-public textarea { min-height: 44px; }
}
`;

/** Full-viewport public frame: warm diagonal-striped wash with the card floating centered. */
export function PublicFrame({ children }: { children: ReactNode }) {
  return (
    <div
      className="naary-public"
      style={{
        minHeight: "100vh",
        background:
          "repeating-linear-gradient(135deg, var(--grad-a), var(--grad-a) 2px, var(--bg) 2px, var(--bg) 13px)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "44px 20px 48px",
        fontFamily: "var(--font-sans)",
        color: "var(--ink)",
      }}
    >
      <style>{PUBLIC_CSS}</style>
      {children}
    </div>
  );
}

/** The floating public card (18px radius, deep soft shadow, fade-up entrance). */
export const PUBLIC_CARD: CSSProperties = {
  background: "var(--panel)",
  border: "1px solid var(--line-mid)",
  borderRadius: 18,
  boxShadow: "0 40px 90px -50px rgba(0,0,0,.7)",
  animation: "naaryFadeUp .3s ease",
};

/** The 5px ember gradient strip across the top of the form card. */
export function EmberBar() {
  return <div style={{ height: 5, background: "var(--brand-gradient)" }} />;
}

/** Design-spec text control: 42px tall, 10px radius, card surface. */
export const PUBLIC_INPUT: CSSProperties = {
  width: "100%",
  height: 42,
  background: "var(--card)",
  border: "1px solid var(--line-2)",
  borderRadius: 10,
  padding: "0 13px",
  fontSize: 13,
  color: "var(--ink)",
  fontFamily: "var(--font-sans)",
  outline: "none",
};

/** Ember-tinted surface pair for user chat bubbles / selected chips (theme-aware via color-mix —
 *  the design's --usr-bg/--usr-bd without new global tokens). */
export const EMBER_TINT_BG = "color-mix(in srgb, var(--brand) 9%, var(--card))";
export const EMBER_TINT_BD =
  "color-mix(in srgb, var(--brand) 28%, var(--line-2))";

/** The ember primary button face (form submit / chat send). */
export const EMBER_BUTTON: CSSProperties = {
  border: "1px solid color-mix(in srgb, var(--brand-deep) 55%, transparent)",
  background: "linear-gradient(180deg, #ff8a4c, #f2622e)",
  color: "var(--brand-ink)",
  boxShadow: "0 4px 14px -5px rgba(242, 98, 46, .6)",
};

/** Small padlock (the design's secure-footer glyph — not in the shared icon set). */
export function LockIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect
        x="5"
        y="11"
        width="14"
        height="9"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path
        d="M8 11V8a4 4 0 0 1 8 0v3"
        stroke="currentColor"
        strokeWidth="1.6"
      />
    </svg>
  );
}

/** "Secure … · powered by Naary" lock footer line. */
export function SecureFooter({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        textAlign: "center",
        fontSize: 11,
        color: "var(--ink-3)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
      }}
    >
      <LockIcon />
      {children}
    </div>
  );
}

/** Brand row for card headers: ember flame tile (optionally + a name when one exists). */
export function BrandRow({ name }: { name?: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        marginBottom: 14,
      }}
    >
      <Logo size={34} />
      {name && (
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-2)" }}>
          {name}
        </span>
      )}
    </div>
  );
}

/** Pop-in result tile (green check / red cross) for success + decided states. */
export function ResultBadge({
  tone,
  icon,
  size = 58,
}: {
  tone: "ok" | "bad";
  icon: IconName;
  size?: number;
}) {
  const fg = tone === "ok" ? "var(--state-done)" : "var(--state-error)";
  const bg = tone === "ok" ? "var(--done-soft)" : "var(--error-soft)";
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: 16,
        background: bg,
        border: `1px solid color-mix(in srgb, ${fg} 45%, transparent)`,
        color: fg,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        animation: "naaryPubPop .35s ease",
      }}
    >
      <Icon name={icon} size={Math.round(size / 2)} strokeWidth={2.4} />
    </div>
  );
}

/** Centered notice body (not-found / invalid-link / already-decided). */
export function PublicNotice({
  icon,
  tone = "idle",
  title,
  body,
}: {
  icon: IconName;
  tone?: "idle" | "ok";
  title: string;
  body: string;
}) {
  const fg = tone === "ok" ? "var(--state-done)" : "var(--ink-2)";
  const bg = tone === "ok" ? "var(--done-soft)" : "var(--card-2)";
  return (
    <div style={{ textAlign: "center", padding: "20px 8px" }}>
      <div
        style={{
          width: 48,
          height: 48,
          borderRadius: 14,
          background: bg,
          border:
            tone === "ok"
              ? "1px solid color-mix(in srgb, var(--state-done) 45%, transparent)"
              : "1px solid var(--line-mid)",
          color: fg,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          marginBottom: 14,
        }}
      >
        <Icon name={icon} size={22} />
      </div>
      <div
        style={{
          fontSize: 15,
          fontWeight: 600,
          color: "var(--ink)",
          marginBottom: 6,
        }}
      >
        {title}
      </div>
      <div
        style={{
          fontSize: 13,
          color: "var(--ink-2)",
          lineHeight: "var(--leading-body)",
        }}
      >
        {body}
      </div>
    </div>
  );
}

/** Inline spinner for busy buttons; `color` should match the button's text color. */
export function ButtonSpinner({ color = "#fff" }: { color?: string }) {
  return (
    <span
      style={{
        width: 15,
        height: 15,
        border: `2px solid color-mix(in srgb, ${color} 35%, transparent)`,
        borderTopColor: color,
        borderRadius: "50%",
        display: "inline-block",
        animation: "naarySpin .7s linear infinite",
      }}
    />
  );
}
