/**
 * Build with AI — the right-hand live canvas stage (design "Naary AI Generate").
 * Dotted grid + ambient wash; empty state until the first frame; streamed nodes
 * animate in (scale/glow), edges draw as beziers with branch-label chips, and
 * the freshly-added node carries a spinner + ember pulse while building.
 */
import { Icon } from "../../../components";
import {
  NODE_H,
  NODE_W,
  STAGE_W,
  type StageEdge,
  type StageNode,
  stageHeight,
} from "./model";

export function CanvasStage({
  nodes,
  edges,
  streaming,
  compact,
}: {
  nodes: StageNode[];
  edges: StageEdge[];
  /** True while a turn's SSE is mid-flight — last node pulses, edges flow. */
  streaming: boolean;
  /** Stacked (narrow) layout: the stage sits below the conversation. */
  compact?: boolean;
}) {
  const empty = nodes.length === 0;
  const h = stageHeight(nodes.length);
  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: compact ? 380 : 0,
        position: "relative",
        overflow: "auto",
        background:
          "radial-gradient(120% 90% at 25% 0%, var(--grad-a), var(--bg) 60%)",
      }}
    >
      {/* dotted grid */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage:
            "radial-gradient(circle, var(--grid) 1.1px, transparent 1.1px)",
          backgroundSize: "26px 26px",
          opacity: 0.5,
          pointerEvents: "none",
        }}
      />

      {empty ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 16,
            textAlign: "center",
            padding: 40,
          }}
        >
          <div
            style={{
              width: 64,
              height: 64,
              borderRadius: 17,
              border: "1px solid var(--line-2)",
              background: "var(--card)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--ink-faint)",
            }}
          >
            <Icon name="agent" size={30} strokeWidth={1.5} />
          </div>
          <div>
            <div
              style={{
                fontSize: 15,
                fontWeight: "var(--weight-semibold)",
                color: "var(--ink-soft)",
              }}
            >
              Your workflow will build here
            </div>
            <div
              style={{
                fontSize: "var(--text-body)",
                color: "var(--ink-faint)",
                marginTop: 5,
                maxWidth: 320,
                lineHeight: 1.5,
              }}
            >
              Describe the goal on the left and watch Naary lay out the nodes,
              live.
            </div>
          </div>
        </div>
      ) : (
        <div
          style={{
            position: "relative",
            width: STAGE_W,
            height: h,
            margin: "16px auto 40px",
          }}
        >
          <svg
            viewBox={`0 0 ${STAGE_W} ${h}`}
            width={STAGE_W}
            height={h}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              pointerEvents: "none",
              overflow: "visible",
              zIndex: 0,
            }}
          >
            {edges.map((e) => (
              <path
                key={e.id}
                d={e.d}
                fill="none"
                stroke={e.color}
                strokeWidth={2.4}
                strokeLinecap="round"
                strokeDasharray={e.dashed || streaming ? "6 6" : "0"}
                style={{
                  animation: `bwaLineIn .3s ease${
                    streaming ? ", naaryDash 1s linear infinite" : ""
                  }`,
                }}
              />
            ))}
          </svg>

          {/* branch label chips (real edge conditions) */}
          {edges
            .filter((e) => e.label)
            .map((e) => (
              <div
                key={`${e.id}-label`}
                className="mono"
                style={{
                  position: "absolute",
                  left: (e.lx ?? 0) - 30,
                  top: (e.ly ?? 0) - 10,
                  fontSize: "var(--text-2xs)",
                  color: "var(--node-router)",
                  background: "var(--bg)",
                  border: "1px solid var(--node-router)",
                  borderRadius: 6,
                  padding: "2px 7px",
                  zIndex: 2,
                  maxWidth: 180,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  animation: "bwaLineIn .3s ease",
                }}
              >
                {e.label}
              </div>
            ))}

          {nodes.map((n, i) => {
            const fresh = streaming && i === nodes.length - 1;
            return (
              <div
                key={n.id}
                style={{
                  position: "absolute",
                  left: n.x,
                  top: n.y,
                  width: NODE_W,
                  height: NODE_H,
                  borderRadius: 14,
                  border: `1px solid ${fresh ? "var(--brand)" : "var(--line-2)"}`,
                  background: "var(--card)",
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "0 13px",
                  boxShadow: "var(--shadow-card)",
                  zIndex: 1,
                  animation: `bwaNodeIn .32s cubic-bezier(.2,.9,.3,1.3)${
                    fresh ? ", bwaGlowPulse 1.4s ease-in-out infinite" : ""
                  }`,
                }}
              >
                <div
                  style={{
                    width: 34,
                    height: 34,
                    flex: "none",
                    borderRadius: "var(--radius-md)",
                    border: `1px solid ${n.accent}`,
                    color: n.accent,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Icon name={n.icon} size={17} strokeWidth={1.8} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: "var(--text-sm)",
                      fontWeight: "var(--weight-semibold)",
                      color: "var(--ink)",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {n.name}
                  </div>
                  <div
                    style={{
                      fontSize: "var(--text-2xs)",
                      color: "var(--ink-faint)",
                      marginTop: 1,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {n.sub}
                  </div>
                </div>
                {fresh && (
                  <span
                    aria-hidden
                    style={{
                      width: 16,
                      height: 16,
                      flex: "none",
                      border: "2px solid var(--surface)",
                      borderTopColor: "var(--brand)",
                      borderRadius: "50%",
                      display: "inline-block",
                      animation: "naarySpin .7s linear infinite",
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
