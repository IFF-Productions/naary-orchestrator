/**
 * The canvas's "Build with AI" panel — a strip under the top bar that holds the SAME conversation
 * as the Build with AI screen (#1003).
 *
 * It was a one-shot form for its whole life: one textarea, one provider `<select>`, one Generate
 * button. Ask for a change, get a graph, and to refine it you retyped the request. Meanwhile the
 * screen at /app/build-ai had grown a real conversation — thread, assistant summaries, per-turn
 * cost, quick replies — on a backend the canvas could not use, because a builder session edits the
 * graph the SERVER holds and the canvas's truth is what is on screen, unsaved edits and all.
 *
 * So this file is now a thin canvas-shaped wrapper around that screen's `ConversationPanel` rather
 * than a second conversation UI. Everything canvas-specific lives HERE and is passed in: the
 * `?fix=<runId>` disclosure banner, the edit-vs-create chooser, and a header with the build status
 * and "New chat". The thread, composer, plan card, quick replies and provider picker are the
 * shared component's — which is the point, because two components that merely look alike drift.
 */
import { Icon, Spinner } from "../../components";
import { BELOW_RAIL_QUERY, useMediaQuery } from "../../lib/useMediaQuery";
import {
  type BuildPhase,
  type ChatMsg,
  ConversationPanel,
} from "../app/build-ai/ConversationPanel";
import type { PlanLine } from "../app/build-ai/model";
import type {
  AiBuilderProvider,
  ProviderOption,
} from "../app/build-ai/providers";
import type { AiMode } from "./useAiBuilder";
import { blockedReason, type FixStage } from "./useFixFromRun";

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
   * The workflow could not be OPENED, when `stage` is `blocked` (#1006). Read FIRST of the two,
   * because the canvas is not empty in this case and it compiles: the fetch failed, so the nodes
   * were never replaced and the SEED graph (start → approval → end) is still mounted. Both of the
   * sentences below are false about it.
   */
  canvasLoadFailed?: boolean;
  /**
   * Why the canvas has no graph, when `stage` is `blocked`. THREE different situations reach that
   * stage — the workflow failed to open, nothing is on the canvas at all, and a canvas that
   * doesn't compile — and only one of them is "there's no workflow here". Building this feature
   * hit the compile one twice, and the failed open is #1006.
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
 * Is the fix description still being WRITTEN INTO the composer?
 *
 * Exported because it is the condition behind `readOnly` on the composer, and getting it wrong is
 * invisible in either direction: too eager and the user cannot type at all, too late and what they
 * typed is silently replaced the moment the run comes back (the bug `fix-with-ai.spec.ts` guards).
 */
export function fixIsWriting(notice: FixNotice | null | undefined): boolean {
  return Boolean(notice && STAGE_LABEL[notice.stage]);
}

/**
 * The "this came from a failed run" header.
 *
 * It names what is about to leave the tenant. The message below is going to a model and it carries
 * the failing step's configuration, the run's trigger input, and the output of the steps that ran
 * — so the steps are LISTED rather than counted OR characterised. "Includes output from 9 steps"
 * is not something a user can check; "includes output from pagerduty, lookup, …" is, and the
 * message is right there to read in full.
 *
 * The list is also the only formulation that stays TRUE. `buildFixInstruction` drops steps when
 * the section exceeds its size budget, so any sentence of the form "every step that ran" is a
 * claim this component cannot keep — and it would be false about precisely the disclosure it is
 * making. `includedNodeIds` is what actually went, so that is what it names.
 */
function FixNoticeBanner({
  notice,
  hasPrompt,
}: {
  notice: FixNotice;
  /** Is there actually a description in the box? Not every `done` produces one. */
  hasPrompt: boolean;
}) {
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
        {/* "Read it below" is only true once there IS something below — asserted against the box
            itself rather than against the stage. `done` does not imply a description: a run whose
            outputs couldn't be read finishes with a stated reason and an EMPTY box, and pointing
            that user at it is the same confusion this whole change is fixing. */}
        {hasPrompt
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
          {blockedReason(notice)}
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
          {/* NAMES the steps rather than characterising the set. "every step that ran" was a
              claim this component cannot keep: the instruction drops steps when the section
              exceeds its size budget, so on a large run the sentence would have been false about
              the very thing it exists to disclose. The list is exact by construction. */}
          Sends this workflow, the failing step and its error, the input that
          started the run, and output from{" "}
          <span className="mono">{notice.includedNodeIds.join(", ")}</span>. No
          variables or secrets.
        </div>
      )}
    </div>
  );
}

