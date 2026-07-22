import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { Icon, Logo } from "../components";
import { api, type ChatDefinition, type Citation } from "../lib/api";
import {
  EMBER_BUTTON,
  EMBER_TINT_BD,
  EMBER_TINT_BG,
  PUBLIC_CARD,
  PublicFrame,
  PublicNotice,
} from "./public/PublicShell";

/**
 * PUBLIC hosted chat (Chat Trigger program). Reached at `/c/:chatId`, OUTSIDE RequireAuth — an
 * anonymous visitor loads the widget definition and exchanges messages; each message starts the
 * tenant's workflow with `{ message, sessionId }` and shows the graph's reply. No auth, no tenant
 * identifiers. Single-turn per message today (durable per-session memory is a later slice); the
 * client keeps a `sessionId` so a future durable session can thread the conversation.
 *
 * Redesign: "Naary Public Pages" hosted-chat card — 440px, brand tile + Online dot header,
 * flame-avatar bot bubbles with a top-left notch, ember-tinted user bubbles, typing dots while
 * the graph runs, ember send button.
 *
 * Sources (issue #482): the chat response now carries `citations[]` — the RAG sources (vectorQuery
 * matches) the run used to answer. When a reply has citations we render a "Sources" list under the
 * assistant bubble; a reply with no retrieval step has an empty array and shows nothing.
 */
type Turn = {
  role: "user" | "assistant";
  text: string;
  /** RAG sources for an assistant reply (issue #482) — empty/omitted when there was no retrieval. */
  citations?: Citation[];
};

/**
 * "Sources" list under an assistant reply (issue #482) — the RAG chunks the run retrieved to answer.
 * Each source shows its collection (when known) + similarity score and a truncated snippet. Rendered
 * only when a reply actually has citations, so a non-RAG chat is visually unchanged.
 */
