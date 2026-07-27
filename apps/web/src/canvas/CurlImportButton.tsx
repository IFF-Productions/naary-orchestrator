/**
 * "Import from cURL" affordance for the httpRequest node inspector. Pastes a `curl …` command,
 * parses it (pure, in @naary/dsl), and applies method/url/headers/query/body to the node. Auth
 * material (Authorization/Cookie headers, `-u`) is stripped by the parser and surfaced as a warning
 * — it belongs on a connection, never in the graph.
 */
import { useState } from "react";
import { type CurlImportResult, parseCurl } from "@naary/dsl";

export function CurlImportButton({
  onApply,
}: {
  onApply: (config: CurlImportResult["config"]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | undefined>();

  function doImport() {
    try {
      const { config, warnings } = parseCurl(text);
      onApply(config);
      setWarnings(warnings);
      setError(undefined);
      setText("");
      setOpen(false);
    } catch (e) {
      // Clear any prior successful import's warnings so they aren't misread as this failure's.
      setWarnings([]);
      setError(e instanceof Error ? e.message : "Couldn't parse that cURL.");
    }
  }

  return (
    <div style={{ marginBottom: 10 }}>
      {!open ? (
        <button
          type="button"
          onClick={() => {
            setOpen(true);
            setError(undefined);
          }}
          style={{
            all: "unset",
            cursor: "pointer",
            fontSize: "var(--text-xs)",
            color: "var(--brand)",
            fontWeight: 600,
          }}
        >
          ↧ Import from cURL
        </button>
      ) : (
        <div
          style={{
            border: "1px solid var(--line)",
            borderRadius: 8,
            padding: 8,
            background: "var(--bg-2)",
          }}
        >
          <textarea
            autoFocus
            aria-label="cURL command to import"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={
              "curl 'https://api.example.com/v1/things' \\\n  -H 'Accept: application/json'"
            }
            rows={5}
            style={{
              width: "100%",
              boxSizing: "border-box",
              fontFamily: "var(--font-mono, monospace)",
              fontSize: "var(--text-xs)",
              padding: 8,
              borderRadius: 6,
              border: "1px solid var(--line-2)",
              background: "var(--card)",
              color: "var(--ink)",
              resize: "vertical",
            }}
          />
          {error && (
            <div
              style={{
                fontSize: "var(--text-xs)",
                color: "var(--state-error)",
                marginTop: 4,
              }}
            >
              {error}
            </div>
          )}
          <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
            <button
              type="button"
              disabled={!text.trim()}
              onClick={doImport}
              style={{
                all: "unset",
                cursor: text.trim() ? "pointer" : "default",
                padding: "5px 10px",
                borderRadius: 6,
                background: "var(--brand)",
                color: "var(--brand-ink, #fff)",
                fontSize: "var(--text-xs)",
                opacity: text.trim() ? 1 : 0.5,
              }}
            >
              Import
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setText("");
                setError(undefined);
              }}
              style={{
                all: "unset",
                cursor: "pointer",
                padding: "5px 10px",
                borderRadius: 6,
                color: "var(--ink-2)",
                fontSize: "var(--text-xs)",
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {warnings.length > 0 && (
        <ul
          style={{
            margin: "6px 0 0",
            paddingLeft: 16,
            fontSize: "var(--text-xs)",
            color: "var(--state-paused)",
          }}
        >
          {warnings.map((w, i) => (
            // Warnings can repeat (e.g. two unrecognized flags) → index-composite key, not the string.
            <li key={`${i}:${w}`}>{w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
