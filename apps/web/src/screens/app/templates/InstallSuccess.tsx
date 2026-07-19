import { Button, Icon } from "../../../components";
import { deriveInstallSteps, type TemplateView } from "./model";

/**
 * Post-install view: green pop check, "<name> installed", and the staggered
 * TRIGGER → RUN → (APPROVAL) → DONE walkthrough derived from the installed
 * template's real graph — the APPROVAL beat collapses when the graph has no
 * approval node. "Open in canvas" opens the workflow the install actually
 * created (the saveGraph result's workflowKey).
 */
export function InstallSuccess({
  view,
  workflowKey,
  openLabel = "Open in canvas",
  onOpen,
  onBack,
}: {
  view: TemplateView;
  workflowKey: string;
  /** CTA label — the parent points it at the canvas (Builder) or the automation (Simple). */
  openLabel?: string;
  onOpen: () => void;
  onBack: () => void;
}) {
  const steps = deriveInstallSteps(view);
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "center",
        padding: "44px 24px 60px",
        background:
          "radial-gradient(120% 80% at 50% -10%, var(--grad-a), transparent 55%)",
      }}
    >
      <div style={{ width: 720, maxWidth: "100%" }}>
        <div
          style={{ textAlign: "center", animation: "naaryFadeUp 0.3s ease" }}
        >
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 15,
              background: "var(--done-soft)",
              border:
                "1px solid color-mix(in srgb, var(--state-done) 45%, transparent)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              animation: "tplPop 0.35s ease",
            }}
          >
            <Icon
              name="check"
              size={28}
              strokeWidth={2.4}
              style={{ color: "var(--state-done)" }}
            />
          </div>
          <div
            style={{
              fontSize: 24,
              fontWeight: "var(--weight-bold)",
              color: "var(--ink)",
              marginTop: 16,
              letterSpacing: "var(--tracking-tight)",
            }}
          >
            {view.name} installed
          </div>
          <div
            style={{
              fontSize: 13.5,
              color: "var(--ink-2)",
              marginTop: 8,
              maxWidth: 460,
              marginLeft: "auto",
              marginRight: "auto",
              lineHeight: 1.6,
            }}
          >
            It&apos;s saved to your workspace as{" "}
            <span className="mono" style={{ color: "var(--ink)" }}>
              {workflowKey}
            </span>
            . Here&apos;s exactly what happens when it runs — the loop every
            workflow follows.
          </div>
        </div>

        <div
          style={{
            marginTop: 32,
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          {steps.map((st, i) => (
            <div
              key={st.tag}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 15,
                border: "1px solid var(--line-mid)",
                background: "var(--panel)",
                borderRadius: 14,
                padding: "16px 18px",
                animation: "tplStepIn 0.4s ease both",
                animationDelay: `${i * 90}ms`,
              }}
            >
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 6,
                  flex: "none",
                }}
              >
                <span
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 11,
                    border: `1px solid ${st.accent}`,
                    color: st.accent,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Icon name={st.icon} size={20} />
                </span>
                {i < steps.length - 1 && (
                  <span
                    style={{
                      width: 2,
                      height: 16,
                      background: "var(--line-2)",
                      borderRadius: 2,
                    }}
                  />
                )}
              </div>
              <div style={{ flex: 1, paddingTop: 3, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                  <span
                    className="mono"
                    style={{
                      fontSize: 10,
                      fontWeight: "var(--weight-bold)",
                      letterSpacing: "0.08em",
                      color: st.accent,
                    }}
                  >
                    {st.tag}
                  </span>
                  <span
                    style={{
                      fontSize: 14,
                      fontWeight: "var(--weight-bold)",
                      color: "var(--ink)",
                    }}
                  >
                    {st.title}
                  </span>
                </div>
                <div
                  style={{
                    fontSize: "var(--text-sm)",
                    color: "var(--ink-2)",
                    marginTop: 4,
                    lineHeight: 1.55,
                  }}
                >
                  {st.body}
                </div>
              </div>
            </div>
          ))}
        </div>

        <div
          style={{
            display: "flex",
            gap: 11,
            justifyContent: "center",
            marginTop: 28,
            flexWrap: "wrap",
          }}
        >
          <Button variant="primary" size="lg" icon="expand" onClick={onOpen}>
            {openLabel}
          </Button>
          <Button variant="secondary" size="lg" onClick={onBack}>
            Back to templates
          </Button>
        </div>
      </div>
    </div>
  );
}
