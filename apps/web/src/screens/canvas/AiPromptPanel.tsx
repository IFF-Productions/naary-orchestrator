// AI workflow-builder panel: describe a flow in plain English → an agent drafts it onto
// the canvas. Shown under the top bar when toggled (extracted verbatim from CanvasPage).
import { Button } from "../../components";
import { PROVIDERS } from "./fields";
import type { AiMode } from "./useAiBuilder";

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
            editing
              ? "e.g. If there are no open incidents, end the run instead of failing."
              : "e.g. When a webhook comes in, have an agent summarize it, wait for my approval, then email the summary to my team."
          }
          rows={2}
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
