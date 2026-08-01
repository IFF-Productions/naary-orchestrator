/**
 * The AI builder conversation — intro empty-state with example-idea chips (+ real resumable
 * sessions), the message thread (ember-flame AI avatar / user bubbles), typing dots while the turn
 * stream warms up, the "Building" plan card derived from real SSE frames, and the composer. Purely
 * presentational — the container owns all I/O.
 *
 * TWO SURFACES, ONE COMPONENT (#1003). It is the 452px column on the Build with AI screen (design
 * "Naary AI Generate") and the strip under the canvas's top bar, switched by `variant`. Deliberately
 * not two components that look alike: the canvas panel spent its whole life as a one-shot form
 * because "the same thing, over there" was never the same thing, and a second copy of this would
 * drift the same way. What genuinely differs between the surfaces is a handful of named props —
 * where the draft lives, what sits above the composer, whether there is an accept button — and each
 * one is here because the surfaces really do differ, not to make one of them configurable.
 */
import type { ReactNode } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "../../../components";
import {
  type BuilderSessionSummary,
  SAVE_OPTION,
} from "../../../lib/api/builder";
import { ConversationIntro } from "./ConversationIntro";
import type { EditTarget } from "./edit-target";
import type { PlanLine } from "./model";
import { ProviderPicker } from "./ProviderPicker";
import type { AiBuilderProvider, ProviderOption } from "./providers";

export interface ChatMsg {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Real metered BYOK cost of an assistant turn (from the session API). */
  costUsd?: number | null;
  /** Tappable quick-reply suggestions (#487); rendered on the LAST assistant turn only. */
  options?: string[];
}

export type BuildPhase = "idle" | "streaming" | "ready";

/**
 * Where this conversation is rendered.
 *
 * `page` — the Build with AI screen: a fixed 452px column that owns its full height, beside a
 * read-only preview stage.
 * `panel` — the canvas: a full-width strip under the top bar, above a canvas that stays live and
 * editable. It must claim only the height it needs (the canvas below it is the point), so the
 * thread scrolls inside a cap rather than the column filling the viewport.
 */
export type ConversationVariant = "page" | "panel";

/**
 * Composer bounds. One line to start; grows with the content up to a cap, because a `?fix=`
 * description arrives ~15 lines long and the banner above it asks the user to read it first.
 *
 * The cap is tighter on a phone, where this panel and the canvas it is describing share one narrow
 * screen — a box that can eat 220px there is a box that hides the workflow it just changed.
 */
const COMPOSER_MIN_H = 38;
const COMPOSER_MAX_H = 220;
const COMPOSER_MAX_H_COMPACT = 150;

/** The brand ember-flame avatar next to assistant turns. */
function EmberAvatar() {
  return (
    <span
      aria-hidden
      style={{
        width: 26,
        height: 26,
        flex: "none",
        borderRadius: 7,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--brand-radial)",
        boxShadow: "0 0 10px -3px rgba(242,98,46,.6)",
        color: "#fff3ec",
      }}
    >
      <Icon name="flame" size={14} />
    </span>
  );
}

