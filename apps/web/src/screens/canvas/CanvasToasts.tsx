// Bottom-right canvas toasts, offset left of the persistent desktop dock so they never
// hide under it (extracted verbatim from CanvasPage).
import type { CanvasToast } from "./canvas-types";

export function CanvasToasts({
  toasts,
  offsetRight,
}: {
  toasts: CanvasToast[];
  /** px from the right edge — offset left of the persistent desktop dock only. */
  offsetRight: number;
}) {
  return (
    <div
      style={{
        position: "absolute",
        // Offset left of the persistent desktop dock only; the stacked/floating dock
        // isn't a right column, so toasts stay at the edge there.
        right: offsetRight,
        bottom: 20,
        display: "flex",
        flexDirection: "column",
        gap: 9,
        zIndex: 60,
        alignItems: "flex-end",
        pointerEvents: "none",
      }}
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            border: `1px solid ${
              t.tone === "warn"
                ? "color-mix(in srgb, var(--state-paused) 45%, transparent)"
                : "color-mix(in srgb, var(--state-done) 40%, transparent)"
            }`,
            background: "var(--card-2)",
            borderRadius: 11,
            padding: "11px 15px",
            minWidth: 230,
            boxShadow: "0 18px 40px -18px rgba(0, 0, 0, 0.5)",
            animation: "naaryToastIn .28s cubic-bezier(.2,.9,.3,1.2)",
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              flex: "none",
              background:
                t.tone === "warn" ? "var(--state-paused)" : "var(--state-done)",
              boxShadow: `0 0 9px ${
                t.tone === "warn" ? "var(--state-paused)" : "var(--state-done)"
              }`,
            }}
          />
          <span
            style={{
              fontSize: "var(--text-sm)",
              color: "var(--ink)",
              fontWeight: "var(--weight-medium)",
            }}
          >
            {t.text}
          </span>
          {t.meta && (
            <span
              className="mono"
              style={{
                marginLeft: "auto",
                fontSize: "var(--text-2xs)",
                color: "var(--ink-faint)",
                paddingLeft: 8,
              }}
            >
              {t.meta}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
