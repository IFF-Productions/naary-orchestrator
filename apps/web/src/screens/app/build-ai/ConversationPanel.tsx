/**
 * Build with AI — the 452px conversation column (design "Naary AI Generate").
 * Intro empty-state with example-idea chips (+ real resumable sessions), the
 * message thread (ember-flame AI avatar / user bubbles), typing dots while the
 * turn stream warms up, the "Building" plan card derived from real SSE frames,
 * and the composer. Purely presentational — the screen container owns all I/O.
 */
import { useEffect, useRef, useState } from "react";
import { Icon } from "../../../components";
import {
  type BuilderSessionSummary,
  SAVE_OPTION,
} from "../../../lib/api/builder";
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

const EXAMPLES: { label: string; icon: "bolt" | "agent" | "approval" }[] = [
  {
    label:
      "When a refund request arrives, ask me to approve big ones, then issue it via Stripe",
    icon: "approval",
  },
  {
    label: "Summarize each new support email with AI and post it to Slack",
    icon: "agent",
  },
  {
    label:
      "Every weekday at 9am, fetch open GitHub issues and email me a digest",
    icon: "bolt",
  },
];

/**
 * Openers for an EDIT chat. A separate list, not the create examples reworded: those describe whole
 * workflows ("when a refund request arrives, …"), and offering one here would invite the user to
 * ask for the very rewrite this screen is built to avoid.
 */