export function ConversationPanel({
  phase,
  messages,
  typing,
  plan,
  error,
  resumables,
  opening,
  editing,
  seeding,
  staleWarning,
  onSend,
  providerOptions,
  provider,
  onProvider,
  providerHint,
  onResume,
  onAccept,
  onConfirmStale,
  onDismissStale,
  compact,
  variant = "page",
  draft: draftProp,
  onDraftChange,
  draftReadOnly,
  banner,
  showAccept = true,
  hideIntro,
  composerMinHeight,
}: {
  phase: BuildPhase;
  messages: ChatMsg[];
  typing: boolean;
  /** The Building card's lines (real stream events); null before the first build. */
  plan: PlanLine[] | null;
  error: string | null;
  /** Open sessions to resume (real, env-scoped); null while loading. */
  resumables: BuilderSessionSummary[] | null;
  /** The accept action is in flight (saving the draft). */
  opening: boolean;
  /** The workflow this chat edits, or null for a from-scratch build. */
  editing: EditTarget | null;
  /** `?key=` present, binding not resolved — no turn may be sent yet (see BuildWithAiState). */
  seeding: boolean;
  /** Save refused: the draft may not descend from what's saved now — confirm or cancel. */
  staleWarning: string | null;
  onSend: (text: string) => void;
  /** Which model/agent to generate with — see ./providers. */
  providerOptions: ProviderOption[];
  provider: AiBuilderProvider | null;
  onProvider: (next: AiBuilderProvider | null) => void;
  providerHint: string | null;
  onResume?: (id: string) => void;
  /**
   * "This draft is good — keep it." The page saves the draft and opens it in the canvas; the canvas
   * saves the workflow. Both the accept button and the `SAVE_OPTION` quick reply call it, so the
   * chip can never promise something the surface doesn't do.
   */
  onAccept?: () => void;
  onConfirmStale?: () => void;
  onDismissStale?: () => void;
  compact?: boolean;
  variant?: ConversationVariant;
  /**
   * A CONTROLLED composer draft, for a container that has something to put in it.
   *
   * `?fix=<runId>` writes a description of a failed run into the box and the user reads it before
   * sending — so the draft has to be reachable from outside. Omit both and the composer keeps its
   * own state, which is what the page wants.
   */
  draft?: string;
  onDraftChange?: (next: string) => void;
  /**
   * The draft is about to be WRITTEN INTO — reject typing that would be silently replaced.
   *
   * `readOnly`, never `disabled`: disabled drops the field out of the tab order and out of reach of
   * a screen reader, which is a bigger loss than the one being prevented. Guarded in
   * `apps/web/e2e/fix-with-ai.spec.ts`, which asserts both halves.
   */
  draftReadOnly?: boolean;
  /**
   * Rendered directly ABOVE the composer — what this turn is about to do, and with what.
   *
   * The canvas puts two things here: the `?fix=` disclosure of which run's data is about to leave
   * the tenant, and the edit-vs-create chooser. Both belong next to Send rather than at the top of a
   * scrolling thread, because both are claims about the message the user is about to send.
   */
  banner?: ReactNode;
  /** False where the surface has its own save (the canvas top bar) — see `onAccept`. */
  showAccept?: boolean;
  /**
   * Drop the empty state, leaving the banner and composer alone above the canvas.
   *
   * For the `?fix=` arrival, where the banner already IS the intro — it names the run, what is
   * about to be sent and what to do next — so a second empty state above it would be redundant,
   * and its example chips are actively dangerous: a chip SENDS immediately, which would discard
   * the description of the user's failed run without a word. The intro's COPY still applies (the
   * placeholder and hint below stay in their idle wording); only the block is dropped.
   */
  hideIntro?: boolean;
  /**
   * Pre-size the composer, for a container that is about to write something long into it.
   *
   * The `?fix=` box is ~15 lines when it lands. Growing into that from one line makes the whole
   * panel jump under the reader at the exact moment the thing they are meant to read appears — so
   * the canvas asks for the height up front and the description simply arrives in it.
   */
  composerMinHeight?: number;
}) {
  const [ownDraft, setOwnDraft] = useState("");
  const controlled = draftProp !== undefined;
  const draft = controlled ? draftProp : ownDraft;
  const setDraft = (next: string) => {
    if (controlled) onDraftChange?.(next);
    else setOwnDraft(next);
  };
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const embedded = variant === "panel";
  const showIntro = phase === "idle" && messages.length === 0;
  const streaming = phase === "streaming";
  const ready = phase === "ready";
  const building = streaming && !!plan;
  // Quick-reply chips belong to the newest assistant turn only, and never mid-build (#487).
  const lastMsgId = messages[messages.length - 1]?.id;

  // Keep the thread pinned to the newest message / plan line.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, typing, plan, error]);

  /**
   * Grow the composer to its content, up to a cap.
   *
   * One typed sentence wants one line; a `?fix=` description is fifteen, and the banner above it
   * says to read it before sending — which is not an instruction you can follow through a one-line
   * window. Measured rather than switched on a row count, so it also covers a long message someone
   * simply typed. `useLayoutEffect` so the resize is committed with the paint that shows the text,
   * never a frame after it.
   */
  const composerMin = composerMinHeight ?? COMPOSER_MIN_H;
  const composerMax = Math.max(
    composerMin,
    compact ? COMPOSER_MAX_H_COMPACT : COMPOSER_MAX_H,
  );
  useLayoutEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, composerMin), composerMax)}px`;
  }, [draft, composerMin, composerMax]);

  // `seeding` blocks a turn until we know WHICH workflow it edits — see BuildWithAiState.seeding.
  const canSend =
    draft.trim().length > 0 &&
    !streaming &&
    !opening &&
    !seeding &&
    !draftReadOnly;
  const send = () => {
    const text = draft.trim();
    if (!text || streaming || opening || seeding || draftReadOnly) return;
    setDraft("");
    onSend(text);
  };

  // Editing an existing workflow rewrites every "what shall we build?" prompt in the column: the
  // answer is already decided, and asking again is how a user comes to believe they're starting over.
  const idlePlaceholder = editing
    ? `Describe a change to “${editing.name}”…`
    : "Describe what you want to automate…";
  const placeholder = showIntro
    ? idlePlaceholder
    : streaming
      ? "Naary is building…"
      : ready
        ? "Ask for a change — “add a Slack step”…"
        : idlePlaceholder;
  /**
   * What happens to a landed draft, in the surface's own terms.
   *
   * On the page the draft lives server-side and has to be brought over ("open it" / "publish it").
   * On the canvas it is already the thing the user is looking at, and the only remaining act is
   * Save — so promising to "open" it would describe a journey they have already made.
   */
  const settled = embedded
    ? editing
      ? "The change is on the canvas — refine by chatting, or Save to keep it."
      : "The draft is on the canvas — refine by chatting, or Save to keep it."
    : editing
      ? "The change is on the canvas — refine by chatting, or publish it."
      : "The draft is on the canvas — refine by chatting, or open it.";
  const hint = seeding
    ? "Loading the workflow you're editing…"
    : showIntro
      ? editing
        ? "Your message changes this workflow — nothing is saved until you publish a new version."
        : "Your first message becomes a draft workflow — refine it by chatting."
      : streaming
        ? "One moment…"
        : ready
          ? settled
          : "Send a message to keep building.";

  /**
   * The thread's own box.
   *
   * On the page the column owns the viewport, so the thread takes whatever is left. In the canvas
   * strip it must NOT: the canvas underneath is the point, so the thread is capped and scrolls
   * inside the cap, and everything below it (banner, composer) keeps its natural height however
   * long the conversation gets. Shorter on a phone, where the same strip is a much bigger share of
   * the screen.
   */
  const threadBox = embedded
    ? { flex: "none" as const, maxHeight: compact ? 200 : 300 }
    : { flex: 1 };

  return (
    <div
      style={{
        width: embedded || compact ? "100%" : 452,
        flex: "none",
        borderRight: embedded || compact ? "none" : "1px solid var(--line)",
        borderBottom: embedded || compact ? "1px solid var(--line)" : "none",
        background: "var(--panel)",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        // The canvas strip claims only what it needs; the page column fills its half of the screen.
        height: embedded ? undefined : compact ? "60vh" : "auto",
      }}
    >
      {/* `hideIntro` drops the BLOCK, not the state: the placeholder and hint above still read as
          the idle ones, because that is still what this is. */}
      {showIntro ? (
        hideIntro ? null : (
          <ConversationIntro
            scrollRef={scrollRef}
            boxStyle={{ ...threadBox, overflowY: "auto", padding: 22 }}
            seeding={seeding}
            editing={editing}
            resumables={resumables}
            onResume={onResume}
            onSend={onSend}
          />
        )
      ) : (
        <div
          ref={scrollRef}
          style={{
            ...threadBox,
            overflowY: "auto",
            padding: "20px 20px 8px",
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          {messages.map((m) =>
            m.role === "assistant" ? (
              <div
                key={m.id}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 9,
                  animation: "naaryFadeUp .25s ease",
                }}
              >
                <EmberAvatar />
                <div style={{ minWidth: 0 }}>
                  <div
                    style={{
                      maxWidth: 340,
                      background: "var(--card)",
                      border: "1px solid var(--line-mid)",
                      borderRadius: 12,
                      borderTopLeftRadius: 4,
                      padding: "11px 14px",
                      fontSize: "var(--text-body)",
                      lineHeight: 1.55,
                      color: "var(--ink-soft)",
                    }}
                  >
                    {m.text}
                  </div>
                  {typeof m.costUsd === "number" && (
                    <div
                      className="mono"
                      style={{
                        fontSize: "var(--text-2xs)",
                        color: "var(--ink-3)",
                        marginTop: 4,
                      }}
                    >
                      turn cost ${m.costUsd.toFixed(4)}
                    </div>
                  )}
                  {/* Quick-reply chips — newest assistant turn, not while building/saving. */}
                  {m.id === lastMsgId &&
                    !streaming &&
                    !opening &&
                    m.options &&
                    m.options.length > 0 && (
                      <div
                        style={{
                          display: "flex",
                          flexWrap: "wrap",
                          gap: 7,
                          marginTop: 9,
                        }}
                      >
                        {m.options.map((opt) => {
                          // The accept chip is only offered where accepting is wired up: it is a
                          // promise about what tapping it does, and a surface with no `onAccept`
                          // would silently do nothing.
                          const isSave = opt === SAVE_OPTION;
                          if (isSave && !onAccept) return null;
                          return (
                            <button
                              key={opt}
                              type="button"
                              className="bwa-chip"
                              onClick={() =>
                                isSave ? onAccept?.() : onSend(opt)
                              }
                              style={{
                                border: `1px solid ${
                                  isSave ? "var(--brand)" : "var(--line-mid)"
                                }`,
                                background: isSave
                                  ? "var(--brand-soft)"
                                  : "var(--card)",
                                color: isSave
                                  ? "var(--brand-2)"
                                  : "var(--ink-soft)",
                                borderRadius: "var(--radius-pill)",
                                padding: "6px 12px",
                                fontSize: "var(--text-sm)",
                                cursor: "pointer",
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 6,
                              }}
                            >
                              {isSave && (
                                <Icon
                                  name="check"
                                  size={12}
                                  strokeWidth={2.2}
                                />
                              )}
                              {opt}
                            </button>
                          );
                        })}
                      </div>
                    )}
                </div>
              </div>
            ) : (
              <div
                key={m.id}
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  animation: "naaryFadeUp .25s ease",
                }}
              >
                <div
                  style={{
                    maxWidth: 300,
                    background: "var(--brand-soft)",
                    border:
                      "1px solid color-mix(in srgb, var(--brand) 38%, transparent)",
                    borderRadius: 12,
                    borderTopRightRadius: 4,
                    padding: "11px 14px",
                    fontSize: "var(--text-body)",
                    lineHeight: 1.55,
                    color: "var(--ink)",
                  }}
                >
                  {m.text}
                </div>
              </div>
            ),
          )}

          {/* typing indicator — the turn is accepted, first frame not in yet */}
          {typing && (
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 9,
                animation: "naaryFadeUp .2s ease",
              }}
            >
              <EmberAvatar />
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  background: "var(--card)",
                  border: "1px solid var(--line-mid)",
                  borderRadius: 12,
                  borderTopLeftRadius: 4,
                  padding: "12px 14px",
                }}
              >
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: "var(--ink-faint)",
                      animation: `bwaDotp 1.2s infinite ${i * 0.2}s`,
                    }}
                  />
                ))}
              </div>
            </div>
          )}

          {/* plan stream card — lines mirror the real SSE frames */}
          {plan && (
            <div
              style={{
                marginLeft: 35,
                border: "1px solid var(--line-mid)",
                background: "var(--card)",
                borderRadius: 12,
                padding: "13px 15px",
              }}
            >
              <div
                className="mono"
                style={{
                  fontSize: "var(--text-2xs)",
                  letterSpacing: ".1em",
                  textTransform: "uppercase",
                  color: "var(--ink-faint)",
                  marginBottom: 9,
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                }}
              >
                Building
                {building && (
                  <span
                    aria-hidden
                    style={{
                      width: 10,
                      height: 10,
                      border: "2px solid var(--surface)",
                      borderTopColor: "var(--brand)",
                      borderRadius: "50%",
                      display: "inline-block",
                      animation: "naarySpin .7s linear infinite",
                    }}
                  />
                )}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                {plan.map((p) => (
                  <div
                    key={p.id}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 9,
                      animation: "bwaLineIn .25s ease",
                    }}
                  >
                    <span
                      style={{
                        width: 16,
                        height: 16,
                        flex: "none",
                        borderRadius: 5,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        marginTop: 1,
                        background: p.done ? "var(--done-soft)" : "transparent",
                        border: `1px solid ${
                          p.done ? "var(--state-done)" : "var(--line-2)"
                        }`,
                      }}
                    >
                      {p.done ? (
                        <Icon
                          name="check"
                          size={10}
                          strokeWidth={2.8}
                          style={{ color: "var(--state-done)" }}
                        />
                      ) : p.busy ? (
                        <span
                          aria-hidden
                          style={{
                            width: 8,
                            height: 8,
                            border: "2px solid var(--surface)",
                            borderTopColor: "var(--brand)",
                            borderRadius: "50%",
                            display: "inline-block",
                            animation: "naarySpin .7s linear infinite",
                          }}
                        />
                      ) : null}
                    </span>
                    <span
                      style={{
                        fontSize: "var(--text-sm)",
                        color: p.done ? "var(--ink-soft)" : "var(--ink-2)",
                        lineHeight: 1.45,
                      }}
                    >
                      {p.text}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {error && (
            <div
              style={{
                marginLeft: 35,
                padding: "9px 12px",
                borderRadius: "var(--radius-sm)",
                background: "var(--error-soft)",
                border:
                  "1px solid color-mix(in srgb, var(--state-error) 40%, transparent)",
                color: "var(--state-error)",
                fontSize: "var(--text-sm)",
                lineHeight: 1.5,
              }}
            >
              {error}
            </div>
          )}
        </div>
      )}

      {/* The draft can no longer be shown to descend from what's saved — the ONE prompt on this
          path, because it's the one place a Save can destroy someone else's work (#874). */}
      {ready && staleWarning && (
        <div style={{ flex: "none", padding: "4px 20px 0" }}>
          <div
            style={{
              padding: "10px 12px",
              borderRadius: "var(--radius-sm)",
              background: "var(--error-soft)",
              border:
                "1px solid color-mix(in srgb, var(--state-error) 40%, transparent)",
              color: "var(--state-error)",
              fontSize: "var(--text-sm)",
              lineHeight: 1.5,
            }}
          >
            {staleWarning}
            <div style={{ display: "flex", gap: 8, marginTop: 9 }}>
              <button
                type="button"
                onClick={onConfirmStale}
                style={{
                  border:
                    "1px solid color-mix(in srgb, var(--state-error) 55%, transparent)",
                  background: "transparent",
                  color: "var(--state-error)",
                  borderRadius: "var(--radius-sm)",
                  padding: "6px 12px",
                  fontSize: "var(--text-sm)",
                  fontWeight: "var(--weight-semibold)",
                  cursor: "pointer",
                }}
              >
                Save anyway
              </button>
              <button
                type="button"
                onClick={onDismissStale}
                style={{
                  border: "1px solid var(--line-2)",
                  background: "var(--card)",
                  color: "var(--ink-2)",
                  borderRadius: "var(--radius-sm)",
                  padding: "6px 12px",
                  fontSize: "var(--text-sm)",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Save — the draft is real (validated result frame). Bound to a workflow this publishes its
          next VERSION; unbound it creates a new one and opens it. Absent on a surface that already
          has a Save of its own (the canvas top bar) — a second button for one act invites the
          question of how the two differ, and the honest answer is that they don't. */}
      {ready && !staleWarning && showAccept && onAccept && (
        <div style={{ flex: "none", padding: "4px 20px 12px" }}>
          <button
            type="button"
            onClick={onAccept}
            disabled={opening}
            style={{
              width: "100%",
              height: compact ? 44 : 38,
              borderRadius: "var(--radius-md)",
              border: "1px solid color-mix(in srgb, var(--brand) 45%, black)",
              background: "linear-gradient(180deg, #ff8a4c, #f2622e)",
              color: "#fff3ec",
              fontSize: "var(--text-body)",
              fontWeight: "var(--weight-bold)",
              cursor: opening ? "wait" : "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 7,
              boxShadow: "0 4px 14px -5px rgba(242,98,46,.6)",
              opacity: opening ? 0.7 : 1,
            }}
          >
            <Icon
              name={editing ? "check" : "external"}
              size={14}
              strokeWidth={1.7}
            />
            {opening
              ? editing
                ? "Publishing…"
                : "Saving draft…"
              : editing
                ? editing.baseVersion !== null
                  ? `Save as v${editing.baseVersion + 1}`
                  : "Save as a new version"
                : "Open in canvas"}
          </button>
        </div>
      )}

      {/* composer */}
      <div
        style={{
          flex: "none",
          borderTop: "1px solid var(--line)",
          padding: "12px 16px",
        }}
      >
        {/* What this turn is about to do, and with what — see the `banner` prop. Above the box and
            below the thread, because it qualifies the message that's about to be sent. */}
        {banner}
        <div
          style={{
            border: `1px solid ${streaming ? "var(--brand)" : "var(--line-2)"}`,
            background: "var(--card)",
            borderRadius: 12,
            display: "flex",
            alignItems: "flex-end",
            gap: 8,
            padding: "8px 8px 8px 13px",
            transition: "border-color .15s",
          }}
        >
          <textarea
            ref={composerRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={placeholder}
            disabled={streaming}
            // See `draftReadOnly`: the box is about to be written into, so typing here would be
            // silently replaced — but it stays enabled, focusable and in the tab order.
            readOnly={draftReadOnly}
            rows={1}
            style={{
              flex: 1,
              // Height is owned by the auto-grow layout effect above; these are its bounds, kept
              // here so a first paint before the effect runs is already the right size.
              height: composerMin,
              maxHeight: composerMax,
              resize: "none",
              background: "transparent",
              border: "none",
              padding: "9px 0",
              fontSize: "var(--text-body)",
              lineHeight: 1.5,
              color: "var(--ink)",
              fontFamily: "var(--font-sans)",
              outline: "none",
            }}
          />
          <button
            type="button"
            onClick={send}
            disabled={!canSend}
            aria-label="Send"
            style={{
              width: compact ? 44 : 38,
              height: compact ? 44 : 38,
              flex: "none",
              borderRadius: "var(--radius-md)",
              border: "1px solid color-mix(in srgb, var(--brand) 45%, black)",
              background: canSend
                ? "linear-gradient(180deg, #ff8a4c, #f2622e)"
                : "var(--surface)",
              color: canSend ? "#fff3ec" : "var(--ink-3)",
              cursor: canSend ? "pointer" : "not-allowed",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              transition: "background .15s",
            }}
          >
            <Icon name="arrow-right" size={16} strokeWidth={2} />
          </button>
        </div>
        {/* Directly under the composer, not in a settings panel: it's a per-turn choice, and which
            model will run should be visible at the moment you press Send. */}
        <ProviderPicker
          options={providerOptions}
          value={provider}
          onChange={onProvider}
          disabled={streaming}
          hint={providerHint}
        />
        <div
          style={{
            fontSize: "var(--text-2xs)",
            color: "var(--ink-3)",
            marginTop: 7,
            textAlign: "center",
          }}
        >
          {hint}
        </div>
      </div>
    </div>
  );
}
