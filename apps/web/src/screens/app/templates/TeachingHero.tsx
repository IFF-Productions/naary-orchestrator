import { Button, Icon } from "../../../components";
import { BEATS } from "./model";

/**
 * The teaching hero: the four-beat loop (Trigger → Run → Approval → Done) with
 * node-accent chips, plus the two entry CTAs. "Generate with AI" goes to the
 * closest real AI-generation entry point (the canvas's Build-with-AI panel in
 * Builder, the describe-it flow in Simple); "Start blank" opens a blank canvas.
 */
export function TeachingHero({
  onGenerate,
  onStartBlank,
}: {
  onGenerate: () => void;
  onStartBlank: () => void;
}) {
  return (
    <div
      style={{
        position: "relative",
        padding: "36px 28px 30px",
        borderBottom: "1px solid var(--line)",
        background:
          "radial-gradient(120% 90% at 85% -10%, var(--grad-a), transparent 60%)",
        overflow: "hidden",
      }}
    >
      {/* canvas-dot wash behind the copy */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage:
            "radial-gradient(circle, var(--grid) 1px, transparent 1px)",
          backgroundSize: "26px 26px",
          opacity: 0.4,
        }}
      />
      <div style={{ position: "relative", maxWidth: 1200 }}>
        <div
          className="mono"
          style={{
            fontSize: "var(--text-xs)",
            color: "var(--brand)",
            letterSpacing: "0.06em",
            marginBottom: 12,
          }}
        >
          GET STARTED — LEARN THE LOOP IN ONE RUN
        </div>
        <div
          style={{
            fontSize: 32,
            fontWeight: "var(--weight-bold)",
            color: "var(--ink)",
            letterSpacing: "var(--tracking-tight)",
            lineHeight: 1.12,
            maxWidth: 640,
          }}
        >
          Every Naary workflow is the same four beats.
        </div>
        <div
          style={{
            fontSize: 14,
            color: "var(--ink-2)",
            marginTop: 10,
            maxWidth: 560,
            lineHeight: 1.6,
          }}
        >
          Pick a template to see it end-to-end, or start blank. Every one below
          installs pre-wired.
        </div>

        {/* the four beat chips */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            marginTop: 24,
            flexWrap: "wrap",
          }}
        >
          {BEATS.map((b, i) => (
            <div
              key={b.name}
              style={{ display: "flex", alignItems: "center", gap: 6 }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  border: "1px solid var(--line-mid)",
                  background: "var(--card)",
                  borderRadius: "var(--radius-lg)",
                  padding: "11px 15px",
                }}
              >
                <span
                  style={{
                    width: 30,
                    height: 30,
                    flex: "none",
                    borderRadius: 8,
                    border: `1px solid ${b.accent}`,
                    color: b.accent,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Icon name={b.icon} size={16} />
                </span>
                <div>
                  <div
                    style={{
                      fontSize: "var(--text-body)",
                      fontWeight: "var(--weight-semibold)",
                      color: "var(--ink)",
                    }}
                  >
                    {b.name}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: "var(--ink-faint)",
                      marginTop: 1,
                    }}
                  >
                    {b.sub}
                  </div>
                </div>
              </div>
              {i < BEATS.length - 1 && (
                <Icon
                  name="arrow-right"
                  size={16}
                  strokeWidth={1.8}
                  style={{ color: "var(--ink-3)" }}
                />
              )}
            </div>
          ))}
        </div>

        <div
          style={{ display: "flex", gap: 11, marginTop: 26, flexWrap: "wrap" }}
        >
          <Button variant="primary" size="lg" icon="agent" onClick={onGenerate}>
            Generate with AI
          </Button>
          <Button
            variant="secondary"
            size="lg"
            icon="plus"
            onClick={onStartBlank}
          >
            Start blank
          </Button>
        </div>
      </div>
    </div>
  );
}
