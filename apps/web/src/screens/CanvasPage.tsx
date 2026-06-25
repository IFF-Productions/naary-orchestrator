import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Icon, SegmentedToggle } from "../components";
import type { IconName } from "../components";

/* ============================================================
   Workflow Canvas — full-screen fixed-layout prototype.
   Ported from `_design-reference/Workflow Canvas.dc.html`.
   Absolutely-positioned node cards + SVG connector edges; an
   Edit|Run mode toggle and a human-approval state machine.
   ============================================================ */

type Mode = "edit" | "run";
type RunStage = "awaiting" | "approved" | "rejected";

const GREEN_GRAD = "linear-gradient(180deg,#2fae5f,#239350)";

function fmtDur(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}h ${m}m ${ss}s` : `${m}m ${ss}s`;
}

/* ---------- small presentational helpers ---------- */

function Chip({
  accent,
  name,
  box = 24,
  icon = 13,
  radius = 6,
}: {
  accent: string;
  name: IconName;
  box?: number;
  icon?: number;
  radius?: number;
}) {
  return (
    <span
      style={{
        width: box,
        height: box,
        borderRadius: radius,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: `color-mix(in srgb, ${accent} 16%, transparent)`,
        color: accent,
        flex: "none",
      }}
    >
      <Icon name={name} size={icon} />
    </span>
  );
}

function CheckMark({
  size = 10,
  stroke = "#08120c",
  sw = 2.8,
}: {
  size?: number;
  stroke?: string;
  sw?: number;
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path
        d="M5 12l4.5 4.5L19 7"
        stroke={stroke}
        strokeWidth={sw}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const MONO_KIND: CSSProperties = {
  fontSize: 9,
  fontWeight: 500,
  letterSpacing: ".05em",
  color: "var(--ink-3)",
  textTransform: "uppercase",
};

const SECTION_LABEL: CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: ".1em",
  color: "var(--ink-3)",
  textTransform: "uppercase",
};

function PaletteItem({
  accent,
  icon,
  title,
  sub,
}: {
  accent: string;
  icon: ReactNode;
  title: string;
  sub: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 9px",
        borderRadius: 8,
        border: "1px solid transparent",
        cursor: "grab",
      }}
    >
      <span
        style={{
          width: 26,
          height: 26,
          borderRadius: 7,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: `color-mix(in srgb, ${accent} 15%, transparent)`,
          color: accent,
          flex: "none",
        }}
      >
        {icon}
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 500, color: "var(--ink)" }}>
          {title}
        </div>
        <div style={{ fontSize: 10.5, color: "var(--ink-3)" }}>{sub}</div>
      </div>
    </div>
  );
}

function PaletteHeading({ children }: { children: ReactNode }) {
  return (
    <div
      className="mono"
      style={{
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: ".12em",
        color: "var(--ink-3)",
        textTransform: "uppercase",
        padding: "14px 4px 7px",
      }}
    >
      {children}
    </div>
  );
}

/* bespoke palette icons (no entry in the Icon union) */
const ConditionIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
    <path
      d="M12 3l9 9-9 9-9-9 9-9z"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
    <path
      d="M9 12h6"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
    />
  </svg>
);

export function CanvasPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>("edit");
  const [runStage, setRunStage] = useState<RunStage>("awaiting");
  const [elapsed, setElapsed] = useState(8054);

  const isRun = mode === "run";
  const isAwaiting = runStage === "awaiting";
  const isApproved = runStage === "approved";
  const isRejected = runStage === "rejected";

  useEffect(() => {
    if (!(mode === "run" && runStage === "awaiting")) return;
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, [mode, runStage]);

  /* ----- run-stage derived styling ----- */
  const accent = isApproved
    ? "var(--state-done)"
    : isRejected
      ? "var(--state-error)"
      : "var(--state-paused)";
  const nodeBorder = isApproved
    ? "color-mix(in srgb,var(--state-done) 55%,var(--line))"
    : isRejected
      ? "color-mix(in srgb,var(--state-error) 55%,var(--line))"
      : "color-mix(in srgb,var(--state-paused) 65%,var(--line))";

  const approvalOutPort = isApproved ? "var(--state-done)" : "var(--line-2)";

  // edge router -> approval (e3)
  const e3Stroke = isAwaiting ? "var(--state-paused)" : "var(--state-done)";
  const e3Dash = isAwaiting ? "6 6" : "0";
  // edge approval -> end (e6)
  const e6Stroke = isApproved ? "var(--state-done)" : "var(--line-2)";
  const e6Width = isApproved ? 2.2 : 1.6;
  const e6Op = isApproved ? 1 : 0.26;

  const endDone = isApproved;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        background: "var(--bg)",
        color: "var(--ink)",
        fontFamily: "var(--font-sans)",
        overflow: "hidden",
        WebkitFontSmoothing: "antialiased",
      }}
    >
      {/* ===================== TOP BAR ===================== */}
      <div
        style={{
          height: 52,
          flex: "none",
          display: "flex",
          alignItems: "center",
          padding: "0 14px",
          background: "linear-gradient(180deg,#10131a,#0d1015)",
          borderBottom: "1px solid var(--line)",
          position: "relative",
          zIndex: 40,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            paddingRight: 14,
          }}
        >
          <button
            type="button"
            title="Back to Naary"
            onClick={() => navigate("/app")}
            style={{
              width: 26,
              height: 26,
              borderRadius: 7,
              border: "none",
              padding: 0,
              cursor: "pointer",
              background: "var(--brand-radial)",
              boxShadow: "0 0 14px -2px rgba(242,98,46,.6)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Icon name="flame" size={15} style={{ color: "#fff3ec" }} />
          </button>
          <span
            style={{
              fontWeight: 700,
              fontSize: 13.5,
              letterSpacing: ".02em",
              color: "#f4d9cc",
            }}
          >
            Naary
          </span>
        </div>
        <div style={{ width: 1, height: 22, background: "var(--line)" }} />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            paddingLeft: 14,
          }}
        >
          <span style={{ fontSize: 12, color: "var(--ink-3)" }}>Workflows</span>
          <span style={{ color: "var(--ink-3)", fontSize: 12 }}>/</span>
          <span
            style={{ fontWeight: 600, fontSize: 13.5, color: "var(--ink)" }}
          >
            Email triage &amp; refunds
          </span>
          <span
            className="mono"
            style={{
              fontSize: 10.5,
              fontWeight: 500,
              color: "var(--ink-2)",
              background: "var(--surface)",
              border: "1px solid var(--line)",
              padding: "2px 7px",
              borderRadius: 5,
            }}
          >
            v14
          </span>
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              fontSize: 11,
              color: "var(--ink-3)",
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: "var(--state-done)",
              }}
            />
            saved 2m ago
          </span>
        </div>

        {/* center mode toggle */}
        <div
          style={{
            position: "absolute",
            left: "50%",
            transform: "translateX(-50%)",
          }}
        >
          <SegmentedToggle<Mode>
            options={[
              { value: "edit", label: "Edit" },
              { value: "run", label: "Run" },
            ]}
            value={mode}
            onChange={setMode}
          />
        </div>

        {/* right actions */}
        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <button type="button" title="Version history" style={iconBtn}>
            <Icon name="refresh" size={15} />
          </button>
          <button type="button" title="Share" style={iconBtn}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
              <circle
                cx="18"
                cy="5"
                r="2.4"
                stroke="currentColor"
                strokeWidth="1.7"
              />
              <circle
                cx="6"
                cy="12"
                r="2.4"
                stroke="currentColor"
                strokeWidth="1.7"
              />
              <circle
                cx="18"
                cy="19"
                r="2.4"
                stroke="currentColor"
                strokeWidth="1.7"
              />
              <path
                d="M8.1 10.8l7.8-4.6M8.1 13.2l7.8 4.6"
                stroke="currentColor"
                strokeWidth="1.7"
              />
            </svg>
          </button>
          <div
            style={{
              width: 1,
              height: 22,
              background: "var(--line)",
              margin: "0 2px",
            }}
          />
          <button
            type="button"
            style={{
              height: 32,
              padding: "0 14px",
              borderRadius: 7,
              background: "var(--surface)",
              border: "1px solid var(--line-2)",
              color: "var(--ink)",
              fontFamily: "var(--font-sans)",
              fontSize: 12.5,
              fontWeight: 500,
              display: "flex",
              alignItems: "center",
              gap: 7,
              cursor: "pointer",
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
              <path
                d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinejoin="round"
              />
              <path
                d="M17 21v-7H7v7M7 3v4h7"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinejoin="round"
              />
            </svg>
            Save
          </button>
          {!isRun ? (
            <button
              type="button"
              onClick={() => setMode("run")}
              style={{
                height: 32,
                padding: "0 16px",
                borderRadius: 7,
                background: GREEN_GRAD,
                border: "1px solid #2bbd66",
                color: "#eafff2",
                fontFamily: "var(--font-sans)",
                fontSize: 12.5,
                fontWeight: 600,
                display: "flex",
                alignItems: "center",
                gap: 7,
                cursor: "pointer",
                boxShadow: "0 2px 10px -3px rgba(43,189,102,.5)",
              }}
            >
              <Icon name="play" size={13} style={{ color: "#eafff2" }} />
              Run workflow
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setMode("edit")}
              style={{
                height: 32,
                padding: "0 14px",
                borderRadius: 7,
                background: "rgba(227,87,97,.12)",
                border: "1px solid rgba(227,87,97,.45)",
                color: "#f0908f",
                fontFamily: "var(--font-sans)",
                fontSize: 12.5,
                fontWeight: 600,
                display: "flex",
                alignItems: "center",
                gap: 7,
                cursor: "pointer",
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                <rect
                  x="5"
                  y="5"
                  width="14"
                  height="14"
                  rx="2"
                  fill="currentColor"
                />
              </svg>
              Stop run
            </button>
          )}
        </div>
      </div>

      {/* ===================== MIDDLE ROW ===================== */}
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/* ---------- LEFT PALETTE ---------- */}
        <div
          style={{
            width: 248,
            flex: "none",
            background: "var(--bg-2)",
            borderRight: "1px solid var(--line)",
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
            position: "relative",
            zIndex: 20,
          }}
        >
          {isRun && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                background: "rgba(8,10,14,.55)",
                zIndex: 5,
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "center",
                paddingTop: 18,
                backdropFilter: "saturate(.6) blur(.5px)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  fontSize: 11,
                  color: "var(--ink-2)",
                  background: "var(--surface)",
                  border: "1px solid var(--line)",
                  padding: "7px 11px",
                  borderRadius: 8,
                }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                  <rect
                    x="5"
                    y="11"
                    width="14"
                    height="9"
                    rx="2"
                    stroke="currentColor"
                    strokeWidth="1.7"
                  />
                  <path
                    d="M8 11V8a4 4 0 0 1 8 0v3"
                    stroke="currentColor"
                    strokeWidth="1.7"
                  />
                </svg>
                Editing locked during run
              </div>
            </div>
          )}

          <div style={{ padding: "12px 12px 10px" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                background: "var(--surface)",
                border: "1px solid var(--line)",
                borderRadius: 8,
                padding: "7px 9px",
              }}
            >
              <Icon name="search" size={14} style={{ color: "var(--ink-3)" }} />
              <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
                Search nodes
              </span>
              <span
                className="mono"
                style={{
                  marginLeft: "auto",
                  fontSize: 10,
                  color: "var(--ink-3)",
                  border: "1px solid var(--line)",
                  borderRadius: 4,
                  padding: "1px 5px",
                }}
              >
                ⌘K
              </span>
            </div>
          </div>

          <div style={{ flex: 1, overflowY: "auto", padding: "2px 10px 14px" }}>
            <PaletteHeading>Triggers</PaletteHeading>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <PaletteItem
                accent="var(--node-trigger)"
                icon={<Icon name="bolt" size={14} />}
                title="Webhook"
                sub="Inbound HTTP / event"
              />
              <PaletteItem
                accent="var(--node-trigger)"
                icon={<Icon name="clock" size={14} />}
                title="Schedule"
                sub="Cron / interval"
              />
            </div>

            <PaletteHeading>Agents</PaletteHeading>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <PaletteItem
                accent="var(--node-agent)"
                icon={<Icon name="agent" size={14} />}
                title="LLM Agent"
                sub="Reasoning + tools"
              />
              <PaletteItem
                accent="var(--node-agent)"
                icon={<Icon name="copy" size={14} />}
                title="Subagent"
                sub="Nested workflow"
              />
            </div>

            <PaletteHeading>Tools</PaletteHeading>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <PaletteItem
                accent="var(--node-mcp)"
                icon={<Icon name="plug" size={14} />}
                title="MCP Tool"
                sub="Model Context Protocol"
              />
              <PaletteItem
                accent="var(--node-http)"
                icon={<Icon name="http" size={14} />}
                title="HTTP Request"
                sub="REST / webhook out"
              />
            </div>

            <PaletteHeading>Control flow</PaletteHeading>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <PaletteItem
                accent="var(--node-router)"
                icon={<Icon name="router" size={14} />}
                title="Router"
                sub="Branch on value"
              />
              <PaletteItem
                accent="var(--node-router)"
                icon={ConditionIcon}
                title="Condition"
                sub="If / else gate"
              />
              <PaletteItem
                accent="var(--node-approval)"
                icon={<Icon name="approval" size={14} />}
                title="Human Approval"
                sub="Pause for review"
              />
            </div>

            <PaletteHeading>Terminals</PaletteHeading>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <PaletteItem
                accent="var(--node-end)"
                icon={<Icon name="end" size={14} />}
                title="End"
                sub="Return / halt"
              />
            </div>
          </div>
        </div>

        {/* ---------- CENTER CANVAS ---------- */}
        <div
          style={{
            flex: 1,
            position: "relative",
            minWidth: 0,
            background: "var(--bg)",
            backgroundImage:
              "radial-gradient(var(--line-2) 1px, transparent 1px)",
            backgroundSize: "22px 22px",
            overflow: "hidden",
          }}
        >
          {/* vignette */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              background:
                "radial-gradient(120% 90% at 42% 40%, transparent 52%, rgba(5,7,10,.6) 100%)",
              pointerEvents: "none",
              zIndex: 1,
            }}
          />

          {/* top-left status chips */}
          <div
            style={{
              position: "absolute",
              top: 14,
              left: 14,
              zIndex: 15,
              display: "flex",
              gap: 8,
              alignItems: "center",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 7,
                background: "rgba(14,17,23,.85)",
                border: "1px solid var(--line)",
                borderRadius: 8,
                padding: "6px 10px",
                backdropFilter: "blur(6px)",
              }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: "var(--brand)",
                  boxShadow: "0 0 8px var(--brand)",
                }}
              />
              <span
                className="mono"
                style={{ fontSize: 11, color: "var(--ink-2)" }}
              >
                7 nodes · 7 edges
              </span>
            </div>
            {isRun && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  background: "rgba(226,168,68,.12)",
                  border: "1px solid rgba(226,168,68,.4)",
                  borderRadius: 8,
                  padding: "6px 10px",
                  backdropFilter: "blur(6px)",
                }}
              >
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    background: "var(--state-paused)",
                    animation: "naaryBlink 1.4s ease-in-out infinite",
                  }}
                />
                <span
                  className="mono"
                  style={{ fontSize: 11, color: "#e9c281" }}
                >
                  run rs_8f3a · live
                </span>
              </div>
            )}
          </div>

          {/* =========== EDIT GRAPH =========== */}
          {!isRun && (
            <div style={{ position: "absolute", inset: 0, zIndex: 2 }}>
              <svg
                width="924"
                height="892"
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  overflow: "visible",
                  pointerEvents: "none",
                }}
              >
                <g fill="none" stroke="var(--line-2)" strokeWidth="1.6">
                  <path d="M168 434 C184 434 184 434 200 434" />
                  <path d="M356 434 C372 434 372 438 388 438" />
                  <path d="M544 428 C584 428 536 284 576 284" />
                  <path d="M544 444 C560 444 560 450 576 450" />
                  <path d="M544 460 C584 460 536 602 576 602" />
                  <path d="M732 284 C760 284 736 386 764 386" />
                  <path d="M732 450 C760 450 736 386 764 386" />
                </g>
                <g fill="var(--line-2)">
                  <circle cx="200" cy="434" r="2.5" />
                  <circle cx="388" cy="438" r="2.5" />
                  <circle cx="576" cy="284" r="2.5" />
                  <circle cx="576" cy="450" r="2.5" />
                  <circle cx="576" cy="602" r="2.5" />
                  <circle cx="764" cy="386" r="2.5" />
                </g>
              </svg>

              {/* N1 Webhook */}
              <div
                style={{
                  ...nodeBase,
                  left: 12,
                  top: 400,
                  width: 156,
                  height: 80,
                  border: "1px solid var(--line)",
                }}
              >
                <div style={accentBar("var(--node-trigger)")} />
                <div style={nodeHead}>
                  <Chip accent="var(--node-trigger)" name="bolt" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={nodeTitle}>Email received</div>
                    <div className="mono" style={MONO_KIND}>
                      Webhook
                    </div>
                  </div>
                </div>
                <div
                  className="mono"
                  style={{
                    padding: "0 10px",
                    fontSize: 10,
                    color: "var(--ink-2)",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  POST /hooks/inbound
                </div>
                <span
                  style={port({ right: -6, top: 34, color: "var(--line-2)" })}
                />
              </div>

              {/* N2 Agent (selected) */}
              <div
                style={{
                  ...nodeBase,
                  left: 200,
                  top: 384,
                  width: 156,
                  height: 112,
                  border: "1px solid var(--node-agent)",
                  boxShadow:
                    "0 0 0 3px color-mix(in srgb,var(--node-agent) 22%,transparent),0 14px 30px -14px rgba(0,0,0,.8)",
                }}
              >
                <div style={accentBar("var(--node-agent)")} />
                <div style={{ ...nodeHead, padding: "9px 10px 5px" }}>
                  <Chip accent="var(--node-agent)" name="agent" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={nodeTitle}>Classify email</div>
                    <div className="mono" style={MONO_KIND}>
                      Agent
                    </div>
                  </div>
                </div>
                <div className="mono" style={nodeBodyMono}>
                  → {"{category, confidence}"}
                </div>
                <div style={tagRow}>
                  <span style={accentTag("var(--node-agent)")}>
                    <span style={dot5("var(--node-agent)")} />
                    Sonnet 4.5
                  </span>
                  <span style={plainTag}>$0.009</span>
                </div>
                <span
                  style={port({ left: -6, top: 50, color: "var(--line-2)" })}
                />
                <span
                  style={port({
                    right: -6,
                    top: 50,
                    color: "var(--node-agent)",
                  })}
                />
              </div>

              {/* N3 Router */}
              <div
                style={{
                  ...nodeBase,
                  left: 388,
                  top: 388,
                  width: 156,
                  height: 112,
                  border: "1px solid var(--line)",
                }}
              >
                <div style={accentBar("var(--node-router)")} />
                <div style={nodeHead}>
                  <Chip accent="var(--node-router)" name="router" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={nodeTitle}>Route by category</div>
                    <div className="mono" style={MONO_KIND}>
                      Router
                    </div>
                  </div>
                </div>
                <div
                  style={{
                    padding: "0 10px",
                    display: "flex",
                    flexDirection: "column",
                    gap: 4,
                  }}
                >
                  <div className="mono" style={routeLine}>
                    refund_request
                  </div>
                  <div className="mono" style={routeLine}>
                    general_inquiry
                  </div>
                  <div className="mono" style={routeLine}>
                    spam
                  </div>
                </div>
                <span
                  style={port({ left: -6, top: 50, color: "var(--line-2)" })}
                />
                <span
                  style={port({
                    right: -5,
                    top: 35,
                    color: "var(--node-router)",
                    size: 10,
                  })}
                />
                <span
                  style={port({
                    right: -5,
                    top: 51,
                    color: "var(--line-2)",
                    size: 10,
                  })}
                />
                <span
                  style={port({
                    right: -5,
                    top: 67,
                    color: "var(--line-2)",
                    size: 10,
                  })}
                />
              </div>

              {/* N4 Human Approval */}
              <div
                style={{
                  ...nodeBase,
                  left: 576,
                  top: 250,
                  width: 156,
                  height: 84,
                  border: "1px solid var(--line)",
                }}
              >
                <div style={accentBar("var(--node-approval)")} />
                <div style={nodeHead}>
                  <Chip accent="var(--node-approval)" name="approval" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={nodeTitle}>Approve refund</div>
                    <div className="mono" style={MONO_KIND}>
                      Human Approval
                    </div>
                  </div>
                </div>
                <div
                  className="mono"
                  style={{
                    padding: "0 10px",
                    fontSize: 9.5,
                    color: "var(--ink-2)",
                  }}
                >
                  assignee: billing-team
                </div>
                <span
                  style={port({ left: -6, top: 34, color: "var(--line-2)" })}
                />
                <span
                  style={port({
                    right: -6,
                    top: 34,
                    color: "var(--node-approval)",
                  })}
                />
              </div>

              {/* N5 Draft reply */}
              <div
                style={{
                  ...nodeBase,
                  left: 576,
                  top: 400,
                  width: 156,
                  height: 112,
                  border: "1px solid var(--line)",
                }}
              >
                <div style={accentBar("var(--node-agent)")} />
                <div style={{ ...nodeHead, padding: "9px 10px 5px" }}>
                  <Chip accent="var(--node-agent)" name="agent" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={nodeTitle}>Draft auto-reply</div>
                    <div className="mono" style={MONO_KIND}>
                      Agent
                    </div>
                  </div>
                </div>
                <div className="mono" style={nodeBodyMono}>
                  tone: friendly · ≤120w
                </div>
                <div style={tagRow}>
                  <span style={accentTag("var(--node-agent)")}>
                    <span style={dot5("var(--node-agent)")} />
                    Haiku 4.5
                  </span>
                  <span style={plainTag}>$0.001</span>
                </div>
                <span
                  style={port({ left: -6, top: 50, color: "var(--line-2)" })}
                />
                <span
                  style={port({
                    right: -6,
                    top: 50,
                    color: "var(--node-agent)",
                  })}
                />
              </div>

              {/* N6 End spam */}
              <div
                style={{
                  ...nodeBase,
                  left: 576,
                  top: 576,
                  width: 156,
                  height: 64,
                  border: "1px solid var(--line)",
                }}
              >
                <div style={accentBar("var(--node-end)")} />
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "11px 10px",
                  }}
                >
                  <Chip accent="var(--node-end)" name="end" icon={12} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={nodeTitle}>Archive spam</div>
                    <div className="mono" style={MONO_KIND}>
                      End
                    </div>
                  </div>
                </div>
                <span
                  style={port({ left: -6, top: 26, color: "var(--line-2)" })}
                />
              </div>

              {/* N7 End resolved */}
              <div
                style={{
                  ...nodeBase,
                  left: 764,
                  top: 360,
                  width: 156,
                  height: 64,
                  border: "1px solid var(--line)",
                }}
              >
                <div style={accentBar("var(--node-end)")} />
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "11px 10px",
                  }}
                >
                  <Chip accent="var(--node-end)" name="end" icon={12} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={nodeTitle}>Ticket resolved</div>
                    <div className="mono" style={MONO_KIND}>
                      End
                    </div>
                  </div>
                </div>
                <span
                  style={port({ left: -6, top: 26, color: "var(--line-2)" })}
                />
              </div>
            </div>
          )}

          {/* =========== RUN GRAPH =========== */}
          {isRun && (
            <div style={{ position: "absolute", inset: 0, zIndex: 2 }}>
              <svg
                width="924"
                height="892"
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  overflow: "visible",
                  pointerEvents: "none",
                }}
              >
                <g
                  fill="none"
                  stroke="var(--line-2)"
                  strokeWidth="1.6"
                  opacity=".26"
                >
                  <path d="M544 444 C560 444 560 450 576 450" />
                  <path d="M544 460 C584 460 536 602 576 602" />
                  <path d="M732 450 C760 450 736 386 764 386" />
                </g>
                <g fill="none" stroke="var(--state-done)" strokeWidth="2.2">
                  <path d="M168 434 C184 434 184 434 200 434" />
                  <path d="M356 434 C372 434 372 438 388 438" />
                </g>
                <path
                  d="M544 428 C584 428 536 284 576 284"
                  fill="none"
                  stroke={e3Stroke}
                  strokeWidth="2.4"
                  strokeDasharray={e3Dash}
                  style={
                    isAwaiting
                      ? { animation: "naaryDash .6s linear infinite" }
                      : undefined
                  }
                />
                <path
                  d="M732 284 C760 284 736 386 764 386"
                  fill="none"
                  stroke={e6Stroke}
                  strokeWidth={e6Width}
                  opacity={e6Op}
                />
              </svg>

              {/* N1 Webhook (done) */}
              <div
                style={{
                  ...nodeBase,
                  left: 12,
                  top: 400,
                  width: 156,
                  height: 80,
                  border:
                    "1px solid color-mix(in srgb,var(--state-done) 45%,var(--line))",
                }}
              >
                <div style={accentBar("var(--state-done)")} />
                <div style={nodeHead}>
                  <Chip accent="var(--node-trigger)" name="bolt" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={nodeTitle}>Email received</div>
                    <div className="mono" style={MONO_KIND}>
                      Webhook
                    </div>
                  </div>
                  <DoneBadge />
                </div>
                <div
                  className="mono"
                  style={{
                    padding: "0 10px",
                    fontSize: 10,
                    color: "var(--ink-2)",
                  }}
                >
                  2h 14m ago
                </div>
                <span
                  style={port({
                    right: -6,
                    top: 34,
                    color: "var(--state-done)",
                    fill: true,
                  })}
                />
              </div>

              {/* N2 Agent (done) */}
              <div
                style={{
                  ...nodeBase,
                  left: 200,
                  top: 384,
                  width: 156,
                  height: 112,
                  border:
                    "1px solid color-mix(in srgb,var(--state-done) 45%,var(--line))",
                }}
              >
                <div style={accentBar("var(--state-done)")} />
                <div style={{ ...nodeHead, padding: "9px 10px 5px" }}>
                  <Chip accent="var(--node-agent)" name="agent" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={nodeTitle}>Classify email</div>
                    <div className="mono" style={MONO_KIND}>
                      Agent
                    </div>
                  </div>
                  <DoneBadge />
                </div>
                <div
                  className="mono"
                  style={{ ...nodeBodyMono, color: "#7fc99a" }}
                >
                  ⏎ refund_request · 0.94
                </div>
                <div style={tagRow}>
                  <span style={{ ...accentTag("var(--node-agent)"), gap: 0 }}>
                    Sonnet 4.5
                  </span>
                  <span style={plainTag}>$0.0091</span>
                </div>
                <span
                  style={port({
                    left: -6,
                    top: 50,
                    color: "var(--state-done)",
                    fill: true,
                  })}
                />
                <span
                  style={port({
                    right: -6,
                    top: 50,
                    color: "var(--state-done)",
                    fill: true,
                  })}
                />
              </div>

              {/* N3 Router (done) */}
              <div
                style={{
                  ...nodeBase,
                  left: 388,
                  top: 388,
                  width: 156,
                  height: 112,
                  border:
                    "1px solid color-mix(in srgb,var(--state-done) 45%,var(--line))",
                }}
              >
                <div style={accentBar("var(--state-done)")} />
                <div style={nodeHead}>
                  <Chip accent="var(--node-router)" name="router" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={nodeTitle}>Route by category</div>
                    <div className="mono" style={MONO_KIND}>
                      Router
                    </div>
                  </div>
                  <DoneBadge />
                </div>
                <div
                  style={{
                    padding: "0 10px",
                    display: "flex",
                    flexDirection: "column",
                    gap: 4,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      background:
                        "color-mix(in srgb,var(--state-done) 14%,transparent)",
                      margin: "0 -5px",
                      padding: "1px 5px",
                      borderRadius: 4,
                    }}
                  >
                    <span
                      className="mono"
                      style={{
                        fontSize: 9.5,
                        color: "#9fe0b6",
                        fontWeight: 600,
                      }}
                    >
                      refund_request
                    </span>
                    <span
                      className="mono"
                      style={{ fontSize: 8, color: "#7fc99a" }}
                    >
                      ●
                    </span>
                  </div>
                  <div className="mono" style={{ ...routeLine, opacity: 0.4 }}>
                    general_inquiry
                  </div>
                  <div className="mono" style={{ ...routeLine, opacity: 0.4 }}>
                    spam
                  </div>
                </div>
                <span
                  style={port({
                    left: -6,
                    top: 50,
                    color: "var(--state-done)",
                    fill: true,
                  })}
                />
                <span
                  style={port({
                    right: -5,
                    top: 35,
                    color: "var(--state-done)",
                    size: 10,
                    fill: true,
                  })}
                />
                <span
                  style={port({
                    right: -5,
                    top: 51,
                    color: "var(--line-2)",
                    size: 10,
                    opacity: 0.4,
                  })}
                />
                <span
                  style={port({
                    right: -5,
                    top: 67,
                    color: "var(--line-2)",
                    size: 10,
                    opacity: 0.4,
                  })}
                />
              </div>

              {/* N4 Approval (stateful) */}
              <div
                style={{
                  position: "absolute",
                  left: 576,
                  top: 236,
                  width: 156,
                  border: `1.5px solid ${nodeBorder}`,
                  background: "var(--card)",
                  borderRadius: 10,
                  boxShadow: `0 0 0 3px color-mix(in srgb,${accent} 18%,transparent),0 16px 32px -14px rgba(0,0,0,.85)`,
                  ...(isAwaiting
                    ? { animation: "naaryPulseRing 2s ease-out infinite" }
                    : {}),
                }}
              >
                <div style={accentBar(accent)} />
                <div style={{ ...nodeHead, padding: "9px 10px 5px" }}>
                  <Chip accent="var(--node-approval)" name="approval" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={nodeTitle}>Approve refund</div>
                    <div className="mono" style={MONO_KIND}>
                      Human Approval
                    </div>
                  </div>
                  <span
                    className="mono"
                    style={{
                      width: 17,
                      height: 17,
                      borderRadius: "50%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flex: "none",
                      fontSize: 10,
                      fontWeight: 700,
                      ...(isApproved
                        ? { background: "var(--state-done)", color: "#08120c" }
                        : isRejected
                          ? {
                              background: "var(--state-error)",
                              color: "#1a0708",
                            }
                          : {
                              background: "transparent",
                              border: "2px solid var(--state-paused)",
                            }),
                    }}
                  >
                    {isApproved ? "✓" : isRejected ? "✕" : ""}
                  </span>
                </div>

                {isAwaiting && (
                  <div style={{ padding: "0 10px 10px" }}>
                    <div
                      className="mono"
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 5,
                        fontSize: 9,
                        fontWeight: 600,
                        color: "#e9c281",
                        background: "rgba(226,168,68,.14)",
                        border: "1px solid rgba(226,168,68,.4)",
                        padding: "2px 7px",
                        borderRadius: 5,
                      }}
                    >
                      <span
                        style={{
                          width: 5,
                          height: 5,
                          borderRadius: "50%",
                          background: "var(--state-paused)",
                          animation: "naaryBlink 1.4s infinite",
                        }}
                      />
                      AWAITING · 2h 14m
                    </div>
                    <div
                      className="mono"
                      style={{
                        fontSize: 9.5,
                        color: "var(--ink-2)",
                        marginTop: 6,
                        lineHeight: 1.45,
                      }}
                    >
                      $48.00 · order #A-29183
                    </div>
                    <div style={{ display: "flex", gap: 6, marginTop: 9 }}>
                      <button
                        type="button"
                        onClick={() => setRunStage("approved")}
                        style={{
                          flex: 1,
                          height: 28,
                          borderRadius: 6,
                          background: GREEN_GRAD,
                          border: "1px solid #2bbd66",
                          color: "#eafff2",
                          fontFamily: "var(--font-sans)",
                          fontSize: 11,
                          fontWeight: 600,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          gap: 5,
                          cursor: "pointer",
                        }}
                      >
                        <CheckMark size={11} stroke="currentColor" sw={2.6} />
                        Approve
                      </button>
                      <button
                        type="button"
                        onClick={() => setRunStage("rejected")}
                        style={{
                          flex: 1,
                          height: 28,
                          borderRadius: 6,
                          background: "transparent",
                          border: "1px solid rgba(227,87,97,.5)",
                          color: "#f0908f",
                          fontFamily: "var(--font-sans)",
                          fontSize: 11,
                          fontWeight: 600,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          gap: 5,
                          cursor: "pointer",
                        }}
                      >
                        <svg
                          width="11"
                          height="11"
                          viewBox="0 0 24 24"
                          fill="none"
                        >
                          <path
                            d="M6 6l12 12M18 6L6 18"
                            stroke="currentColor"
                            strokeWidth="2.4"
                            strokeLinecap="round"
                          />
                        </svg>
                        Reject
                      </button>
                    </div>
                  </div>
                )}
                {isApproved && (
                  <div
                    className="mono"
                    style={{
                      padding: "0 10px 11px",
                      fontSize: 10,
                      color: "#7fc99a",
                    }}
                  >
                    approved · just now
                  </div>
                )}
                {isRejected && (
                  <div
                    className="mono"
                    style={{
                      padding: "0 10px 11px",
                      fontSize: 10,
                      color: "#f0908f",
                    }}
                  >
                    rejected · halted
                  </div>
                )}
                <span
                  style={port({
                    left: -6,
                    top: 34,
                    color: "var(--state-done)",
                    fill: true,
                  })}
                />
                <span
                  style={port({
                    right: -6,
                    top: 34,
                    color: approvalOutPort,
                    fill: true,
                  })}
                />
              </div>

              {/* N5 Draft (skipped) */}
              <div
                style={{
                  position: "absolute",
                  left: 576,
                  top: 400,
                  width: 156,
                  height: 112,
                  border: "1px solid var(--line)",
                  background: "var(--card)",
                  borderRadius: 10,
                  opacity: 0.32,
                  filter: "saturate(.5)",
                }}
              >
                <div style={accentBar("var(--node-agent)")} />
                <div style={{ ...nodeHead, padding: "9px 10px 5px" }}>
                  <Chip accent="var(--node-agent)" name="agent" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={nodeTitle}>Draft auto-reply</div>
                    <div className="mono" style={MONO_KIND}>
                      Agent · skipped
                    </div>
                  </div>
                </div>
                <div
                  className="mono"
                  style={{
                    padding: "0 10px",
                    fontSize: 9.5,
                    color: "var(--ink-3)",
                  }}
                >
                  not on executed path
                </div>
                <span
                  style={port({ left: -6, top: 50, color: "var(--line-2)" })}
                />
              </div>

              {/* N6 End spam (skipped) */}
              <div
                style={{
                  position: "absolute",
                  left: 576,
                  top: 576,
                  width: 156,
                  height: 64,
                  border: "1px solid var(--line)",
                  background: "var(--card)",
                  borderRadius: 10,
                  opacity: 0.32,
                  filter: "saturate(.5)",
                }}
              >
                <div style={accentBar("var(--node-end)")} />
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "11px 10px",
                  }}
                >
                  <Chip accent="var(--node-end)" name="end" icon={12} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={nodeTitle}>Archive spam</div>
                    <div className="mono" style={MONO_KIND}>
                      End
                    </div>
                  </div>
                </div>
                <span
                  style={port({ left: -6, top: 26, color: "var(--line-2)" })}
                />
              </div>

              {/* N7 End resolved (stateful) */}
              <div
                style={{
                  position: "absolute",
                  left: 764,
                  top: 360,
                  width: 156,
                  height: 64,
                  border: endDone
                    ? "1px solid color-mix(in srgb,var(--state-done) 45%,var(--line))"
                    : "1px solid var(--line)",
                  background: "var(--card)",
                  borderRadius: 10,
                  ...(endDone
                    ? { boxShadow: "0 10px 26px -14px rgba(0,0,0,.7)" }
                    : { opacity: 0.4, filter: "saturate(.5)" }),
                }}
              >
                <div
                  style={accentBar(
                    endDone ? "var(--state-done)" : "var(--node-end)",
                  )}
                />
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "11px 10px",
                  }}
                >
                  <Chip accent="var(--node-end)" name="end" icon={12} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={nodeTitle}>Ticket resolved</div>
                    <div className="mono" style={MONO_KIND}>
                      {endDone ? "End · done" : "End · pending"}
                    </div>
                  </div>
                  {endDone && <DoneBadge />}
                </div>
                <span
                  style={port({
                    left: -6,
                    top: 26,
                    color: approvalOutPort,
                    fill: true,
                  })}
                />
              </div>
            </div>
          )}

          {/* zoom controls */}
          <div
            style={{
              position: "absolute",
              bottom: 16,
              left: 16,
              zIndex: 15,
              display: "flex",
              alignItems: "center",
              gap: 6,
              background: "rgba(14,17,23,.9)",
              border: "1px solid var(--line)",
              borderRadius: 9,
              padding: 5,
              backdropFilter: "blur(6px)",
            }}
          >
            <button type="button" style={{ ...zoomBtn, fontSize: 17 }}>
              −
            </button>
            <span
              className="mono"
              style={{
                fontSize: 11,
                color: "var(--ink-2)",
                minWidth: 38,
                textAlign: "center",
              }}
            >
              100%
            </span>
            <button type="button" style={{ ...zoomBtn, fontSize: 16 }}>
              +
            </button>
            <div style={{ width: 1, height: 18, background: "var(--line)" }} />
            <button type="button" title="Fit to view" style={zoomBtn}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <path
                  d="M4 9V5a1 1 0 0 1 1-1h4M20 9V5a1 1 0 0 0-1-1h-4M4 15v4a1 1 0 0 0 1 1h4M20 15v4a1 1 0 0 1-1 1h-4"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>

          {/* minimap */}
          <div
            style={{
              position: "absolute",
              bottom: 16,
              right: 16,
              zIndex: 15,
              width: 150,
              height: 96,
              background: "rgba(11,13,18,.92)",
              border: "1px solid var(--line)",
              borderRadius: 8,
              backdropFilter: "blur(6px)",
              overflow: "hidden",
            }}
          >
            <div style={miniNode(44, 8, 16, 7, "var(--node-trigger)", 0.8)} />
            <div style={miniNode(43, 32, 16, 9, "var(--node-agent)", 0.8)} />
            <div style={miniNode(43, 56, 16, 9, "var(--node-router)", 0.8)} />
            <div
              style={miniNode(28, 84, 15, 7, "var(--node-approval)", 0.85)}
            />
            <div style={miniNode(44, 84, 15, 7, "var(--node-agent)", 0.45)} />
            <div style={miniNode(60, 84, 15, 6, "var(--node-end)", 0.45)} />
            <div style={miniNode(38, 112, 15, 6, "var(--node-end)", 0.7)} />
            <div
              style={{
                position: "absolute",
                inset: "18px 12px 30px 4px",
                border: "1.5px solid var(--brand)",
                borderRadius: 3,
                opacity: 0.45,
              }}
            />
          </div>
        </div>

        {/* ---------- RIGHT PANEL ---------- */}
        <div
          style={{
            width: 340,
            flex: "none",
            background: "var(--bg-2)",
            borderLeft: "1px solid var(--line)",
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
            position: "relative",
            zIndex: 20,
          }}
        >
          {!isRun ? (
            <EditInspector />
          ) : (
            <RunInspector
              runStage={runStage}
              elapsed={elapsed}
              onApprove={() => setRunStage("approved")}
              onReject={() => setRunStage("rejected")}
            />
          )}
        </div>
      </div>

      {/* ===================== STATUS STRIP (run only) ===================== */}
      {isRun && <StatusStrip runStage={runStage} elapsed={elapsed} />}
    </div>
  );
}

/* ============================================================
   EDIT INSPECTOR — agent config
   ============================================================ */
function EditInspector() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        height: "100%",
      }}
    >
      <div
        style={{
          flex: "none",
          padding: "13px 15px",
          borderBottom: "1px solid var(--line)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <Chip
            accent="var(--node-agent)"
            name="agent"
            box={28}
            icon={15}
            radius={8}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)" }}>
              Classify email
            </div>
            <div
              className="mono"
              style={{ fontSize: 10, color: "var(--ink-3)" }}
            >
              agent · node_cls_7a2
            </div>
          </div>
          <button
            type="button"
            style={{
              width: 28,
              height: 28,
              borderRadius: 6,
              border: "1px solid var(--line)",
              background: "transparent",
              color: "var(--ink-2)",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Icon name="more" size={15} />
          </button>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "16px 15px 24px" }}>
        <div className="mono" style={{ ...SECTION_LABEL, marginBottom: 8 }}>
          Model
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            background: "var(--surface)",
            border: "1px solid var(--line-2)",
            borderRadius: 8,
            padding: "9px 11px",
            cursor: "pointer",
          }}
        >
          <span style={dot5("var(--node-agent)", 7)} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: "var(--ink)" }}>
              Claude Sonnet 4.5
            </div>
            <div
              className="mono"
              style={{ fontSize: 9.5, color: "var(--ink-3)" }}
            >
              anthropic · 200k ctx
            </div>
          </div>
          <Icon
            name="chevron-down"
            size={14}
            style={{ color: "var(--ink-2)" }}
          />
        </div>
        <div
          style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}
        >
          {["GPT-4o", "Gemini 2.5", "Local · Llama 3.1"].map((m) => (
            <span
              key={m}
              className="mono"
              style={{
                fontSize: 10.5,
                color: "var(--ink-2)",
                border: "1px solid var(--line)",
                background: "var(--surface)",
                padding: "3px 9px",
                borderRadius: 6,
                cursor: "pointer",
              }}
            >
              {m}
            </span>
          ))}
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginTop: 18,
            marginBottom: 9,
          }}
        >
          <span className="mono" style={SECTION_LABEL}>
            Temperature
          </span>
          <span className="mono" style={{ fontSize: 11, color: "var(--ink)" }}>
            0.20
          </span>
        </div>
        <div
          style={{
            height: 4,
            borderRadius: 3,
            background: "var(--line-2)",
            position: "relative",
          }}
        >
          <div
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              height: 4,
              width: "20%",
              borderRadius: 3,
              background: "var(--node-agent)",
            }}
          />
          <div
            style={{
              position: "absolute",
              left: "20%",
              top: "50%",
              transform: "translate(-50%,-50%)",
              width: 13,
              height: 13,
              borderRadius: "50%",
              background: "var(--ink)",
              border: "2px solid var(--node-agent)",
            }}
          />
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginTop: 20,
            marginBottom: 8,
          }}
        >
          <span className="mono" style={SECTION_LABEL}>
            System prompt
          </span>
          <span
            className="mono"
            style={{ fontSize: 10, color: "var(--ink-3)" }}
          >
            312 / 4k tok
          </span>
        </div>
        <div
          className="mono"
          style={{
            background: "var(--surface)",
            border: "1px solid var(--line-2)",
            borderRadius: 8,
            padding: "11px 12px",
            fontSize: 11.5,
            lineHeight: 1.6,
            color: "#bcc6d6",
          }}
        >
          You are a support triage classifier. Read the inbound email and assign
          exactly one{" "}
          <span style={{ color: "var(--node-router)" }}>category</span>.
          Estimate{" "}
          <span style={{ color: "var(--node-router)" }}>confidence</span> (0–1)
          and write a one-line{" "}
          <span style={{ color: "var(--node-router)" }}>summary</span>. Flag
          billing disputes over $25 for human review.
          <span
            style={{
              display: "inline-block",
              width: 7,
              height: 14,
              background: "var(--node-agent)",
              verticalAlign: "-2px",
              marginLeft: 1,
              animation: "naaryBlink 1.1s step-end infinite",
            }}
          />
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginTop: 20,
            marginBottom: 8,
          }}
        >
          <span className="mono" style={SECTION_LABEL}>
            Structured output
          </span>
          <span
            className="mono"
            style={{
              fontSize: 9.5,
              color: "var(--brand)",
              border:
                "1px solid color-mix(in srgb,var(--brand) 35%,transparent)",
              background: "color-mix(in srgb,var(--brand) 10%,transparent)",
              padding: "2px 7px",
              borderRadius: 5,
            }}
          >
            JSON Schema
          </span>
        </div>
        <div
          className="mono"
          style={{
            background: "#0a0d12",
            border: "1px solid var(--line-2)",
            borderRadius: 8,
            padding: "11px 12px",
            fontSize: 11,
            lineHeight: 1.65,
            overflowX: "auto",
          }}
        >
          <div style={{ color: "var(--ink-3)" }}>{"{"}</div>
          <div style={{ paddingLeft: 14 }}>
            <span style={{ color: "#7aa2e3" }}>"category"</span>
            <span style={{ color: "var(--ink-3)" }}>: </span>
            <span style={{ color: "#cf9b6c" }}>enum</span>
            <span style={{ color: "var(--ink-3)" }}>[</span>
            <span style={{ color: "#8fbf8f" }}>refund_request</span>
            <span style={{ color: "var(--ink-3)" }}>,</span>
          </div>
          <div style={{ paddingLeft: 64, color: "#8fbf8f" }}>
            general_inquiry<span style={{ color: "var(--ink-3)" }}>, </span>spam
            <span style={{ color: "var(--ink-3)" }}>],</span>
          </div>
          <div style={{ paddingLeft: 14 }}>
            <span style={{ color: "#7aa2e3" }}>"confidence"</span>
            <span style={{ color: "var(--ink-3)" }}>: </span>
            <span style={{ color: "#cf9b6c" }}>number</span>{" "}
            <span style={{ color: "var(--ink-3)" }}>(0..1),</span>
          </div>
          <div style={{ paddingLeft: 14 }}>
            <span style={{ color: "#7aa2e3" }}>"summary"</span>
            <span style={{ color: "var(--ink-3)" }}>: </span>
            <span style={{ color: "#cf9b6c" }}>string</span>{" "}
            <span style={{ color: "var(--ink-3)" }}>(max 140)</span>
          </div>
          <div style={{ color: "var(--ink-3)" }}>{"}"}</div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginTop: 20,
            marginBottom: 9,
          }}
        >
          <span className="mono" style={SECTION_LABEL}>
            Tool bindings
          </span>
          <span
            className="mono"
            style={{ fontSize: 10, color: "var(--ink-3)" }}
          >
            2 bound
          </span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          {[
            { name: "gmail.read_thread", sub: "MCP · google-workspace" },
            { name: "crm.lookup_customer", sub: "MCP · internal-crm" },
          ].map((t) => (
            <div
              key={t.name}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 9,
                background: "var(--surface)",
                border: "1px solid var(--line)",
                borderRadius: 8,
                padding: "8px 10px",
              }}
            >
              <Chip accent="var(--node-mcp)" name="plug" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  className="mono"
                  style={{ fontSize: 11.5, color: "var(--ink)" }}
                >
                  {t.name}
                </div>
                <div style={{ fontSize: 10, color: "var(--ink-3)" }}>
                  {t.sub}
                </div>
              </div>
              <button
                type="button"
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 5,
                  border: "none",
                  background: "transparent",
                  color: "var(--ink-3)",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Icon name="x" size={13} />
              </button>
            </div>
          ))}
          <button
            type="button"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 7,
              background: "transparent",
              border: "1px dashed var(--line-2)",
              borderRadius: 8,
              padding: 8,
              color: "var(--ink-2)",
              fontFamily: "var(--font-sans)",
              fontSize: 11.5,
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            <Icon name="plus" size={13} />
            Add tool binding
          </button>
        </div>

        <div
          className="mono"
          style={{ ...SECTION_LABEL, marginTop: 22, marginBottom: 9 }}
        >
          Run settings
        </div>
        <div
          style={{
            border: "1px solid var(--line)",
            borderRadius: 8,
            overflow: "hidden",
          }}
        >
          {[
            { k: "Max output tokens", v: "1,024", border: true },
            { k: "Timeout", v: "30s", border: true },
            { k: "Retries", v: "2 · exponential", border: false },
          ].map((r) => (
            <div
              key={r.k}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "9px 11px",
                borderBottom: r.border ? "1px solid var(--line)" : undefined,
              }}
            >
              <span style={{ fontSize: 12, color: "var(--ink-2)" }}>{r.k}</span>
              <span
                className="mono"
                style={{ fontSize: 11.5, color: "var(--ink)" }}
              >
                {r.v}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   RUN INSPECTOR — execution trace + stage card
   ============================================================ */
function RunInspector({
  runStage,
  elapsed,
  onApprove,
  onReject,
}: {
  runStage: RunStage;
  elapsed: number;
  onApprove: () => void;
  onReject: () => void;
}) {
  const isAwaiting = runStage === "awaiting";
  const isApproved = runStage === "approved";
  const isRejected = runStage === "rejected";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        height: "100%",
      }}
    >
      <div
        style={{
          flex: "none",
          padding: "13px 15px",
          borderBottom: "1px solid var(--line)",
          display: "flex",
          alignItems: "center",
          gap: 9,
        }}
      >
        <span
          style={{
            width: 28,
            height: 28,
            borderRadius: 8,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(226,168,68,.14)",
            color: "var(--state-paused)",
            flex: "none",
          }}
        >
          <Icon name="refresh" size={15} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)" }}>
            Run inspector
          </div>
          <div className="mono" style={{ fontSize: 10, color: "var(--ink-3)" }}>
            run rs_8f3a · v14
          </div>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "14px 15px 20px" }}>
        <div className="mono" style={{ ...SECTION_LABEL, marginBottom: 11 }}>
          Execution trace
        </div>

        <div style={{ position: "relative", paddingLeft: 22 }}>
          <div
            style={{
              position: "absolute",
              left: 7,
              top: 4,
              bottom: 14,
              width: 1.5,
              background: "var(--line-2)",
            }}
          />

          {/* step 1 */}
          <div style={{ position: "relative", marginBottom: 14 }}>
            <TraceDot kind="done" />
            <div style={traceTitle}>Email received</div>
            <div className="mono" style={traceNote}>
              webhook · 0ms
            </div>
          </div>

          {/* step 2 */}
          <div style={{ position: "relative", marginBottom: 14 }}>
            <TraceDot kind="done" />
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <div style={traceTitle}>Classify email</div>
              <span
                className="mono"
                style={{ fontSize: 10, color: "var(--ink-3)" }}
              >
                1.2s
              </span>
            </div>
            <div className="mono" style={traceNote}>
              agent · sonnet 4.5 · 1,840 tok · $0.0091
            </div>
            <div
              className="mono"
              style={{
                marginTop: 7,
                background: "#0a0d12",
                border: "1px solid var(--line)",
                borderRadius: 7,
                padding: "8px 10px",
                fontSize: 10.5,
                lineHeight: 1.6,
              }}
            >
              <div style={{ color: "var(--ink-3)" }}>output {"{"}</div>
              <div style={{ paddingLeft: 12 }}>
                <span style={{ color: "#7aa2e3" }}>category</span>:{" "}
                <span style={{ color: "#8fbf8f" }}>"refund_request"</span>,
              </div>
              <div style={{ paddingLeft: 12 }}>
                <span style={{ color: "#7aa2e3" }}>confidence</span>:{" "}
                <span style={{ color: "#cf9b6c" }}>0.94</span>,
              </div>
              <div style={{ paddingLeft: 12 }}>
                <span style={{ color: "#7aa2e3" }}>summary</span>:{" "}
                <span style={{ color: "#8fbf8f" }}>"double charge"</span>
              </div>
              <div style={{ color: "var(--ink-3)" }}>{"}"}</div>
            </div>
          </div>

          {/* step 3 */}
          <div style={{ position: "relative", marginBottom: 14 }}>
            <TraceDot kind="done" />
            <div style={traceTitle}>Route by category</div>
            <div className="mono" style={traceNote}>
              router · matched{" "}
              <span style={{ color: "#7fc99a" }}>refund_request</span> · 4ms
            </div>
          </div>

          {/* step 4 — approval (stateful) */}
          <div style={{ position: "relative", marginBottom: 14 }}>
            {isApproved ? (
              <TraceDot kind="done" />
            ) : isRejected ? (
              <TraceDot kind="error" />
            ) : (
              <TraceDot kind="awaiting" />
            )}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <div
                style={{
                  fontSize: 12.5,
                  fontWeight: 600,
                  color: isApproved
                    ? "var(--ink)"
                    : isRejected
                      ? "#f0908f"
                      : "#e9c281",
                }}
              >
                Approve refund
              </div>
              <span
                className="mono"
                style={{ fontSize: 10, color: "var(--ink-3)" }}
              >
                {isAwaiting ? fmtDur(elapsed) : "2h 14m"}
              </span>
            </div>
            <div className="mono" style={traceNote}>
              human approval ·{" "}
              {isApproved
                ? "approved by you"
                : isRejected
                  ? "rejected by you"
                  : "awaiting · paused"}
            </div>
          </div>

          {/* step 5 — end (stateful) */}
          <div style={{ position: "relative" }}>
            {isApproved ? (
              <TraceDot kind="done" />
            ) : isRejected ? (
              <TraceDot kind="dim" />
            ) : (
              <TraceDot kind="pending" />
            )}
            <div
              style={{
                fontSize: 12.5,
                fontWeight: 500,
                color: isApproved ? "var(--ink)" : "var(--ink-3)",
              }}
            >
              Ticket resolved
            </div>
            <div className="mono" style={traceNote}>
              {isApproved
                ? "end · refund issued · 0.3s"
                : isRejected
                  ? "end · not reached"
                  : "end · pending"}
            </div>
          </div>
        </div>

        {/* stage card */}
        {isAwaiting && (
          <div
            style={{
              marginTop: 18,
              border: "1px solid rgba(226,168,68,.38)",
              background: "rgba(226,168,68,.06)",
              borderRadius: 10,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                padding: "9px 12px",
                borderBottom: "1px solid rgba(226,168,68,.25)",
                display: "flex",
                alignItems: "center",
                gap: 7,
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: "var(--state-paused)",
                  animation: "naaryBlink 1.4s infinite",
                }}
              />
              <span
                className="mono"
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: ".08em",
                  color: "#e9c281",
                  textTransform: "uppercase",
                }}
              >
                Approval required
              </span>
            </div>
            <div style={{ padding: "11px 12px" }}>
              <div
                className="mono"
                style={{ fontSize: 10, color: "var(--ink-3)" }}
              >
                from
              </div>
              <div
                style={{ fontSize: 12.5, color: "var(--ink)", marginTop: 1 }}
              >
                m.alvarez@northwind.io
              </div>
              <div
                style={{
                  fontSize: 12.5,
                  color: "var(--ink-2)",
                  marginTop: 6,
                  lineHeight: 1.5,
                }}
              >
                “I was charged{" "}
                <span style={{ color: "var(--ink)", fontWeight: 600 }}>
                  $48.00
                </span>{" "}
                twice for the annual plan — please refund the duplicate.”
              </div>
              <div style={{ display: "flex", gap: 7, marginTop: 11 }}>
                <button
                  type="button"
                  onClick={onApprove}
                  style={{
                    flex: 1,
                    height: 34,
                    borderRadius: 8,
                    background: GREEN_GRAD,
                    border: "1px solid #2bbd66",
                    color: "#eafff2",
                    fontFamily: "var(--font-sans)",
                    fontSize: 12.5,
                    fontWeight: 600,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 7,
                    cursor: "pointer",
                  }}
                >
                  <CheckMark size={13} stroke="currentColor" sw={2.4} />
                  Approve refund
                </button>
                <button
                  type="button"
                  onClick={onReject}
                  style={{
                    flex: "none",
                    width: 96,
                    height: 34,
                    borderRadius: 8,
                    background: "transparent",
                    border: "1px solid rgba(227,87,97,.5)",
                    color: "#f0908f",
                    fontFamily: "var(--font-sans)",
                    fontSize: 12.5,
                    fontWeight: 600,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 6,
                    cursor: "pointer",
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                    <path
                      d="M6 6l12 12M18 6L6 18"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                    />
                  </svg>
                  Reject
                </button>
              </div>
            </div>
          </div>
        )}
        {isApproved && (
          <div
            style={{
              marginTop: 18,
              border:
                "1px solid color-mix(in srgb,var(--state-done) 45%,transparent)",
              background: "color-mix(in srgb,var(--state-done) 8%,transparent)",
              borderRadius: 10,
              padding: 12,
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            <span style={roundBadge("var(--state-done)")}>
              <CheckMark size={14} sw={2.6} />
            </span>
            <div>
              <div
                style={{ fontSize: 12.5, fontWeight: 600, color: "#9fe0b6" }}
              >
                Refund approved
              </div>
              <div
                className="mono"
                style={{ fontSize: 10, color: "var(--ink-3)", marginTop: 1 }}
              >
                run resumed · workflow completed
              </div>
            </div>
          </div>
        )}
        {isRejected && (
          <div
            style={{
              marginTop: 18,
              border: "1px solid rgba(227,87,97,.45)",
              background: "rgba(227,87,97,.07)",
              borderRadius: 10,
              padding: 12,
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            <span style={roundBadge("var(--state-error)")}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                <path
                  d="M6 6l12 12M18 6L6 18"
                  stroke="#1a0708"
                  strokeWidth="2.6"
                  strokeLinecap="round"
                />
              </svg>
            </span>
            <div>
              <div
                style={{ fontSize: 12.5, fontWeight: 600, color: "#f0908f" }}
              >
                Refund rejected
              </div>
              <div
                className="mono"
                style={{ fontSize: 10, color: "var(--ink-3)", marginTop: 1 }}
              >
                run halted · no downstream steps
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================================================
   STATUS STRIP
   ============================================================ */
function StatusStrip({
  runStage,
  elapsed,
}: {
  runStage: RunStage;
  elapsed: number;
}) {
  const isAwaiting = runStage === "awaiting";
  const isApproved = runStage === "approved";

  const runStatusText = isApproved
    ? "COMPLETED"
    : runStage === "rejected"
      ? "HALTED · REJECTED"
      : "PAUSED · AWAITING APPROVAL";
  const runStatusColor = isApproved
    ? "var(--state-done)"
    : runStage === "rejected"
      ? "var(--state-error)"
      : "var(--state-paused)";
  const stepText = isApproved ? "5 / 5" : "4 / 5";
  const costText = isApproved ? "$0.0173" : "$0.0142";
  const tokText = isApproved ? "4,010" : "3,240";
  const timerLabel = isAwaiting ? "Waiting" : "Duration";
  const waitLabel = isAwaiting ? fmtDur(elapsed) : "2h 14m 06s";

  const divider = (
    <div
      style={{
        width: 1,
        height: 20,
        background: "var(--line)",
        margin: "0 18px",
      }}
    />
  );
  const stripLabel: CSSProperties = {
    fontSize: 10,
    color: "var(--ink-3)",
    textTransform: "uppercase",
    letterSpacing: ".08em",
  };

  return (
    <div
      style={{
        height: 48,
        flex: "none",
        display: "flex",
        alignItems: "center",
        padding: "0 16px",
        background: "linear-gradient(180deg,#0d1015,#0b0d12)",
        borderTop: "1px solid var(--line)",
        position: "relative",
        zIndex: 40,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <span
          style={{
            width: 9,
            height: 9,
            borderRadius: "50%",
            background: runStatusColor,
            boxShadow: `0 0 9px ${runStatusColor}`,
            ...(isAwaiting
              ? { animation: "naaryBlink 1.4s ease-in-out infinite" }
              : {}),
          }}
        />
        <span
          className="mono"
          style={{
            fontSize: 11.5,
            fontWeight: 600,
            letterSpacing: ".04em",
            color: runStatusColor,
          }}
        >
          {runStatusText}
        </span>
      </div>
      {divider}

      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <span className="mono" style={stripLabel}>
          Step
        </span>
        <span
          className="mono"
          style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink)" }}
        >
          {stepText}
        </span>
      </div>
      {divider}

      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <span className="mono" style={stripLabel}>
          Cost
        </span>
        <span
          className="mono"
          style={{ fontSize: 12.5, fontWeight: 600, color: "#7fc99a" }}
        >
          {costText}
        </span>
        <span
          className="mono"
          style={{ fontSize: 10.5, color: "var(--ink-3)" }}
        >
          / {tokText} tok
        </span>
      </div>
      {divider}

      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <span className="mono" style={stripLabel}>
          {timerLabel}
        </span>
        <span
          className="mono"
          style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink)" }}
        >
          {waitLabel}
        </span>
      </div>

      <div
        style={{
          marginLeft: "auto",
          display: "flex",
          alignItems: "center",
          gap: 9,
        }}
      >
        <span
          className="mono"
          style={{ fontSize: 10.5, color: "var(--ink-3)" }}
        >
          durable · checkpointed
        </span>
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: "var(--state-done)",
          }}
        />
      </div>
    </div>
  );
}

/* ============================================================
   shared small bits
   ============================================================ */
function DoneBadge() {
  return (
    <span
      style={{
        width: 17,
        height: 17,
        borderRadius: "50%",
        background: "var(--state-done)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flex: "none",
      }}
    >
      <CheckMark />
    </span>
  );
}

type TraceKind = "done" | "error" | "awaiting" | "pending" | "dim";
function TraceDot({ kind }: { kind: TraceKind }) {
  const base: CSSProperties = {
    position: "absolute",
    left: -22,
    top: 1,
    width: 15,
    height: 15,
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "var(--font-mono)",
    fontSize: 9,
    fontWeight: 700,
  };
  if (kind === "done") {
    return (
      <span style={{ ...base, background: "var(--state-done)" }}>
        <CheckMark size={9} sw={3} />
      </span>
    );
  }
  if (kind === "error") {
    return (
      <span
        style={{ ...base, background: "var(--state-error)", color: "#1a0708" }}
      >
        ✕
      </span>
    );
  }
  if (kind === "awaiting") {
    return (
      <span
        style={{
          ...base,
          background: "var(--state-paused)",
          color: "#1a1305",
          animation: "naaryBlink 1.4s infinite",
        }}
      >
        ◷
      </span>
    );
  }
  if (kind === "dim") {
    return <span style={{ ...base, background: "var(--line-2)" }} />;
  }
  // pending
  return (
    <span
      style={{
        ...base,
        background: "transparent",
        border: "1.5px solid var(--line-2)",
      }}
    />
  );
}

/* ---------- style atoms ---------- */
const iconBtn: CSSProperties = {
  width: 32,
  height: 32,
  borderRadius: 7,
  background: "transparent",
  border: "1px solid var(--line)",
  color: "var(--ink-2)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
};

const zoomBtn: CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 6,
  border: "none",
  background: "transparent",
  color: "var(--ink-2)",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const nodeBase: CSSProperties = {
  position: "absolute",
  background: "var(--card)",
  borderRadius: 10,
  boxShadow: "0 10px 26px -14px rgba(0,0,0,.7)",
};

const nodeHead: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 8,
  padding: "9px 10px 6px",
};

const nodeTitle: CSSProperties = {
  fontSize: 12.5,
  fontWeight: 600,
  color: "var(--ink)",
};

const nodeBodyMono: CSSProperties = {
  padding: "0 10px 7px",
  fontSize: 9.5,
  color: "var(--ink-2)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const tagRow: CSSProperties = {
  display: "flex",
  gap: 5,
  padding: "0 10px",
  whiteSpace: "nowrap",
};

const routeLine: CSSProperties = {
  fontSize: 9.5,
  color: "var(--ink-2)",
};

const plainTag: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 9.5,
  fontWeight: 500,
  color: "var(--ink-2)",
  border: "1px solid var(--line-2)",
  padding: "2px 6px",
  borderRadius: 5,
};

function accentBar(color: string): CSSProperties {
  return { height: 2, background: color, borderRadius: "10px 10px 0 0" };
}

function accentTag(accent: string): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 4,
    fontFamily: "var(--font-mono)",
    fontSize: 9.5,
    fontWeight: 500,
    color: accent,
    border: `1px solid color-mix(in srgb, ${accent} 32%, transparent)`,
    background: `color-mix(in srgb, ${accent} 10%, transparent)`,
    padding: "2px 6px",
    borderRadius: 5,
  };
}

function dot5(color: string, size = 5): CSSProperties {
  return {
    width: size,
    height: size,
    borderRadius: "50%",
    background: color,
    flex: "none",
  };
}

function port({
  left,
  right,
  top,
  color,
  size = 11,
  fill = false,
  opacity,
}: {
  left?: number;
  right?: number;
  top: number;
  color: string;
  size?: number;
  fill?: boolean;
  opacity?: number;
}): CSSProperties {
  return {
    position: "absolute",
    left,
    right,
    top,
    width: size,
    height: size,
    borderRadius: "50%",
    background: fill ? color : "var(--bg)",
    border: `1.5px solid ${color}`,
    opacity,
  };
}

function roundBadge(bg: string): CSSProperties {
  return {
    width: 26,
    height: 26,
    borderRadius: "50%",
    background: bg,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flex: "none",
  };
}

function miniNode(
  top: number,
  left: number,
  w: number,
  h: number,
  bg: string,
  opacity: number,
): CSSProperties {
  return {
    position: "absolute",
    top,
    left,
    width: w,
    height: h,
    borderRadius: 2,
    background: bg,
    opacity,
  };
}

const traceTitle: CSSProperties = {
  fontSize: 12.5,
  fontWeight: 500,
  color: "var(--ink)",
};

const traceNote: CSSProperties = {
  fontSize: 10,
  color: "var(--ink-3)",
  marginTop: 2,
};
