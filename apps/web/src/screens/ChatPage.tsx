import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { Button, Icon, Logo } from "../components";
import { api, type ChatDefinition } from "../lib/api";

/**
 * PUBLIC hosted chat (Chat Trigger program). Reached at `/c/:chatId`, OUTSIDE RequireAuth — an
 * anonymous visitor loads the widget definition and exchanges messages; each message starts the
 * tenant's workflow with `{ message, sessionId }` and shows the graph's reply. No auth, no tenant
 * identifiers. Single-turn per message today (durable per-session memory is a later slice); the
 * client keeps a `sessionId` so a future durable session can thread the conversation.
 */
type Turn = { role: "user" | "assistant"; text: string };

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
  }, [turns]);

  async function send() {
    const text = input.trim();
    if (!text || !chatId || sending) return;
    setInput("");
    setTurns((t) => [...t, { role: "user", text }]);
    setSending(true);
    try {
      const res = await api.sendChatMessage(chatId, text, sessionId.current);
      const reply =
        res.reply == null
          ? "…"
          : typeof res.reply === "string"
            ? res.reply
            : typeof (res.reply as { reply?: unknown }).reply === "string"
              ? String((res.reply as { reply?: unknown }).reply)
              : JSON.stringify(res.reply);
      setTurns((t) => [...t, { role: "assistant", text: reply }]);
    } catch {
      setTurns((t) => [
        ...t,
        { role: "assistant", text: "Sorry — something went wrong. Try again." },
      ]);
    } finally {
      setSending(false);
    }
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--bg)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "32px 20px",
      }}
    >
      <div style={{ marginBottom: 18 }}>
        <Logo />
      </div>

      <div
        style={{
          width: "100%",
          maxWidth: 560,
          height: "72vh",
          display: "flex",
          flexDirection: "column",
          background: "var(--card)",
          border: "1px solid var(--line)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "var(--shadow-card)",
          overflow: "hidden",
        }}
      >
        {state === "loading" && (
          <div style={{ padding: 24, color: "var(--ink-3)" }}>Loading…</div>
        )}

        {state === "notfound" && (
          <div style={{ textAlign: "center", padding: 40 }}>
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: "var(--radius-full)",
                background: "var(--card-2)",
                color: "var(--ink-3)",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                marginBottom: 14,
              }}
            >
              <Icon name="alert" size={20} />
            </div>
            <div
              style={{
                fontSize: "var(--text-md)",
                fontWeight: "var(--weight-semibold)",
                color: "var(--ink)",
              }}
            >
              Chat not found
            </div>
          </div>
        )}

        {state === "ready" && def && (
          <>
            <div
              style={{
                padding: "14px 18px",
                borderBottom: "1px solid var(--line)",
              }}
            >
              <div
                style={{
                  fontSize: "var(--text-md)",
                  fontWeight: "var(--weight-bold)",
                  color: "var(--ink)",
                }}
              >
                {def.title ?? "Chat"}
              </div>
              {def.description && (
                <div
                  style={{
                    fontSize: "var(--text-xs)",
                    color: "var(--ink-3)",
                    marginTop: 2,
                  }}
                >
                  {def.description}
                </div>
              )}
            </div>

            <div
              ref={scrollRef}
              style={{
                flex: 1,
                overflowY: "auto",
                padding: 16,
                display: "flex",
                flexDirection: "column",
                gap: 10,
              }}
            >
              {turns.map((t, i) => (
                <div
                  key={i}
                  style={{
                    alignSelf: t.role === "user" ? "flex-end" : "flex-start",
                    maxWidth: "80%",
                    padding: "8px 12px",
                    borderRadius: "var(--radius-md)",
                    fontSize: "var(--text-body)",
                    lineHeight: "var(--leading-snug)",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    background:
                      t.role === "user" ? "var(--brand)" : "var(--card-2)",
                    color: t.role === "user" ? "#fff" : "var(--ink)",
                  }}
                >
                  {t.text}
                </div>
              ))}
              {sending && (
                <div
                  style={{
                    alignSelf: "flex-start",
                    fontSize: "var(--text-xs)",
                    color: "var(--ink-3)",
                    padding: "4px 8px",
                  }}
                >
                  …
                </div>
              )}
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
              style={{
                display: "flex",
                gap: 8,
                padding: 12,
                borderTop: "1px solid var(--line)",
              }}
            >
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={def.placeholder ?? "Type a message…"}
                disabled={sending}
                style={{
                  flex: 1,
                  padding: "9px 11px",
                  borderRadius: "var(--radius-sm)",
                  border: "1px solid var(--line-2)",
                  background: "var(--card)",
                  color: "var(--ink)",
                  fontSize: "var(--text-body)",
                  fontFamily: "inherit",
                }}
              />
              <Button
                type="submit"
                variant="primary"
                disabled={sending || !input.trim()}
              >
                Send
              </Button>
            </form>
          </>
        )}
      </div>

      <div
        style={{
          marginTop: 16,
          fontSize: "var(--text-2xs)",
          color: "var(--ink-3)",
        }}
      >
        Powered by Naary
      </div>
    </div>
  );
}
