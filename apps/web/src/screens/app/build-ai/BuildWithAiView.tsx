/**
 * Build with AI — the presentational shell (header with the status pill, the
 * conversation column, the live canvas stage). All state is injected, so the
 * route container (../BuildWithAi.tsx) owns the session/SSE I/O and stories can
 * render any mid-stream moment. Kept OUT of the route module so the router's
 * lazy() helper (which types modules as zero-prop components) stays happy.
 */
import type { EdgeDef, NodeDef } from "@naary/dsl";
import { Icon } from "../../../components";
import type { BuilderSessionSummary } from "../../../lib/api/builder";
import {
  BELOW_RAIL_QUERY,
  PHONE_QUERY,
  useMediaQuery,
} from "../../../lib/useMediaQuery";
import { CanvasStage } from "./CanvasStage";
import type { AiBuilderProvider, ProviderOption } from "./providers";
import {
  type BuildPhase,
  type ChatMsg,
  ConversationPanel,
} from "./ConversationPanel";
import { layoutEdges, layoutNodes, planFromStream } from "./model";

/** Scoped keyframes (screen-local; tokens.css stays untouched). */
const KEYFRAMES = `
@keyframes bwaNodeIn{from{opacity:0;transform:scale(.85) translateY(6px)}to{opacity:1;transform:scale(1) translateY(0)}}
@keyframes bwaGlowPulse{0%,100%{box-shadow:0 0 0 1px rgba(242,98,46,.3),0 10px 30px -14px rgba(242,98,46,.5)}50%{box-shadow:0 0 0 1px rgba(242,98,46,.5),0 14px 40px -12px rgba(242,98,46,.7)}}
@keyframes bwaLineIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
@keyframes bwaDotp{0%,80%,100%{opacity:.25;transform:translateY(0)}40%{opacity:1;transform:translateY(-2px)}}
.bwa-chip{transition:border-color .14s,background .14s}
.bwa-chip:hover{border-color:var(--brand) !important;background:var(--surface) !important}
`;

/** Everything the view renders — the container owns it; stories inject it. */
export interface BuildWithAiState {
  phase: BuildPhase;
  messages: ChatMsg[];
  /** Turn accepted, no frame yet (typing dots). */
  typing: boolean;
  /** Workflow name from the meta/result frame. */
  name: string | null;
  /** Live-streamed elements of the CURRENT turn (reconciled to the result frame). */
  streamNodes: NodeDef[];
  streamEdges: EdgeDef[];
  /** True once the current turn produced its first node/edge frame. */
  gotFrame: boolean;
  error: string | null;
  resumables: BuilderSessionSummary[] | null;
  opening: boolean;
}

export const INITIAL_BUILD_STATE: BuildWithAiState = {
  phase: "idle",
  messages: [],
  typing: false,
  name: null,
  streamNodes: [],
  streamEdges: [],
  gotFrame: false,
  error: null,
  resumables: null,
  opening: false,
};

/** Presentational shell — header (status pill) + conversation + live stage. */
export function BuildWithAiView({
  state,
  onSend,
  providerOptions,
  provider,
  onProvider,
  providerHint,
  onResume,
  onOpenInCanvas,
  onReset,
}: {
  state: BuildWithAiState;
  onSend: (text: string) => void;
  /** Model/agent selection for the next turn — see ./providers. */
  providerOptions: ProviderOption[];
  provider: AiBuilderProvider | null;
  onProvider: (next: AiBuilderProvider | null) => void;
  providerHint: string | null;
  onResume: (id: string) => void;
  onOpenInCanvas: () => void;
  onReset: () => void;
}) {
  const compact = useMediaQuery(BELOW_RAIL_QUERY);
  const phone = useMediaQuery(PHONE_QUERY);
  const {
    phase,
    messages,
    typing,
    name,
    streamNodes,
    streamEdges,
    gotFrame,
    error,
    resumables,
    opening,
  } = state;

  const streaming = phase === "streaming";
  const ready = phase === "ready";
  const stageNodes = layoutNodes(streamNodes);
  const stageEdges = layoutEdges(streamEdges, stageNodes);
  const plan =
    gotFrame || ready
      ? planFromStream(name, streamNodes, streamEdges.length, ready)
      : null;

  const pill = streaming
    ? {
        text: "Building",
        fg: "var(--brand-2)",
        bg: "var(--brand-soft)",
        bd: "var(--line-2)",
        blink: true,
      }
    : ready
      ? {
          text: "Draft ready",
          fg: "var(--state-done)",
          bg: "var(--done-soft)",
          bd: "color-mix(in srgb, var(--state-done) 45%, transparent)",
          blink: false,
        }
      : {
          text: "Ready",
          fg: "var(--ink-faint)",
          bg: "transparent",
          bd: "var(--line-2)",
          blink: false,
        };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        // Shell chrome: 52px context bar + 44px breadcrumb (Approvals precedent).
        height: compact ? undefined : "calc(100vh - 96px)",
        minHeight: compact ? "calc(100vh - 96px)" : undefined,
      }}
    >
      <style>{KEYFRAMES}</style>

      {/* screen header — title, beta tag, status pill, new chat */}
      <div
        style={{
          flex: "none",
          height: 54,
          borderBottom: "1px solid var(--line)",
          background: "var(--panel)",
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "0 20px",
        }}
      >
        <div
          style={{
            fontSize: "var(--text-md)",
            fontWeight: "var(--weight-semibold)",
            color: "var(--ink)",
          }}
        >
          Build with AI
        </div>
        {/* Beta tag drops on phones so the header (title · pill · new-chat)
            never overflows horizontally on a narrow screen. */}
        {!phone && (
          <span
            className="mono"
            style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}
          >
            conversational · beta
          </span>
        )}
        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              fontSize: "var(--text-xs)",
              fontWeight: "var(--weight-semibold)",
              color: pill.fg,
              background: pill.bg,
              border: `1px solid ${pill.bd}`,
              borderRadius: "var(--radius-pill)",
              padding: "5px 12px",
            }}
          >
            <span
              aria-hidden
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: pill.fg,
                animation: pill.blink
                  ? "naaryBlink 1s step-end infinite"
                  : undefined,
              }}
            />
            {pill.text}
          </span>
          <button
            type="button"
            onClick={onReset}
            title="New chat"
            style={{
              width: compact ? 44 : 34,
              height: compact ? 44 : 34,
              borderRadius: "var(--radius-md)",
              border: "1px solid var(--line-2)",
              background: "var(--card)",
              color: "var(--ink-2)",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Icon name="plus" size={15} strokeWidth={1.9} />
          </button>
        </div>
      </div>

      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: compact ? "column" : "row",
          minHeight: 0,
        }}
      >
        <ConversationPanel
          phase={phase}
          messages={messages}
          typing={typing}
          plan={plan}
          error={error}
          resumables={resumables}
          opening={opening}
          onSend={onSend}
          providerOptions={providerOptions}
          provider={provider}
          onProvider={onProvider}
          providerHint={providerHint}
          onResume={onResume}
          onOpenInCanvas={onOpenInCanvas}
          compact={compact}
        />
        <CanvasStage
          nodes={stageNodes}
          edges={stageEdges}
          streaming={streaming}
          compact={compact}
        />
      </div>
    </div>
  );
}
