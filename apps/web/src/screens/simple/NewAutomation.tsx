import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { GraphDef, NodeType } from "@naary/dsl";
import { Button } from "../../components";
import { api } from "../../lib/api";
import { nodeDisplayLabel } from "../../lib/graph-model";
import {
  nextProgressMessage,
  PROGRESS_MESSAGES,
} from "../../lib/progress-messages";
import { AutomationEditor } from "./AutomationEditor";

const EXAMPLES = [
  "When a webhook arrives, have the AI summarize it, wait for my approval, then email me the summary.",
  "Every weekday at 9am, ask the AI for a motivational quote and email it to me.",
  "When a customer message comes in, classify it and, if it's urgent, wait for my approval before replying.",
];

/** A step surfaced live as the AI streams the workflow (no canvas in Simple mode — we
 *  show a friendly, growing list of steps instead). */
interface LiveStep {
  id: string;
  label: string;
}

/** Simple-mode create flow (design PRODUCT-VARIANTS.md §5): describe it → the AI builder drafts a
 *  graph → review it as a step list. No canvas. As the AI streams the graph, the steps appear
 *  live with a playful rotating status. */
export function NewAutomation() {
  const navigate = useNavigate();
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ name: string; graph: GraphDef } | null>(
    null,
  );
  // Live streaming state.
  const [steps, setSteps] = useState<LiveStep[]>([]);
  const [liveName, setLiveName] = useState<string | null>(null);
  const [genMessage, setGenMessage] = useState<string>(PROGRESS_MESSAGES[0]);

  // Rotate the playful message on a ~2.5s timer while building (no immediate repeat).
  useEffect(() => {
    if (!busy) return;
    setGenMessage((prev) => nextProgressMessage(prev));
    const id = setInterval(
      () => setGenMessage((prev) => nextProgressMessage(prev)),
      2500,
    );
    return () => clearInterval(id);
  }, [busy]);

  async function generate() {
    if (prompt.trim().length < 3) return;
    setBusy(true);
    setErr(null);
    setSteps([]);
    setLiveName(null);
    const seen = new Set<string>();
    try {
      const result = await api.generateGraphStream(prompt.trim(), undefined, {
        onMeta: (name) => setLiveName(name),
        onNode: (node) => {
          const n = node as {
            id?: string;
            type?: string;
            config?: unknown;
          } | null;
          if (!n || typeof n.id !== "string" || typeof n.type !== "string")
            return;
          if (seen.has(n.id)) return;
          seen.add(n.id);
          const label = nodeDisplayLabel(
            n.type as NodeType,
            (n.config ?? undefined) as Record<string, unknown> | undefined,
          );
          setSteps((s) => [...s, { id: n.id as string, label }]);
        },
      });
      setDraft(result);
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
        disabled={busy}
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
          loading={busy}
          disabled={busy || prompt.trim().length < 3}
          onClick={generate}
        >
          {busy ? "Building…" : "Build it"}
        </Button>
      </div>

      {busy ? (
        <BuildingProgress message={genMessage} name={liveName} steps={steps} />
      ) : (
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
      )}
    </div>
  );
}

/** The live "building it" card: spinner + rotating status + the steps as they stream in. */
function BuildingProgress({
  message,
  name,
  steps,
}: {
  message: string;
  name: string | null;
  steps: LiveStep[];
}) {
  return (
    <div
      style={{
        marginTop: 22,
        padding: "16px 18px",
        borderRadius: "var(--radius-lg)",
        border: "1px solid var(--line)",
        background: "var(--card)",
        boxShadow: "var(--shadow-card)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span className="naary-gen-spinner" aria-hidden="true" />
        <div style={{ minWidth: 0 }}>
          <div
            key={message}
            className="naary-gen-msg"
            style={{
              fontSize: "var(--text-body)",
              fontWeight: "var(--weight-medium, 500)",
              color: "var(--ink)",
            }}
          >
            {message}
          </div>
          {name && (
            <div
              style={{
                fontSize: "var(--text-xs)",
                color: "var(--ink-3)",
                marginTop: 2,
              }}
            >
              Building “{name}”
            </div>
          )}
        </div>
      </div>
      {steps.length > 0 && (
        <ol
          style={{
            listStyle: "none",
            margin: "14px 0 0",
            padding: 0,
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          {steps.map((s, i) => (
            <li
              key={s.id}
              className="naary-step-enter"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                fontSize: "var(--text-sm)",
                color: "var(--ink-2)",
              }}
            >
              <span
                style={{
                  flex: "none",
                  width: 20,
                  height: 20,
                  borderRadius: "50%",
                  background: "var(--surface)",
                  border: "1px solid var(--line)",
                  color: "var(--ink-3)",
                  fontSize: "var(--text-2xs)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {i + 1}
              </span>
              <span>{s.label}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
