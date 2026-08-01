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
import { type EditTarget, renameNotice } from "./edit-target";
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
  /** The workflow this chat EDITS (`?key=`), or null for a from-scratch build. */
  editing: EditTarget | null;
  /**
   * `?key=` is present but the binding hasn't resolved yet — DERIVED by the container, not stored.
   *
   * It gates the composer, and that gate is load-bearing: a turn sent in this window would open a
   * session with no `workflowKey`, which makes it a from-scratch CREATE and makes the save a
   * slugified fork of the user's workflow. Waiting for one round trip is the whole fix.
   */
  seeding: boolean;
  /** The binding is real but the workflow couldn't be read (deleted, wrong env, failed fetch). */
  editProblem: string | null;
  /** Save-time refusal: the draft can't be shown to descend from what's saved now (#874). */
  staleWarning: string | null;
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
  editing: null,
  seeding: false,
  editProblem: null,
  staleWarning: null,
};

/**
 * "You are editing THIS workflow" — a persistent strip under the header, not a one-off toast.
 *
 * The canvas AI panel's version of this failure (#874) was reported as *"it rewrote the whole
 * workflow"*: the panel gave no indication of what a turn was operating on, so a faithful edit and
 * a from-scratch replacement looked identical. The binding is therefore stated continuously, with
 * the three facts a user needs to trust the next Save — which workflow, which version it descends
 * from, and what saving will produce — plus the rename, if the draft changed the name.
 */
function EditBanner({
  editing,
  draftName,
  problem,
}: {
  editing: EditTarget;
  draftName: string | null;
  problem: string | null;
}) {
  const rename = renameNotice(editing, draftName);
  const nextVersion =
    editing.baseVersion !== null
      ? `v${editing.baseVersion + 1}`
      : "a new version";
  return (
    <div
      style={{
        flex: "none",
        display: "flex",
        alignItems: "center",
        gap: 10,
        flexWrap: "wrap",
        padding: "9px 20px",
        borderBottom: "1px solid var(--line)",
        background: problem ? "var(--error-soft)" : "var(--brand-soft)",
      }}
    >
      <Icon
        name={problem ? "alert" : "edit"}
        size={14}
        strokeWidth={1.8}
        style={{
          flex: "none",
          color: problem ? "var(--state-error)" : "var(--brand-2)",
        }}
      />
      <span
        style={{
          fontSize: "var(--text-sm)",
          fontWeight: "var(--weight-semibold)",
          color: "var(--ink)",
        }}
      >
        Editing “{editing.name}”
      </span>
      <span
        className="mono"
        style={{ fontSize: "var(--text-2xs)", color: "var(--ink-3)" }}
      >
        {editing.workflowKey}
        {editing.baseVersion !== null ? ` · v${editing.baseVersion}` : ""}
      </span>
      <span
        style={{
          flex: "1 1 260px",
          minWidth: 0,
          fontSize: "var(--text-xs)",
          lineHeight: 1.45,
          color: problem ? "var(--state-error)" : "var(--ink-2)",
        }}
      >
        {problem ??
          `Every message changes this workflow. Saving publishes ${nextVersion} — its run history, schedules and webhook URLs stay.`}
        {rename ? ` ${rename}` : ""}
      </span>
    </div>
  );
}

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
  onConfirmStale,
  onDismissStale,
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
  /** "Save anyway" on a stale-draft warning. */
  onConfirmStale: () => void;
  onDismissStale: () => void;
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
    editing,
    seeding,
    editProblem,
    staleWarning,
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
            {editing ? "editing a workflow · beta" : "conversational · beta"}
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

      {editing && (
        <EditBanner editing={editing} draftName={name} problem={editProblem} />
      )}

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
          editing={editing}
          seeding={seeding}
          staleWarning={staleWarning}
          onSend={onSend}
          providerOptions={providerOptions}
          provider={provider}
          onProvider={onProvider}
          providerHint={providerHint}
          onResume={onResume}
          onAccept={onOpenInCanvas}
          onConfirmStale={onConfirmStale}
          onDismissStale={onDismissStale}
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
