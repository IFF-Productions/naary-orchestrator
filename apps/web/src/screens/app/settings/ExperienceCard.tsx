// Experience mode card (Builder vs Simple) for the Settings screen.
import { Card } from "../../../components";
import { type Mode, useMode } from "../../../mode";

export function ExperienceCard() {
  const { mode, setMode } = useMode();
  return (
    <>
      {/* Experience mode — Builder (full canvas) vs Simple (describe + step list). Per-user. */}
      <Card style={{ padding: 18, marginBottom: 16 }}>
        <div
          style={{
            fontSize: "var(--text-md)",
            fontWeight: "var(--weight-semibold)",
            color: "var(--ink)",
            marginBottom: 4,
          }}
        >
          Experience
        </div>
        <div
          style={{
            fontSize: "var(--text-sm)",
            color: "var(--ink-2)",
            marginBottom: 12,
          }}
        >
          Choose how you build automations. This is your personal preference.
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {[
            {
              m: "simple" as Mode,
              title: "Simple",
              blurb: "Describe it in English, review friendly steps.",
            },
            {
              m: "builder" as Mode,
              title: "Builder",
              blurb: "The full visual canvas + advanced features.",
            },
          ].map((o) => {
            const active = mode === o.m;
            return (
              <button
                key={o.m}
                type="button"
                onClick={() => setMode(o.m)}
                style={{
                  all: "unset",
                  cursor: "pointer",
                  flex: "1 1 220px",
                  padding: "12px 14px",
                  borderRadius: "var(--radius-md)",
                  border: `1px solid ${active ? "var(--brand)" : "var(--line-2)"}`,
                  background: active ? "var(--brand-soft)" : "var(--card-2)",
                }}
              >
                <div
                  style={{
                    fontSize: "var(--text-body)",
                    fontWeight: "var(--weight-semibold)",
                    color: active ? "var(--brand)" : "var(--ink)",
                  }}
                >
                  {o.title}
                  {active ? " ✓" : ""}
                </div>
                <div
                  style={{
                    fontSize: "var(--text-xs)",
                    color: "var(--ink-3)",
                    marginTop: 2,
                  }}
                >
                  {o.blurb}
                </div>
              </button>
            );
          })}
        </div>
      </Card>
    </>
  );
}
