import { useEffect } from "react";
import { Button, Icon } from "../../../components";
import type { TemplateView } from "./model";

/**
 * Template preview: identity header, description, "The flow" (the graph's real
 * nodes in order, each with its type accent + kind label), the derived "What
 * you'll learn" checklist, and the install CTA.
 *
 * The CTA reads "Install template" (not the design's "Install with sample
 * data") — installing saves the template's graph as a workflow in the active
 * workspace/environment; it does NOT seed sample data, and the label must not
 * claim otherwise.
 */
export function PreviewModal({
  view,
  installing,
  onInstall,
  onClose,
}: {
  view: TemplateView;
  installing: boolean;
  onInstall: () => void;
  onClose: () => void;
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
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`${view.name} template preview`}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        background: "rgba(4, 6, 10, 0.62)",
        backdropFilter: "blur(3px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        animation: "tplFadeUp 0.18s ease",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 560,
          maxWidth: "100%",
          maxHeight: "100%",
          overflowY: "auto",
          background: "var(--panel)",
          border: "1px solid var(--line-mid)",
          borderRadius: 18,
          boxShadow: "0 40px 100px -40px rgba(0, 0, 0, 0.8)",
        }}
      >
        {/* header */}
        <div
          style={{
            padding: "22px 24px",
            borderBottom: "1px solid var(--line)",
            display: "flex",
            alignItems: "flex-start",
            gap: 13,
          }}
        >
          <span
            style={{
              width: 44,
              height: 44,
              flex: "none",
              borderRadius: 11,
              border: `1px solid ${view.category.accent}`,
              color: view.category.accent,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Icon name={view.category.icon} size={22} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 17,
                fontWeight: "var(--weight-bold)",
                color: "var(--ink)",
              }}
            >
              {view.name}
            </div>
            <div
              className="mono"
              style={{
                fontSize: 11.5,
                color: "var(--ink-3)",
                marginTop: 2,
              }}
            >
              {view.category.name} · {view.nodeCount} nodes
            </div>
          </div>
          <Button
            variant="secondary"
            iconOnly
            icon="x"
            aria-label="Close preview"
            onClick={onClose}
          />
        </div>

        <div style={{ padding: "20px 24px" }}>
          <div
            style={{
              fontSize: "var(--text-body)",
              color: "var(--ink-soft)",
              lineHeight: 1.6,
              marginBottom: 18,
            }}
          >
            {view.description}
          </div>

          {/* the flow — real graph nodes */}
          <div className="section-label" style={{ marginBottom: 11 }}>
            The flow
          </div>
          <div
            style={{
              border: "1px solid var(--line-mid)",
              background: "var(--card)",
              borderRadius: "var(--radius-lg)",
              padding: 16,
              display: "flex",
              flexDirection: "column",
              gap: 9,
              marginBottom: 20,
            }}
          >
            {view.chain.map((n) => (
              <div
                key={n.id}
                style={{ display: "flex", alignItems: "center", gap: 11 }}
              >
                <span
                  style={{
                    width: 30,
                    height: 30,
                    flex: "none",
                    borderRadius: 8,
                    border: `1px solid ${n.accent}`,
                    color: n.accent,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Icon name={n.icon} size={16} />
                </span>
                <span
                  style={{
                    fontSize: "var(--text-sm)",
                    fontWeight: "var(--weight-medium)",
                    color: "var(--ink)",
                  }}
                >
                  {n.label}
                </span>
                <span
                  className="mono"
                  style={{
                    marginLeft: "auto",
                    fontSize: 10.5,
                    color: "var(--ink-faint)",
                  }}
                >
                  {n.kind}
                </span>
              </div>
            ))}
          </div>

          {/* what you'll learn — derived from the graph */}
          <div className="section-label" style={{ marginBottom: 11 }}>
            What you&apos;ll learn
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
              marginBottom: 22,
            }}
          >
            {view.learn.map((line) => (
              <div
                key={line}
                style={{
                  display: "flex",
                  gap: 9,
                  fontSize: "var(--text-sm)",
                  color: "var(--ink-2)",
                  lineHeight: 1.5,
                }}
              >
                <Icon
                  name="check"
                  size={15}
                  strokeWidth={2.2}
                  style={{ color: "var(--state-done)", marginTop: 1 }}
                />
                <span>{line}</span>
              </div>
            ))}
          </div>

          <div style={{ display: "flex", gap: 11 }}>
            <Button
              variant="primary"
              size="lg"
              block
              loading={installing}
              onClick={onInstall}
              style={{ flex: 1 }}
            >
              Install template
            </Button>
            <Button variant="secondary" size="lg" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