function Sources({ citations }: { citations: Citation[] }) {
  return (
    <div
      style={{
        border: "1px solid var(--line-mid)",
        borderRadius: 10,
        background: "var(--card-2)",
        padding: "8px 11px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: 0.4,
          textTransform: "uppercase",
          color: "var(--ink-3)",
          display: "flex",
          alignItems: "center",
          gap: 5,
        }}
      >
        <Icon name="template" size={11} strokeWidth={2} />
        Sources
      </div>
      {citations.map((c, i) => (
        <div
          key={i}
          style={{
            fontSize: 11,
            lineHeight: 1.5,
            color: "var(--ink-soft)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              marginBottom: 2,
            }}
          >
            <span style={{ fontWeight: 600, color: "var(--ink)" }}>
              {c.source ?? `Source ${i + 1}`}
            </span>
            {typeof c.score === "number" && (
              <span style={{ fontSize: 10, color: "var(--ink-3)" }}>
                {Math.round(c.score * 100)}% match
              </span>
            )}
          </div>
          <div
            style={{
              color: "var(--ink-3)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {c.snippet}
          </div>
        </div>
      ))}
    </div>
  );
}

export function ChatPage() {
  const { chatId } = useParams<{ chatId: string }>();
  const [def, setDef] = useState<ChatDefinition | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "notfound">(
    "loading",
  );
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const sessionId = useRef<string>(
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : String(Date.now()),
  );
  const scrollRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (!chatId) return;
    try {
      const d = await api.getChatDefinition(chatId);
      setDef(d);
      setState("ready");
      if (d.greeting) setTurns([{ role: "assistant", text: d.greeting }]);
    } catch {
      setState("notfound");
    }
  }, [chatId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [turns, sending]);

  async function send() {
    const text = input.trim();
    if (!text || !chatId || sending) return;
    setInput("");
    setTurns((t) => [...t, { role: "user", text }]);
    setSending(true);
    try {
      const res = await api.sendChatMessage(chatId, text, sessionId.current);
      // "started" = the workflow ran but didn't respond synchronously (no Respond node / timed out).
      // Show that explicitly rather than a permanent "…" that looks like it's still typing.
      const reply =
        res.status !== "replied"
          ? "The assistant didn't reply in time — add a Respond node to your chat workflow."
          : res.reply == null
            ? "(no reply)"
            : typeof res.reply === "string"
              ? res.reply
              : typeof (res.reply as { reply?: unknown }).reply === "string"
                ? String((res.reply as { reply?: unknown }).reply)
                : JSON.stringify(res.reply);
      setTurns((t) => [
        ...t,
        { role: "assistant", text: reply, citations: res.citations },
      ]);
    } catch {
      setTurns((t) => [
        ...t,
        { role: "assistant", text: "Sorry — something went wrong. Try again." },
      ]);
    } finally {
      setSending(false);
    }
  }

  const canSend = input.trim().length > 0 && !sending;

  return (
    <PublicFrame>
      {state === "loading" && (
        <div style={{ ...PUBLIC_CARD, width: "100%", maxWidth: 440 }}>
          <div
            style={{
              padding: "28px 24px",
              fontSize: 13,
              color: "var(--ink-3)",
            }}
          >
            Loading…
          </div>
        </div>
      )}

      {state === "notfound" && (
        <div
          style={{
            ...PUBLIC_CARD,
            width: "100%",
            maxWidth: 440,
            padding: "36px 28px",
          }}
        >
          <PublicNotice
            icon="alert"
            title="Chat not found"
            body="This chat doesn't exist or is no longer available."
          />
        </div>
      )}

      {state === "ready" && def && (
        <div
          style={{
            ...PUBLIC_CARD,
            width: "100%",
            maxWidth: 440,
            height: "min(600px, 80vh)",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          {/* header: brand tile · assistant name · Online dot */}
          <div
            style={{
              flex: "none",
              padding: "16px 20px",
              borderBottom: "1px solid var(--line)",
              display: "flex",
              alignItems: "center",
              gap: 11,
            }}
          >
            <Logo size={34} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 700 }}>
                {def.title ?? "Chat"}
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: "var(--state-done)",
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
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
                Online
                {def.description ? ` · ${def.description}` : ""}
              </div>
            </div>
          </div>

          {/* thread */}
          <div
            ref={scrollRef}
            style={{
              flex: 1,
              overflowY: "auto",
              padding: "18px 18px 12px",
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            {turns.map((t, i) =>
              t.role === "assistant" ? (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 9,
                    animation: "naaryFadeUp .25s ease",
                  }}
                >
                  <Logo size={26} glow={false} />
                  <div
                    style={{
                      maxWidth: "76%",
                      display: "flex",
                      flexDirection: "column",
                      gap: 7,
                    }}
                  >
                    <div
                      style={{
                        background: "var(--card)",
                        border: "1px solid var(--line-mid)",
                        borderRadius: 12,
                        borderTopLeftRadius: 4,
                        padding: "11px 14px",
                        fontSize: 12.5,
                        lineHeight: 1.55,
                        color: "var(--ink-soft)",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                      }}
                    >
                      {t.text}
                    </div>
                    {t.citations && t.citations.length > 0 && (
                      <Sources citations={t.citations} />
                    )}
                  </div>
                </div>
              ) : (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    justifyContent: "flex-end",
                    animation: "naaryFadeUp .25s ease",
                  }}
                >
                  <div
                    style={{
                      maxWidth: "72%",
                      background: EMBER_TINT_BG,
                      border: `1px solid ${EMBER_TINT_BD}`,
                      borderRadius: 12,
                      borderTopRightRadius: 4,
                      padding: "11px 14px",
                      fontSize: 12.5,
                      lineHeight: 1.55,
                      color: "var(--ink)",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                    }}
                  >
                    {t.text}
                  </div>
                </div>
              ),
            )}

            {/* typing indicator while the graph runs */}
            {sending && (
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 9,
                  animation: "naaryFadeUp .2s ease",
                }}
              >
                <Logo size={26} glow={false} />
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
                  {[0, 0.2, 0.4].map((delay) => (
                    <span
                      key={delay}
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        background: "var(--ink-faint)",
                        animation: `naaryPubDot 1.2s infinite ${delay}s`,
                      }}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* input row */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
            style={{
              flex: "none",
              borderTop: "1px solid var(--line)",
              padding: "12px 16px",
            }}
          >
            <div
              style={{
                border: "1px solid var(--line-2)",
                background: "var(--card)",
                borderRadius: 11,
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 6px 6px 13px",
              }}
            >
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={def.placeholder ?? "Ask a question…"}
                aria-label="Chat message"
                disabled={sending}
                style={{
                  flex: 1,
                  height: 34,
                  background: "transparent",
                  border: "none",
                  fontSize: 12.5,
                  color: "var(--ink)",
                  fontFamily: "var(--font-sans)",
                  outline: "none",
                }}
              />
              <button
                type="submit"
                aria-label="Send"
                disabled={!canSend}
                style={{
                  width: 36,
                  height: 36,
                  flex: "none",
                  borderRadius: 9,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: canSend ? "pointer" : "not-allowed",
                  ...(canSend
                    ? EMBER_BUTTON
                    : {
                        border: "1px solid var(--line-2)",
                        background: "var(--card-2)",
                        color: "var(--ink-3)",
                        boxShadow: "none",
                      }),
                }}
              >
                <Icon name="arrow-right" size={15} strokeWidth={2} />
              </button>
            </div>
          </form>
        </div>
      )}

      <div style={{ marginTop: 16, fontSize: 10, color: "var(--ink-3)" }}>
        Powered by Naary
      </div>
    </PublicFrame>
  );
}