/**
 * "Change this workflow" / "Start a new one" — KEPT, and more load-bearing than before.
 *
 * A conversation is a sequence of small asks, which makes it easier, not harder, to reach a turn
 * that quietly replaces everything: the natural follow-up to a build is "now add an approval step",
 * and the difference between amending the canvas and re-inventing it is invisible until it has
 * happened. It sits directly above the composer for that reason — it qualifies the message the
 * user is about to send, so it belongs next to Send rather than in a settings panel.
 */
function ModeChooser({
  aiMode,
  onModeChange,
  disabled,
}: {
  aiMode: AiMode;
  onModeChange: (m: AiMode) => void;
  disabled: boolean;
}) {
  return (
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
          disabled={disabled}
          onClick={() => onModeChange(m)}
          style={{
            padding: "5px 10px",
            borderRadius: "var(--radius-md)",
            // --brand / --brand-soft are the real tokens (tokens.css); the selected chip
            // must read as selected AT A GLANCE, since it's what says whether the next message
            // is about to amend the canvas or overwrite it.
            border: `1px solid ${aiMode === m ? "var(--brand)" : "var(--line)"}`,
            background: aiMode === m ? "var(--brand-soft)" : "var(--card)",
            color: aiMode === m ? "var(--brand)" : "var(--ink-2)",
            fontWeight: aiMode === m ? "var(--weight-medium)" : "inherit",
            fontSize: "var(--text-xs)",
            fontFamily: "inherit",
            cursor: disabled ? "default" : "pointer",
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/**
 * Header strip: what the build is doing right now, and a way to start over.
 *
 * Mirrors the Build with AI screen's header, minus the title — the top bar's own "Build with AI"
 * button sits directly above this strip, and naming the panel a second time says nothing.
 */
function PanelHeader({
  phase,
  onReset,
  compact,
}: {
  phase: BuildPhase;
  onReset: () => void;
  compact: boolean;
}) {
  const pill =
    phase === "streaming"
      ? {
          text: "Building",
          fg: "var(--brand-2)",
          bg: "var(--brand-soft)",
          bd: "var(--line-2)",
          blink: true,
        }
      : phase === "ready"
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
        flex: "none",
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 16px",
        borderBottom: "1px solid var(--line)",
        background: "var(--surface)",
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
          padding: "4px 11px",
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
        aria-label="New chat"
        title="New chat"
        style={{
          marginLeft: "auto",
          width: compact ? 44 : 30,
          height: compact ? 44 : 30,
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
        <Icon name="plus" size={14} strokeWidth={1.9} />
      </button>
    </div>
  );
}

export function AiPromptPanel({
  aiPrompt,
  onPromptChange,
  aiMode,
  onModeChange,
  canEdit,
  workflowName,
  messages,
  phase,
  typing,
  plan,
  error,
  onSend,
  onReset,
  onAccept,
  provider,
  onProvider,
  providerOptions,
  providerHint,
  fixNotice,
}: {
  /** The composer draft — CONTROLLED, because `?fix=` writes into it. */
  aiPrompt: string;
  onPromptChange: (v: string) => void;
  /** Change what's on the canvas, or replace it. */
  aiMode: AiMode;
  onModeChange: (m: AiMode) => void;
  /** Whether there's a compilable workflow to change — no canvas, nothing to edit. */
  canEdit: boolean;
  /** The workflow the conversation is changing, for the intro's copy. */
  workflowName: string;
  messages: ChatMsg[];
  phase: BuildPhase;
  typing: boolean;
  plan: PlanLine[] | null;
  error: string | null;
  onSend: (text: string) => void;
  /** "New chat" — start the conversation over, leaving the canvas alone. */
  onReset: () => void;
  /** The `SAVE_OPTION` quick reply — the canvas's OWN Save, so the chip does what it says. */
  onAccept: () => void;
  provider: AiBuilderProvider | null;
  onProvider: (next: AiBuilderProvider | null) => void;
  providerOptions: ProviderOption[];
  providerHint: string | null;
  /** Set when the user arrived from a failed run (`?fix=`); null otherwise. */
  fixNotice?: FixNotice | null;
}) {
  const compact = useMediaQuery(BELOW_RAIL_QUERY);
  const editing = aiMode === "edit" && canEdit;
  const writing = fixIsWriting(fixNotice);

  return (
    <div
      style={{
        borderBottom: "1px solid var(--line)",
        background: "var(--surface)",
      }}
    >
      <PanelHeader phase={phase} onReset={onReset} compact={compact} />
      <ConversationPanel
        variant="panel"
        compact={compact}
        phase={phase}
        messages={messages}
        typing={typing}
        plan={plan}
        error={error}
        onSend={onSend}
        /* The composer draft lives in the canvas hook: `?fix=` writes a description of a failed run
           into it and the user reads it there before pressing Send. Deliberately a PREFILL and not
           an auto-sent first message — sending a tenant's run data to a model is not something to
           do on a navigation (see useFixFromRun). */
        draft={aiPrompt}
        onDraftChange={onPromptChange}
        draftReadOnly={writing}
        /* On a `?fix=` arrival the banner above the composer already IS the intro: it names the
           run, what is about to be sent and what to do next. A second empty state above it would
           be redundant, and its example chips SEND immediately — tapping one would discard the
           description of the user's failed run without a word. Dropping it also gives the phone
           layout back the ~110px it needs to still show some canvas. */
        hideIntro={Boolean(fixNotice)}
        /* Pre-size the box for the description that is about to land in it (~15 lines), so the
           panel doesn't jump under the reader at the moment the thing they're meant to read
           appears. This is what `rows={fixNotice ? 12 : 2}` did before the composer was shared.

           Keyed on the NOTICE, not on its stage — as is `hideIntro` above, and as `readOnly` is
           via `fixIsWriting` covering every waiting stage. That was merely tidy while
           `loading-canvas` was unreachable; #1007 made it a real state a user sits in, so the
           arrival is now a genuine sequence (loading-canvas → reading-run → done) and anything
           sized per-stage would resize the panel twice underneath someone mid-read. */
        composerMinHeight={fixNotice ? (compact ? 130 : 200) : undefined}
        /* Which workflow this changes, in the shape the shared panel expects. `baseVersion` is null
           because the canvas's own Save owns versioning and this panel renders no save button of
           its own — see `showAccept`. */
        editing={
          editing
            ? { workflowKey: "", name: workflowName, baseVersion: null }
            : null
        }
        banner={
          <>
            {fixNotice && (
              <FixNoticeBanner
                notice={fixNotice}
                hasPrompt={aiPrompt.trim().length > 0}
              />
            )}
            {canEdit && (
              <ModeChooser
                aiMode={aiMode}
                onModeChange={onModeChange}
                disabled={phase === "streaming"}
              />
            )}
          </>
        }
        /* The canvas already has a Save, in the top bar directly above this panel. A second
           full-width Save button here would invite the question of how the two differ, and the
           honest answer is that they don't. The accept QUICK REPLY is still offered and runs that
           same Save — a chip reading "looks good — save it" has to save. */
        onAccept={onAccept}
        showAccept={false}
        provider={provider}
        onProvider={onProvider}
        providerOptions={providerOptions}
        providerHint={providerHint}
        /* Not applicable on the canvas: there is no draft to open elsewhere, no stale-save prompt
           (the canvas's own save path owns that), and resuming a build belongs on the screen that
           lists them. */
        opening={false}
        seeding={false}
        staleWarning={null}
        resumables={null}
      />
    </div>
  );
}
