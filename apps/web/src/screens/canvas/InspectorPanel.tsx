// Inspector chrome: resizable docked panel / phone overlay sheet + drag handle (extracted from CanvasPage).
import { useEffect, useState } from "react";
import { Button } from "../../components";

/** Centered modal overlay for the node/edge editor; backdrop + Esc close it. */
export const clampW = (v: number, min: number, max: number) =>
  Math.max(min, Math.min(max, v));

/** A vertical drag bar for resizing an adjacent side panel. Shows a grip pill so it's
 *  discoverable; `onResize` gets the pointer's clientX during the drag and the caller derives
 *  the new width from the panels-row rect. */
export function ResizeHandle({ onResize }: { onResize: (clientX: number) => void }) {
  const [active, setActive] = useState(false);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panel"
      title="Drag to resize"
      onPointerDown={(e) => {
        e.preventDefault();
        setActive(true);
        const move = (ev: PointerEvent) => onResize(ev.clientX);
        const up = () => {
          setActive(false);
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          document.body.style.cursor = "";
          document.body.style.userSelect = "";
        };
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      }}
      onMouseEnter={() => setActive(true)}
      onMouseLeave={() => setActive(false)}
      style={{
        flex: "none",
        width: 9,
        cursor: "col-resize",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--surface)",
        borderLeft: "1px solid var(--line)",
      }}
    >
      <span
        style={{
          width: 3,
          height: 30,
          borderRadius: 2,
          background: active ? "var(--brand)" : "var(--line-2)",
          transition: "background 120ms",
        }}
      />
    </div>
  );
}

/**
 * Node/edge inspector (replaces the old centered modal). Two responsive layouts:
 *  - Desktop/tablet: a docked, drag-resizable right-hand column inside the canvas flex row; a
 *    ResizeHandle on its left edge changes its width.
 *  - Phone: a full-screen overlay sheet (a 440px docked column can't fit) — rendered as a modal
 *    dialog (role="dialog" + aria-modal), the ResizeHandle is hidden.
 * Esc closes it in both layouts.
 */
export function InspectorPanel({
  title,
  width,
  phone,
  onClose,
  onDelete,
  deleteLabel,
  children,
}: {
  title: string;
  width: number;
  phone?: boolean;
  onClose: () => void;
  onDelete?: () => void;
  deleteLabel?: string;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      // Phone renders as a full-screen modal sheet; expose dialog semantics so screen readers
      // announce it and treat it as modal. Desktop is a docked column (no dialog role).
      role={phone ? "dialog" : undefined}
      aria-modal={phone ? true : undefined}
      aria-label={phone ? title : undefined}
      style={
        phone
          ? {
              // Phone: a full-screen overlay sheet over the canvas (a 440px docked column can't fit).
              position: "fixed",
              inset: 0,
              zIndex: 50,
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
              background: "var(--surface)",
            }
          : {
              width,
              flex: "none",
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
              background: "var(--surface)",
            }
      }
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 16px",
          borderBottom: "1px solid var(--line)",
          flex: "none",
        }}
      >
        <strong style={{ fontSize: "var(--text-md)" }}>{title}</strong>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          style={{
            border: "1px solid var(--line-2)",
            background: "var(--card)",
            color: "var(--ink-2)",
            borderRadius: "var(--radius-sm)",
            cursor: "pointer",
            padding: "2px 9px",
            fontSize: "var(--text-md)",
          }}
        >
          ✕
        </button>
      </div>
      <div style={{ padding: 16, overflowY: "auto", flex: 1, minHeight: 0 }}>
        {children}
      </div>
      {onDelete && (
        <div
          style={{
            padding: "10px 16px",
            borderTop: "1px solid var(--line)",
            display: "flex",
            justifyContent: "flex-end",
            flex: "none",
          }}
        >
          <Button variant="danger" icon="trash" onClick={onDelete}>
            {deleteLabel ?? "Delete"}
          </Button>
        </div>
      )}
    </div>
  );
}
