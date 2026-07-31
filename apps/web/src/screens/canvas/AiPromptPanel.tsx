// AI workflow-builder panel: describe a flow in plain English → an agent drafts it onto
// the canvas. Shown under the top bar when toggled (extracted verbatim from CanvasPage).
import { Button, Spinner } from "../../components";
import { PROVIDERS } from "./fields";
import type { AiMode } from "./useAiBuilder";
import type { FixStage } from "./useFixFromRun";

/** What the panel says when the prompt below was written FROM a failed run (`?fix=<runId>`). */
export interface FixNotice {
  runId: string;
  /** The run executed an older version than the one on the canvas — see useFixFromRun. */
  drift: { runVersion: number; currentVersion: number } | null;
  /** Whose step outputs are included in the prompt. Named, not summarised as a count. */
  includedNodeIds: string[];
  /** Why the description couldn't be built, when it couldn't. */
  error: string | null;
  /** How far along the description is (see useFixFromRun) — the box is empty until `done`. */
  stage: FixStage;
  /**
   * Why the canvas has no graph, when `stage` is `blocked`. Two different situations reach that
   * stage — nothing on the canvas at all, and a canvas that doesn't compile — and only one of
   * them is "there's no workflow here". Building this feature hit the second twice.
   */
  canvasError?: string | null;
}

/**
 * What is being waited on, in the user's terms.
 *
 * Two separate waits, named separately rather than collapsed into "Loading…": the canvas has to
 * load before the failure can be described AGAINST it, and then the run itself has to be read.
 * Which one is taking the time is the only thing a progress line can usefully tell someone.
 */
const STAGE_LABEL: Partial<Record<FixStage, string>> = {
  "loading-canvas": "Opening the workflow…",
  "reading-run":
    "Reading the run — the error, the step that failed, and what that step received.",
};

/**
 * The "this came from a failed run" header.
 *
 * It names what is about to leave the tenant. The prompt below is going to a model and it carries
 * the failing step's configuration and the outputs of the steps it read — so the steps are LISTED
 * rather than counted. "Includes output from 2 steps" is not something a user can check; "includes
 * output from pagerduty, lookup" is, and the prompt is right there to read in full.
 */
function FixNoticeBanner({ notice }: { notice: FixNotice }) {
  const waiting = STAGE_LABEL[notice.stage];
  return (
    <div
      style={{
        marginBottom: 10,
        padding: "9px 11px",
        borderRadius: "var(--radius-md)",
        border: "1px solid var(--line-2)",
        background: "var(--card)",
        fontSize: "var(--text-xs)",
        color: "var(--ink-3)",
        lineHeight: 1.55,
      }}
    >
      <div style={{ color: "var(--ink-2)" }}>
        Describing the failure from run{" "}
        <span className="mono">{notice.runId}</span>
        {/* "Read it below" is only true once there IS something below. Until then the sentence
            would be pointing at an empty box, which is the state being fixed here — and on the
            `blocked` stage nothing is ever going to be there, so it stays off for that too. */}
        {notice.stage === "done"
          ? ". Read it below and edit anything before generating."
          : waiting
            ? "…"
            : "."}
      </div>

      {/* The wait, named. Both stages are real and neither is instant: the canvas has to load
          before the failure can be described against it, then the run has to be read. */}
      {waiting && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 6,
            color: "var(--ink-3)",
          }}
        >
          <Spinner size={13} />
          {waiting}
        </div>
      )}

      {/* Terminal, not a wait: the canvas finished loading and still has no workflow to change,
          so no description is coming. Saying so beats a spinner that never resolves. */}
      {notice.stage === "blocked" && (
        <div style={{ color: "var(--state-paused)", marginTop: 5 }}>
          {notice.canvasError
            ? // The workflow IS here, it just doesn't compile — so the failing step can't be
              // described against it. Naming the compile error makes it fixable; "there's no
              // workflow on the canvas" would be a plainly false statement about a visible one.
              `The canvas doesn't compile — ${notice.canvasError} — so that run couldn't be described here. Fix that, or say what you'd like changed.`
            : "There's no workflow on the canvas to change, so that run couldn't be described here — say what you'd like changed instead."}
        </div>
      )}

      {notice.error && (
        <div style={{ color: "var(--state-paused)", marginTop: 5 }}>
          {notice.error}
        </div>
      )}

      {/* Decision 1: the fix targets the CURRENT version. When the run used an older one, say so
          — the description may name a step that has since changed, and a diff against a version
          nobody runs would be worse than an honest warning. */}
      {notice.drift && (
        <div style={{ color: "var(--state-paused)", marginTop: 5 }}>
          That run used v{notice.drift.runVersion}; this workflow is now v
          {notice.drift.currentVersion}. The fix applies to v
          {notice.drift.currentVersion}, so check it still matches what failed.
        </div>
      )}

      {notice.includedNodeIds.length > 0 && (
        <div style={{ marginTop: 5 }}>
          Sends this workflow, the failing step and its error, plus output from{" "}
          <span className="mono">{notice.includedNodeIds.join(", ")}</span> —
          the steps it reads from. No other step output, variables or secrets.
        </div>
      )}
    </div>
  );
}

