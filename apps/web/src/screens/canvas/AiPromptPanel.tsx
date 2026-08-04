/**
 * The canvas's "Build with AI" panel — a RESIZABLE DRAWER beside the graph that holds the SAME
 * conversation as the Build with AI screen (#1003).
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
 *
 * WHY A DRAWER AND NOT A STRIP (#1090). It used to sit ABOVE the canvas, full width, sized by its
 * own content: header + banner + thread + composer. Every one of those grows — a `?fix=` arrival
 * alone asks for a 200px composer — so on a laptop the conversation covered nearly the whole
 * viewport and the graph it was editing was pushed off the bottom of the screen. Watching nodes
 * appear as they stream is the point of building on the canvas rather than on /app/build-ai, and
 * the strip made exactly that impossible.
 *
 * Beside the graph, the two no longer compete for the same axis: the drawer takes width the canvas
 * gives up, the canvas keeps its full height, and the user sets the split by dragging — so someone
 * mid-conversation can widen it to read, then narrow it to watch. The size is remembered
 * (`useResizablePane`), because a split you must re-drag every visit is one you stop using.
 *
 * On ≤1024 there is no width to give up, so the same conversation becomes a BOTTOM SHEET over the
 * canvas — resized on the vertical axis by the same hook, and overlaid rather than stacked so the
 * graph keeps its own height instead of being squeezed into a third of the screen.
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
import { useResizablePane } from "./useResizablePane";

/**
 * Drawer bounds.
 *
 * The minimum is a readability floor, not a token budget: below ~320px the composer, the two mode
 * chips and the provider picker start wrapping onto their own lines, and the thread turns into a
 * column of two-word lines. The maximum is a share of the viewport rather than a constant — the
 * drawer exists to leave the canvas visible, so it may never be the whole window on any screen.
 */
const DRAWER_DEFAULT_W = 400;
const DRAWER_MIN_W = 320;
const DRAWER_MAX_FRACTION = 0.55;
/** localStorage keys — one per axis, because the two layouts are different splits, not one value
 *  in two units. Someone who narrows the phone sheet has not asked for a narrow desktop drawer. */
const DRAWER_W_KEY = "naary.canvas.ai.drawerWidth";
const SHEET_H_KEY = "naary.canvas.ai.sheetHeight";
const SHEET_MIN_H = 220;
const SHEET_MAX_FRACTION = 0.85;
const SHEET_DEFAULT_FRACTION = 0.5;

/** Viewport-relative caps, resolved at clamp time so a window resize can't strand the pane wider
 *  than the screen. Guarded for a zero-size test environment. */
