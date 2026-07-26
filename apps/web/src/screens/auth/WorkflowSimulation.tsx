/**
 * LEFT panel of the auth screen: the live, browser-only workflow simulation.
 * Purely presentational — every node/edge/status is derived (via simulation.ts)
 * from the real form signals the AuthScreen passes down; nothing here calls a
 * backend. Dark-only by design (the comp hardcodes the dark palette).
 */
import type { ReactNode } from "react";
import "./auth.css";
import {
  STATE_WORD,
  type NodeStatus,
  type SimulationSignals,
  cardVisual,
  edgeVisual,
  BOT_GATE_LABEL,
  botGateStatus,
  nodeLabels,
  nodeStatuses,
  runIdChip,
  statusBar,
} from "./simulation";

/** Design-comp geometry: nodes on a 560×730 wrap, edges in a 560×720 viewBox. */
const NODE_POS: ReadonlyArray<{ left: number; top: number }> = [
  { left: 60, top: 40 },
  { left: 250, top: 175 },
  { left: 70, top: 320 },
  { left: 260, top: 470 },
  { left: 90, top: 630 },
];

const EDGE_PATHS: readonly string[] = [
  "M173 114 C 173 150, 363 139, 363 175",
  "M363 249 C 363 290, 183 279, 183 320",
  "M183 394 C 183 435, 373 429, 373 470",
  "M373 544 C 373 590, 203 584, 203 630",
];

const NODE_ICONS: readonly ReactNode[] = [
  // trigger bolt
  <svg key="n1" width="18" height="18" viewBox="0 0 24 24" fill="none">
    <path d="M13 2 4 14h6l-1 8 9-12h-6z" fill="currentColor" />
  </svg>,
  // identity
  <svg key="n2" width="18" height="18" viewBox="0 0 24 24" fill="none">
    <circle cx="12" cy="8" r="3.4" stroke="currentColor" strokeWidth="1.8" />
    <path
      d="M5 20c0-3.3 3.1-5 7-5s7 1.7 7 5"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
    />
  </svg>,
  // credential lock
  <svg key="n3" width="18" height="18" viewBox="0 0 24 24" fill="none">
    <rect
      x="5"
      y="10"
      width="14"
      height="10"
      rx="2.2"
      stroke="currentColor"
      strokeWidth="1.8"
    />
    <path
      d="M8 10V7.5a4 4 0 0 1 8 0V10"
      stroke="currentColor"
      strokeWidth="1.8"
    />
  </svg>,
  // approval-gate pause bars
  <svg key="n4" width="18" height="18" viewBox="0 0 24 24" fill="none">
    <rect x="7" y="6" width="3.4" height="12" rx="1" fill="currentColor" />
    <rect x="13.6" y="6" width="3.4" height="12" rx="1" fill="currentColor" />
  </svg>,
  // finish check
  <svg key="n5" width="18" height="18" viewBox="0 0 24 24" fill="none">
    <path
      d="M5 12.5 10 17.5 19.5 7"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>,
];

function SimNode({
  index,
  status,
  label,
  sub,
}: {
  index: number;
  status: NodeStatus;
  label: string;
  sub: string;
}) {
  const v = cardVisual(status);
  return (
    <div style={{ position: "absolute", ...NODE_POS[index] }}>
      <div
        style={{
          position: "relative",
          width: 226,
          height: 74,
          borderRadius: 14,
          border: `1px solid ${v.borderColor}`,
          background: v.background,
          color: v.color,
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "0 15px",
          transition:
            "border-color .4s, background .4s, box-shadow .4s, color .4s",
          boxShadow: v.boxShadow,
          animation: v.animation,
        }}
      >
        {/* amber ping on the paused approval gate */}
        {index === 3 && status === "paused" && (
          <span
            aria-hidden
            style={{
              position: "absolute",
              left: 15,
              top: 19,
              width: 36,
              height: 36,
              borderRadius: 9,
              background: "#f5b544",
              animation: "authPing 1.4s ease-out infinite",
              pointerEvents: "none",
            }}
          />
        )}
        <div
          style={{
            width: 36,
            height: 36,
            flex: "none",
            borderRadius: 9,
            border: "1px solid currentColor",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {NODE_ICONS[index]}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#e8ebf1" }}>
            {label}
          </div>
          <div style={{ fontSize: 11, color: "#7c8798", marginTop: 2 }}>
            {sub}
          </div>
        </div>
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: ".06em",
            textTransform: "uppercase",
            fontFamily: "var(--font-mono)",
          }}
        >
          {STATE_WORD[status]}
        </span>
      </div>
    </div>
  );
}

