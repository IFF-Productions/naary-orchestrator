// Optional run-input (JSON) panel: overrides the Start node's sample input for the next
// run; shown under the top bar when toggled (extracted verbatim from CanvasPage).

export function RunInputPanel({
  runInput,
  onChange,
}: {
  runInput: string;
  onChange: (v: string) => void;
}) {
  return (
    <div
      style={{
        padding: "10px 16px",
        borderBottom: "1px solid var(--line)",
        background: "var(--surface)",
      }}
    >
      <div
        style={{
          fontSize: "var(--text-xs)",
          color: "var(--ink-3)",
          marginBottom: 4,
        }}
      >
        Run input (JSON) — overrides the Start node's sample input for this run;
        leave blank to use the sample.
      </div>
      <textarea
        value={runInput}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        spellCheck={false}
        className="mono"
        placeholder={'{\n  "message": "I was charged twice"\n}'}
        style={{
          width: "100%",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs)",
          padding: "7px 9px",
          borderRadius: "var(--radius-sm)",
          border: "1px solid var(--line-2)",
          background: "var(--card)",
          color: "var(--ink)",
          resize: "vertical",
        }}
      />
    </div>
  );
}
