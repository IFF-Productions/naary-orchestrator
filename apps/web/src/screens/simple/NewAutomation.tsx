import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { GraphDef } from "@naary/dsl";
import { Button } from "../../components";
import { api } from "../../lib/api";
import { AutomationEditor } from "./AutomationEditor";

const EXAMPLES = [
  "When a webhook arrives, have the AI summarize it, wait for my approval, then email me the summary.",
  "Every weekday at 9am, ask the AI for a motivational quote and email it to me.",
  "When a customer message comes in, classify it and, if it's urgent, wait for my approval before replying.",
];

/** Simple-mode create flow (design PRODUCT-VARIANTS.md §5): describe it → the AI builder drafts a
 *  graph → review it as a step list. No canvas. */
export function NewAutomation() {
  const navigate = useNavigate();
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ name: string; graph: GraphDef } | null>(
    null,
  );

  async function generate() {
    if (prompt.trim().length < 3) return;
    setBusy(true);
    setErr(null);
    try {
      setDraft(await api.generateGraph(prompt.trim()));
    } catch {
      setErr(
        "Couldn't build that. Try rephrasing — and make sure your AI provider is connected (Settings → Connect AI).",
      );
    } finally {
      setBusy(false);
    }
  }

  if (draft) {
    return (
      <AutomationEditor initialName={draft.name} initialGraph={draft.graph} />
    );
  }

  return (
    <div style={{ padding: "22px 28px 40px", maxWidth: 720 }}>
      <button
        type="button"
        onClick={() => navigate("/app/automations")}
        style={{
          all: "unset",
          cursor: "pointer",
          fontSize: "var(--text-sm)",
          color: "var(--ink-2)",
        }}
      >
        ← Automations
      </button>
      <div
        style={{
          fontSize: "var(--text-title)",
          fontWeight: "var(--weight-bold)",
          color: "var(--ink)",
          letterSpacing: "var(--tracking-tight)",
          margin: "10px 0 4px",
        }}
      >
        What do you want to automate?
      </div>
      <div
        style={{
          fontSize: "var(--text-body)",
          color: "var(--ink-2)",
          marginBottom: 16,
        }}
      >
        Describe it in plain English. The AI turns it into steps you can review.
      </div>

      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="e.g. When a support email arrives, summarize it and ask me to approve a reply…"
        rows={4}
        style={{
          width: "100%",
          padding: "11px 13px",
          borderRadius: "var(--radius-md)",
          border: "1px solid var(--line-2)",
          background: "var(--card)",
          color: "var(--ink)",
          fontSize: "var(--text-body)",
          resize: "vertical",
          fontFamily: "var(--font-sans)",
        }}
      />
      {err && (
        <div
          style={{
            fontSize: "var(--text-sm)",
            color: "var(--state-error)",
            marginTop: 8,
          }}
        >
          {err}
        </div>
      )}
      <div style={{ marginTop: 12 }}>
        <Button
          variant="primary"
          icon="bolt"
          disabled={busy || prompt.trim().length < 3}
          onClick={generate}
        >
          {busy ? "Building…" : "Build it"}
        </Button>
      </div>

      <div style={{ marginTop: 26 }}>
        <div
          style={{
            fontSize: "var(--text-xs)",
            fontWeight: "var(--weight-semibold)",
            letterSpacing: "var(--tracking-label)",
            textTransform: "uppercase",
            color: "var(--ink-3)",
            marginBottom: 8,
          }}
        >
          Try one of these
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              onClick={() => setPrompt(ex)}
              style={{
                all: "unset",
                cursor: "pointer",
                boxSizing: "border-box",
                width: "100%",
                padding: "10px 12px",
                borderRadius: "var(--radius-md)",
                border: "1px solid var(--line)",
                background: "var(--card)",
                color: "var(--ink-2)",
                fontSize: "var(--text-sm)",
              }}
            >
              {ex}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