const EDIT_EXAMPLES: { label: string; icon: "bolt" | "agent" | "approval" }[] =
  [
    { label: "Add a Slack notification when it finishes", icon: "bolt" },
    {
      label: "Require my approval before the last step runs",
      icon: "approval",
    },
    { label: "Retry the HTTP request twice before giving up", icon: "agent" },
  ];

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
  onOpenInCanvas,
  onConfirmStale,
  onDismissStale,
  compact,
}: {
  phase: BuildPhase;
  messages: ChatMsg[];
  typing: boolean;
  /** The Building card's lines (real stream events); null before the first build. */
  plan: PlanLine[] | null;
  error: string | null;
  /** Open sessions to resume (real, env-scoped); null while loading. */
  resumables: BuilderSessionSummary[] | null;
  /** "Open in canvas" in flight (saving the draft). */
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
  onResume: (id: string) => void;
  onOpenInCanvas: () => void;
  onConfirmStale: () => void;
  onDismissStale: () => void;
  compact?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
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

  // `seeding` blocks a turn until we know WHICH workflow it edits — see BuildWithAiState.seeding.
  const canSend = draft.trim().length > 0 && !streaming && !opening && !seeding;
  const send = () => {
    const text = draft.trim();
    if (!text || streaming || opening || seeding) return;
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
  const hint = seeding
    ? "Loading the workflow you're editing…"
    : showIntro
      ? editing
        ? "Your message changes this workflow — nothing is saved until you publish a new version."
        : "Your first message becomes a draft workflow — refine it by chatting."
      : streaming
        ? "One moment…"
        : ready
          ? editing
            ? "The change is on the canvas — refine by chatting, or publish it."
            : "The draft is on the canvas — refine by chatting, or open it."
          : "Send a message to keep building.";

  return (
    <div
      style={{
        width: compact ? "100%" : 452,
        flex: "none",
        borderRight: compact ? "none" : "1px solid var(--line)",
        borderBottom: compact ? "1px solid var(--line)" : "none",
        background: "var(--panel)",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        height: compact ? "60vh" : "auto",
      }}
    >
      {showIntro && seeding ? (
        /* The binding is still resolving, so `editing` is null — and the create intro below would
           read "What should we automate?" at a user who just clicked "Edit with AI". Show nothing
           that presumes either mode until we know which one this is. */
        <div style={{ flex: 1, overflowY: "auto", padding: 22 }}>
          <div
            style={{
              fontSize: 19,
              fontWeight: "var(--weight-bold)",
              letterSpacing: "-.01em",
              color: "var(--ink)",
            }}
          >
            Loading your workflow…
          </div>
          <div
            style={{
              fontSize: "var(--text-body)",
              color: "var(--ink-2)",
              marginTop: 6,
              lineHeight: 1.55,
            }}
          >
            Fetching the workflow you're editing so this chat changes it rather
            than replacing it.
          </div>
        </div>
      ) : showIntro ? (
        <div
          ref={scrollRef}
          style={{ flex: 1, overflowY: "auto", padding: 22 }}
        >
          <div
            style={{
              fontSize: 19,
              fontWeight: "var(--weight-bold)",
              letterSpacing: "-.01em",
              color: "var(--ink)",
            }}
          >
            {editing ? "What should we change?" : "What should we automate?"}
          </div>
          <div
            style={{
              fontSize: "var(--text-body)",
              color: "var(--ink-2)",
              marginTop: 6,
              lineHeight: 1.55,
            }}
          >
            {editing ? (
              <>
                You're editing{" "}
                <strong style={{ color: "var(--ink)" }}>{editing.name}</strong>{" "}
                — it's already on the canvas to the right. Tell me the change in
                a sentence and I'll apply it to this workflow, not start a new
                one.
              </>
            ) : (
              <>
                Tell me the goal in a sentence. I'll draft a runnable workflow
                on the canvas — then you refine it by chatting.
              </>
            )}
          </div>

          <div
            className="mono"
            style={{
              fontSize: "var(--text-2xs)",
              letterSpacing: ".1em",
              textTransform: "uppercase",
              color: "var(--ink-faint)",
              margin: "20px 0 9px",
            }}
          >
            {editing ? "Common changes" : "Start from an idea"}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            {(editing ? EDIT_EXAMPLES : EXAMPLES).map((ex) => (
              <button
                key={ex.label}
                type="button"
                onClick={() => onSend(ex.label)}
                className="bwa-chip"
                style={{
                  border: "1px solid var(--line-mid)",
                  background: "var(--card)",
                  borderRadius: 10,
                  padding: "10px 12px",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  textAlign: "left",
                }}
              >
                <span
                  style={{
                    width: 26,
                    height: 26,
                    flex: "none",
                    borderRadius: 7,
                    border: "1px solid var(--brand)",
                    color: "var(--brand)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Icon name={ex.icon} size={14} strokeWidth={1.7} />
                </span>
                <span
                  style={{
                    fontSize: "var(--text-sm)",
                    color: "var(--ink-soft)",
                    lineHeight: 1.4,
                  }}
                >
                  {ex.label}
                </span>
              </button>
            ))}
          </div>

          {resumables && resumables.length > 0 && (
            <>
              <div
                className="mono"
                style={{
                  fontSize: "var(--text-2xs)",
                  letterSpacing: ".1em",
                  textTransform: "uppercase",
                  color: "var(--ink-faint)",
                  margin: "20px 0 9px",
                }}
              >
                Resume a build
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                {resumables.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => onResume(s.id)}
                    className="bwa-chip"
                    style={{
                      border: "1px solid var(--line-mid)",
                      background: "var(--card)",
                      borderRadius: 10,
                      padding: "10px 12px",
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      textAlign: "left",
                    }}
                  >
                    <span
                      style={{
                        width: 26,
                        height: 26,
                        flex: "none",
                        borderRadius: 7,
                        border: "1px solid var(--line-2)",
                        color: "var(--ink-2)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <Icon name="refresh" size={14} strokeWidth={1.7} />
                    </span>
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span
                        style={{
                          display: "block",
                          fontSize: "var(--text-sm)",
                          color: "var(--ink-soft)",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {s.title ?? "Untitled build"}
                      </span>
                      {/* A session bound to a workflow says so HERE too — resuming one is a
                          decision about someone's live workflow, and the list is where it's made. */}
                      <span
                        className="mono"
                        style={{
                          display: "block",
                          fontSize: "var(--text-2xs)",
                          color: "var(--ink-3)",
                          marginTop: 2,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {s.workflowKey ? `editing ${s.workflowKey} · ` : ""}
                        {new Date(s.updatedAt).toLocaleString()}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      ) : (
        <div
          ref={scrollRef}
          style={{
            flex: 1,
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
                          const isSave = opt === SAVE_OPTION;
                          return (
                            <button
                              key={opt}
                              type="button"
                              className="bwa-chip"
                              onClick={() =>
                                isSave ? onOpenInCanvas() : onSend(opt)
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
          next VERSION; unbound it creates a new one and opens it. */}
      {ready && !staleWarning && (
        <div style={{ flex: "none", padding: "4px 20px 12px" }}>
          <button
            type="button"
            onClick={onOpenInCanvas}
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
            rows={1}
            style={{
              flex: 1,
              height: 38,
              maxHeight: 90,
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
