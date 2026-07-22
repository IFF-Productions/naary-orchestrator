// AI workflow-builder panel: describe a flow in plain English → an agent drafts it onto
// the canvas. Shown under the top bar when toggled (extracted verbatim from CanvasPage).
import { Button } from "../../components";
import { PROVIDERS } from "./fields";

export function AiPromptPanel({
  aiPrompt,
  onPromptChange,
  genProvider,
  onProviderChange,
  generating,
  onGenerate,
}: {
  aiPrompt: string;
  onPromptChange: (v: string) => void;
  genProvider: string;
  onProviderChange: (v: string) => void;
  generating: boolean;
  onGenerate: () => void;
}) {
  return (
    <div
      style={{
        padding: "12px 16px",
        borderBottom: "1px solid var(--line)",
        background: "var(--surface)",
      }}
    >
      <div
        style={{
          fontSize: "var(--text-xs)",
          color: "var(--ink-3)",
          marginBottom: 6,
        }}
      >
        Describe the workflow in plain English — an agent drafts it onto the
        canvas for you to edit. (Uses your model provider key from
        Integrations.)
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
        <textarea
          value={aiPrompt}
          onChange={(e) => onPromptChange(e.target.value)}
          placeholder="e.g. When a webhook comes in, have an agent summarize it, wait for my approval, then email the summary to my team."
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
            {generating ? "Generating…" : "Generate"}
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
        Generating replaces the current canvas with a new draft. ⌘/Ctrl+Enter to
        generate.
      </div>
    </div>
  );
}