export function AiPromptPanel({
  aiPrompt,
  onPromptChange,
  genProvider,
  onProviderChange,
  aiMode,
  onModeChange,
  canEdit,
  generating,
  onGenerate,
  fixNotice,
}: {
  aiPrompt: string;
  onPromptChange: (v: string) => void;
  genProvider: string;
  onProviderChange: (v: string) => void;
  /** Change what's on the canvas, or replace it. */
  aiMode: AiMode;
  onModeChange: (m: AiMode) => void;
  /** Whether there's a compilable workflow to change — no canvas, nothing to edit. */
  canEdit: boolean;
  generating: boolean;
  onGenerate: () => void;
  /** Set when the user arrived from a failed run (`?fix=`); null otherwise. */
  fixNotice?: FixNotice | null;
}) {
  const editing = aiMode === "edit";
  return (
    <div
      style={{
        padding: "12px 16px",
        borderBottom: "1px solid var(--line)",
        background: "var(--surface)",
      }}
    >
      {fixNotice && <FixNoticeBanner notice={fixNotice} />}
      {canEdit && (
        <div
          role="radiogroup"
          aria-label="What the agent should do"
          style={{ display: "flex", gap: 6, marginBottom: 8 }}
        >
          {(
            [
              ["edit", "Change this workflow"],
              ["create", "Start a new one"],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={aiMode === m}
              disabled={generating}
              onClick={() => onModeChange(m)}
              style={{
                padding: "5px 10px",
                borderRadius: "var(--radius-md)",
                // --brand / --brand-soft are the real tokens (tokens.css); the selected chip
                // must read as selected AT A GLANCE, since it's what says whether Generate
                // is about to amend the canvas or overwrite it.
                border: `1px solid ${aiMode === m ? "var(--brand)" : "var(--line)"}`,
                background: aiMode === m ? "var(--brand-soft)" : "var(--card)",
                color: aiMode === m ? "var(--brand)" : "var(--ink-2)",
                fontWeight: aiMode === m ? "var(--weight-medium)" : "inherit",
                fontSize: "var(--text-xs)",
                fontFamily: "inherit",
                cursor: generating ? "default" : "pointer",
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <div
        style={{
          fontSize: "var(--text-xs)",
          color: "var(--ink-3)",
          marginBottom: 6,
        }}
      >
        {editing
          ? "Describe the change in plain English — an agent applies it to the workflow on the canvas and leaves the rest alone. (Uses your model provider key from Integrations.)"
          : "Describe the workflow in plain English — an agent drafts it onto the canvas for you to edit. (Uses your model provider key from Integrations.)"}
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
        <textarea
          value={aiPrompt}
          onChange={(e) => onPromptChange(e.target.value)}
          placeholder={
            // Still being written: say so IN the box, so the empty box isn't the only answer
            // during the wait. You can type over it — the description is a starting point.
            fixNotice && STAGE_LABEL[fixNotice.stage]
              ? "The failure is being written up here — or describe the change yourself."
              : editing
                ? "e.g. If there are no open incidents, end the run instead of failing."
                : "e.g. When a webhook comes in, have an agent summarize it, wait for my approval, then email the summary to my team."
          }
          // 2 rows suits a sentence someone types. A prefilled fix description is ~15 lines, and
          // the banner above it says "read it below and edit anything before generating" — which
          // is not an instruction you can follow through a 2-row window. Taller for the whole fix
          // path, including the wait, so the panel doesn't jump under the user the moment the
          // description lands; the ordinary panel keeps its compact shape.
          rows={fixNotice ? 12 : 2}
          disabled={generating}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") onGenerate();
          }}
          style={{
            flex: 1,
            resize: "vertical",
            padding: "8px 10px",
            borderRadius: "var(--radius-md)",
            border: "1px solid var(--line)",
            background: "var(--card)",
            color: "var(--ink)",
            fontSize: "var(--text-body)",
            fontFamily: "inherit",
          }}
        />
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <select
            value={genProvider}
            onChange={(e) => onProviderChange(e.target.value)}
            disabled={generating}
            title="Model provider for generation"
            style={{
              padding: "7px 8px",
              borderRadius: "var(--radius-md)",
              border: "1px solid var(--line)",
              background: "var(--card)",
              color: "var(--ink)",
              fontSize: "var(--text-sm)",
              fontFamily: "inherit",
            }}
          >
            <option value="">Auto</option>
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <Button
            variant="primary"
            disabled={generating || aiPrompt.trim().length < 3}
            onClick={onGenerate}
          >
            {generating
              ? editing
                ? "Applying…"
                : "Generating…"
              : editing
                ? "Apply change"
                : "Generate"}
          </Button>
        </div>
      </div>
      <div
        style={{
          fontSize: "var(--text-2xs)",
          color: "var(--ink-3)",
          marginTop: 4,
        }}
      >
        {editing
          ? "Keeps this workflow — Save writes its next version. ⌘/Ctrl+Enter to apply."
          : "Replaces the current canvas with a new draft. ⌘/Ctrl+Enter to generate."}
      </div>
    </div>
  );
}