function maxDrawerWidth(): number {
  const w = typeof window === "undefined" ? 0 : window.innerWidth;
  return Math.max(DRAWER_MIN_W, Math.round((w || 1280) * DRAWER_MAX_FRACTION));
}
function maxSheetHeight(): number {
  const h = typeof window === "undefined" ? 0 : window.innerHeight;
  return Math.max(SHEET_MIN_H, Math.round((h || 800) * SHEET_MAX_FRACTION));
}
function defaultSheetHeight(): number {
  const h = typeof window === "undefined" ? 0 : window.innerHeight;
  return Math.max(SHEET_MIN_H, Math.round((h || 800) * SHEET_DEFAULT_FRACTION));
}

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
  onClose,
  compact,
}: {
  phase: BuildPhase;
  onReset: () => void;
  /** Close the drawer. The top bar's toggle still does this, but a drawer whose only dismissal is
   *  a button in a different region is one people close by reloading the page — and on the phone
   *  sheet that top-bar control is behind the overflow menu. */
  onClose: () => void;
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
      <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
        {(
          [
            ["plus", "New chat", onReset],
            ["x", "Close AI", onClose],
          ] as const
        ).map(([icon, label, onClick]) => (
          <button
            key={label}
            type="button"
            onClick={onClick}
            aria-label={label}
            title={label}
            style={{
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
            <Icon name={icon} size={14} strokeWidth={1.9} />
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * The drag handle between the drawer and the canvas.
 *
 * Thin line, fat hitbox: the visible rule is 1–2px so it reads as an edge rather than a widget,
 * while the element itself is wide/tall enough to grab — 44px on touch, per the same rule every
 * other control on this screen follows. The hit area is transparent, so the drawer looks like it
 * simply ends where the canvas begins.
 *
 * Keyboard resizing, focus ring and the ARIA separator semantics come from `useResizablePane`; the
 * only thing this renders is the surface.
 */
function ResizeHandle({
  separatorProps,
  dragging,
  axis,
  compact,
}: {
  separatorProps: ReturnType<typeof useResizablePane>["separatorProps"];
  dragging: boolean;
  axis: "x" | "y";
  compact: boolean;
}) {
  const thickness = compact ? 44 : 10;
  const { style, ...rest } = separatorProps;
  return (
    <div
      {...rest}
      className="naary-pane-handle"
      data-dragging={dragging ? "true" : undefined}
      style={{
        ...style,
        flex: "none",
        width: axis === "x" ? thickness : "100%",
        height: axis === "x" ? "100%" : thickness,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        // The pane's own edge line lives HERE rather than as a border on the drawer, so the
        // hover/drag highlight lands on the same pixels the user is aiming at.
        background: "transparent",
      }}
    >
      <span
        aria-hidden
        className="naary-pane-handle-line"
        style={{
          // On the vertical split this is the edge itself; on the sheet it is a grab pill, the
          // shape a bottom sheet is expected to have.
          width: axis === "x" ? 2 : 44,
          height: axis === "x" ? "100%" : 4,
          borderRadius: axis === "x" ? 0 : "var(--radius-pill)",
          background: dragging ? "var(--brand)" : "var(--line-2)",
        }}
      />
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
  onClose,
  onResized,
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
  /** Dismiss the drawer — the same toggle the top bar's "Close AI" runs. */
  onClose: () => void;
  /**
   * The drawer settled at a new size (drag released, or a keyboard adjustment).
   *
   * The canvas re-frames its graph here. React Flow keeps its transform across a container resize,
   * so widening the drawer pushes the right-hand side of the graph out of view and leaves it
   * there — which is the bug this whole change is about, reappearing one drag later.
   */
  onResized?: () => void;
}) {
  const compact = useMediaQuery(BELOW_RAIL_QUERY);
  const editing = aiMode === "edit" && canEdit;
  const writing = fixIsWriting(fixNotice);

  // Two layouts, two splits (see the file header): a width the canvas gives up on desktop, a
  // height the sheet takes over the canvas below ~1024. One hook, opposite axes — and opposite
  // drag signs, because the desktop handle is on the drawer's RIGHT edge (drag right to widen)
  // while the sheet's is on its TOP edge (drag up to grow).
  const pane = useResizablePane(
    compact
      ? {
          storageKey: SHEET_H_KEY,
          axis: "y",
          edge: "start",
          initial: defaultSheetHeight(),
          min: SHEET_MIN_H,
          max: maxSheetHeight,
          label: "Resize the AI panel",
          onCommit: onResized,
        }
      : {
          storageKey: DRAWER_W_KEY,
          axis: "x",
          edge: "end",
          initial: DRAWER_DEFAULT_W,
          min: DRAWER_MIN_W,
          max: maxDrawerWidth,
          label: "Resize the AI panel",
          onCommit: onResized,
        },
  );

  /**
   * How much height to reserve for a `?fix=` description before it lands.
   *
   * As a strip this was a flat 200px and it cost the canvas 200px of screen. In a pane it costs
   * the THREAD instead — and on the phone sheet, a 200px composer inside a ~380px sheet leaves the
   * conversation about one line. So the reservation is a share of the sheet the user chose, which
   * keeps the arriving description readable (still ~6 lines at the minimum sheet height) without
   * swallowing the panel it arrived in. The desktop drawer is full-column-height, where the
   * original 200px was never the problem.
   */
  const fixComposerMin = compact
    ? Math.max(90, Math.min(160, Math.round(pane.size * 0.34)))
    : 200;

  const conversation = (
    <>
      <PanelHeader
        phase={phase}
        onReset={onReset}
        onClose={onClose}
        compact={compact}
      />
      <ConversationPanel
        variant="drawer"
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
           sized per-stage would resize the panel twice underneath someone mid-read.

           Sized against the PANE now rather than flat — see `fixComposerMin`. */
        composerMinHeight={fixNotice ? fixComposerMin : undefined}
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
    </>
  );

  // ≤1024: a bottom SHEET below the canvas, in the column rather than floating over it.
  //
  // Overlaying was tried first and is wrong for one concrete reason: React Flow measures its
  // CONTAINER, so a sheet that covers the bottom half of an unchanged container leaves the graph
  // centred behind it — the screenshot showed the nodes sitting under the sheet's top edge. A flex
  // item takes real space, so the fit is computed against the area the user can actually see.
  //
  // `order: 1` rather than a second render site: this component is written once, before the stage
  // in the JSX (where the desktop drawer belongs, left of the canvas), and the order property is
  // what moves it below the stage when the row becomes a column.
  if (compact) {
    return (
      <aside
        aria-label="Build with AI"
        style={{
          order: 1,
          flex: "none",
          height: pane.size,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          background: "var(--surface)",
          borderTop: "1px solid var(--line)",
        }}
      >
        <ResizeHandle
          separatorProps={pane.separatorProps}
          dragging={pane.dragging}
          axis="y"
          compact={compact}
        />
        {conversation}
      </aside>
    );
  }

  return (
    <aside
      aria-label="Build with AI"
      style={{
        width: pane.size,
        flex: "none",
        display: "flex",
        flexDirection: "row",
        minWidth: 0,
        background: "var(--surface)",
        borderRight: "1px solid var(--line)",
      }}
    >
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        {conversation}
      </div>
      <ResizeHandle
        separatorProps={pane.separatorProps}
        dragging={pane.dragging}
        axis="x"
        compact={compact}
      />
    </aside>
  );
}