/**
 * The bot-protection gate: a SMALL card set beside the trigger with a DASHED spur, not another link
 * in the chain. Both choices are deliberate — Turnstile gates ingress rather than being a step the
 * request passes through, and the dashed connector is how this canvas can say "alongside" instead of
 * "next". Narrower and shorter than a main node so it reads as subordinate at a glance.
 */
function SideGate({ status }: { status: NodeStatus }) {
  const v = cardVisual(status);
  return (
    <>
      {/* Spur from the trigger's right edge. Dashed, and it animates only while the gate runs. */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          left: NODE_POS[0].left + 226,
          top: NODE_POS[0].top + 37,
          width: 42,
          height: 1,
          backgroundImage: `linear-gradient(90deg, ${v.borderColor} 0 6px, transparent 6px 12px)`,
          backgroundSize: "12px 1px",
          animation:
            status === "running" ? "authDash .7s linear infinite" : undefined,
          transition: "background-image .4s",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: NODE_POS[0].left + 268,
          top: NODE_POS[0].top + 12,
          width: 150,
          height: 50,
          borderRadius: 11,
          border: `1px dashed ${v.borderColor}`,
          background: v.background,
          color: v.color,
          display: "flex",
          alignItems: "center",
          gap: 9,
          padding: "0 11px",
          transition: "border-color .4s, background .4s, color .4s",
          boxShadow: v.boxShadow,
        }}
      >
        <div
          style={{
            width: 26,
            height: 26,
            flex: "none",
            borderRadius: 7,
            border: "1px solid currentColor",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {/* Inline SVG like NODE_ICONS above — this comp is hardcoded dark and doesn't use the
              shared Icon set (which has no shield glyph). */}
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M12 3l7 3v5c0 4.2-2.9 8-7 10-4.1-2-7-5.8-7-10V6z"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinejoin="round"
            />
            <path
              d="M9 12l2 2 4-4"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {BOT_GATE_LABEL[0]}
          </div>
          <div
            style={{
              fontSize: 9,
              opacity: 0.72,
              fontFamily: "var(--font-mono)",
              whiteSpace: "nowrap",
            }}
          >
            {STATE_WORD[status]} · side
          </div>
        </div>
      </div>
    </>
  );
}

export function WorkflowSimulation({
  signals,
  wide,
  scale,
}: {
  signals: SimulationSignals;
  /** Side-by-side layout (desktop, >1024px): border-right + fill height; otherwise
   *  (≤1024) the panel stacks below the form with a border-top and scales down. */
  wide: boolean;
  scale: number;
}) {
  const statuses = nodeStatuses(signals);
  const labels = nodeLabels(signals.mode, signals.provider);
  const bar = statusBar(signals);
  const gate = botGateStatus(signals);
  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        borderRight: wide ? "1px solid #1c2230" : undefined,
        borderTop: wide ? undefined : "1px solid #1c2230",
        background: "radial-gradient(120% 90% at 12% 0%, #1a130e, #0a0c11 58%)",
        paddingBottom: wide ? 0 : 8,
      }}
    >
      {/* canvas dot grid + ember glow */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage:
            "radial-gradient(circle, #20283544 1px, transparent 1px)",
          backgroundSize: "26px 26px",
          opacity: 0.5,
        }}
      />
      <div
        aria-hidden
        style={{
          position: "absolute",
          top: -140,
          left: -90,
          width: 440,
          height: 440,
          borderRadius: "50%",
          background:
            "radial-gradient(circle, rgba(242,98,46,.20), transparent 65%)",
          filter: "blur(10px)",
        }}
      />

      {/* header */}
      <div
        style={{
          position: "relative",
          padding: "34px 44px 20px",
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
          <span
            style={{
              fontSize: 12,
              color: "#7c8798",
              fontFamily: "var(--font-mono)",
              letterSpacing: ".02em",
            }}
          >
            auth.workflow
          </span>
          <span
            style={{
              marginLeft: "auto",
              display: "flex",
              alignItems: "center",
              gap: 7,
              fontSize: 11,
              color: "#7c8798",
              border: "1px solid #222a38",
              background: "#10141b",
              borderRadius: 20,
              padding: "5px 11px",
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: "#35c47a",
                boxShadow: "0 0 8px #35c47a",
              }}
            />
            simulated in browser
          </span>
        </div>
        <div
          style={{
            fontSize: 22,
            fontWeight: 700,
            letterSpacing: "-.02em",
            color: "#e8ebf1",
            lineHeight: 1.2,
          }}
        >
          Your sign-in, running as a
          <br />
          durable Naary workflow.
        </div>
      </div>

      {/* node canvas (scaled on narrow viewports) */}
      <div
        style={{
          position: "relative",
          flex: 1,
          minHeight: wide ? 0 : Math.ceil(730 * scale),
        }}
      >
        {/* `transform` does NOT change layout width: the inner box still lays out 560px
            wide, and `margin: 0 auto` collapses to a 0 left margin once the parent is
            narrower than that. With `transform-origin: top center` the scaled art was
            therefore centred on x=280 of a 390px viewport — pushed right, with ~69px
            cropped off by this panel's `overflow: hidden` (#511). Since `scale` exists
            precisely to make the comp FIT (min(1,(vw-32)/560)), scale from the top-LEFT
            and let an outer box of the SCALED width do the centring — so what gets
            centred is the visual box, at every width. */}
        <div style={{ width: Math.ceil(560 * scale), margin: "0 auto" }}>
          <div
            style={{
              position: "relative",
              width: 560,
              height: 730,
              transform: `scale(${scale})`,
              transformOrigin: "top left",
            }}
          >
            <svg
              viewBox="0 0 560 720"
              width={560}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                height: "100%",
                pointerEvents: "none",
                overflow: "visible",
              }}
              aria-hidden
            >
              {EDGE_PATHS.map((d, i) => {
                const e = edgeVisual(statuses[i + 1]);
                return (
                  <path
                    key={d}
                    d={d}
                    fill="none"
                    strokeWidth={2.2}
                    strokeLinecap="round"
                    stroke={e.stroke}
                    strokeDasharray={e.dash}
                    className={e.flowing ? "authEdgeFlow" : undefined}
                    style={{ transition: "stroke .4s" }}
                  />
                );
              })}
            </svg>
            {statuses.map((status, i) => (
              <SimNode
                key={labels[i][0]}
                index={i}
                status={status}
                label={labels[i][0]}
                sub={labels[i][1]}
              />
            ))}
            {/* Bot protection, alongside the trigger rather than in the chain — see SideGate. */}
            <SideGate status={gate} />
          </div>
        </div>
      </div>

      {/* status bar (red-tinted on honest failure) */}
      <div
        style={{
          position: "relative",
          margin: "0 24px 24px",
          height: 52,
          border: `1px solid ${bar.failed ? "#6a3630" : "#1e2532"}`,
          background: bar.failed ? "#1a1010cc" : "#0d1017cc",
          backdropFilter: "blur(6px)",
          borderRadius: 12,
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "0 18px",
        }}
      >
        <span
          style={{
            width: 9,
            height: 9,
            borderRadius: "50%",
            flex: "none",
            background: bar.dot,
            boxShadow: `0 0 10px ${bar.dot}`,
          }}
        />
        <span
          style={{
            fontSize: 13,
            color: bar.failed ? "#e89286" : "#c7cede",
            fontWeight: 500,
          }}
        >
          {bar.text}
        </span>
        <span
          style={{
            marginLeft: "auto",
            fontSize: 11,
            color: "#5c6573",
            fontFamily: "var(--font-mono)",
          }}
        >
          {runIdChip(signals)}
        </span>
      </div>
    </div>
  );
}
