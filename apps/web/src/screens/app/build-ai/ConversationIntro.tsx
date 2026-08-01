/**
 * The conversation's empty state — everything the AI builder shows BEFORE the first message.
 *
 * Split out of ConversationPanel (which it pushed past the 1000-line mark) rather than inlined,
 * because it is a self-contained screen with its own rule: it must never presume which of the two
 * modes it is in. "What should we automate?" read at someone who just clicked "Edit with AI" is how
 * a user comes to believe their workflow is about to be replaced, so the binding-still-resolving
 * case says only that, and the create/edit copy and openers diverge everywhere below it.
 */
import { Icon } from "../../../components";
import type { BuilderSessionSummary } from "../../../lib/api/builder";
import type { EditTarget } from "./edit-target";
import type { CSSProperties, RefObject } from "react";

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

export function ConversationIntro({
  scrollRef,
  boxStyle,
  seeding,
  editing,
  resumables,
  onResume,
  onSend,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  /** The scroll box the panel gives every one of its states, so they share a height rule. */
  boxStyle: CSSProperties;
  seeding: boolean;
  editing: EditTarget | null;
  resumables: BuilderSessionSummary[] | null;
  onResume?: (id: string) => void;
  onSend: (text: string) => void;
}) {
  if (seeding) {
    // The binding is still resolving, so `editing` is null — and the create intro below would
    // read "What should we automate?" at a user who just clicked "Edit with AI". Show nothing
    // that presumes either mode until we know which one this is.
    return (
      <div style={boxStyle}>
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
    );
  }
  return (
    <div ref={scrollRef} style={boxStyle}>
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
            {/* Not "to the right": the same sentence is read beside the stage on the page and
                    above the canvas in the panel, and a direction that's wrong on one of them is
                    worse than no direction at all. */}
            — it's already on the canvas. Tell me the change in a sentence and
            I'll apply it to this workflow, not start a new one.
          </>
        ) : (
          <>
            Tell me the goal in a sentence. I'll draft a runnable workflow on
            the canvas — then you refine it by chatting.
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

      {resumables && resumables.length > 0 && onResume && (
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
  );
}
