/**
 * Import an n8n workflow (#579).
 *
 * The screen's job is not "upload a file" — it is to be **honest about fidelity before anything is
 * saved**. So the flow is deliberately two-step: translate first, show the per-node report and the
 * workflow-level warnings, and only then offer to save. A user who imports and immediately runs a
 * workflow whose credentials are missing and whose `$now` expressions silently resolve to empty is a
 * worse outcome than one who reads three rows of "you need to fix this".
 *
 * Saving reuses the existing draft path (`POST /graphs`, then navigate to the canvas) — the same
 * hand-off BuildWithAi uses, because an import is just another way to arrive at an unsaved draft.
 */
import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "../../components";
import { api } from "../../lib/api";
import type { N8nImportResult, N8nNodeReport } from "../../lib/api";

/** Same slug rule BuildWithAi uses for a generated draft's workflowKey. */
function slugifyName(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || `imported-${Date.now()}`;
}

const STATUS_COLOR: Record<N8nNodeReport["status"], string> = {
  imported: "var(--ok, var(--brand))",
  approximated: "var(--warn, #b8860b)",
  unmapped: "var(--danger, #c0392b)",
  skipped: "var(--ink-3)",
};

const STATUS_BLURB: Record<N8nNodeReport["status"], string> = {
  imported: "Faithful — does what it did in n8n.",
  approximated: "Runs, but something was reshaped. Read the note.",
  unmapped:
    "No equivalent. Imported as a placeholder that does nothing; its original n8n config is kept on the node.",
  skipped:
    "Deliberately not a step (an annotation, a disabled node, or an AI sub-node).",
};

const card: React.CSSProperties = {
  border: "1px solid var(--line-mid)",
  background: "var(--card)",
  borderRadius: "var(--radius-sm)",
  padding: "14px 16px",
};

export function ImportN8n() {
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<N8nImportResult | null>(null);

  const counts = result?.counts;
  const attention = useMemo(
    () => (result ? result.nodes.filter((n) => n.status !== "imported") : []),
    [result],
  );

  const translate = useCallback(async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    let parsed: unknown;
    try {
      // Parsed in the BROWSER so a syntax error reads as "that isn't valid JSON" rather than an
      // opaque 400 from the API.
      parsed = JSON.parse(text);
    } catch {
      setError("That isn't valid JSON. Paste the whole n8n workflow export.");
      setBusy(false);
      return;
    }
    try {
      setResult(await api.importN8nWorkflow(parsed));
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Could not read that as an n8n workflow.",
      );
    } finally {
      setBusy(false);
    }
  }, [text]);

  const onFile = useCallback((file: File | undefined) => {
    if (!file) return;
    setError(null);
    void file.text().then(setText);
  }, []);

  const save = useCallback(async () => {
    if (!result) return;
    setSaving(true);
    setError(null);
    try {
      const key = slugifyName(result.name);
      await api.saveGraph(key, result.name, result.graph);
      navigate(`/app/canvas?key=${encodeURIComponent(key)}`);
    } catch (e) {
      setSaving(false);
      setError(
        e instanceof Error
          ? e.message
          : "Could not save the imported workflow.",
      );
    }
  }, [navigate, result]);

  return (
    <div style={{ maxWidth: 860 }}>
      <h1
        style={{
          fontSize: "var(--text-lg)",
          fontWeight: "var(--weight-bold)",
          color: "var(--ink)",
          margin: 0,
        }}
      >
        Import from n8n
      </h1>
      <p
        style={{
          fontSize: "var(--text-sm)",
          color: "var(--ink-2)",
          lineHeight: "var(--leading-snug)",
          marginTop: 6,
          marginBottom: 18,
        }}
      >
        Paste an n8n workflow export (or pick the <code>.json</code> file).
        Nothing is saved until you have read the report — and{" "}
        <strong>credentials are never imported</strong>: you will reconnect them
        here.
      </p>

      <div style={{ ...card, marginBottom: 16 }}>
        <input
          type="file"
          accept="application/json,.json"
          onChange={(e) => onFile(e.target.files?.[0])}
          style={{ fontSize: "var(--text-sm)", marginBottom: 10 }}
        />
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder='{ "name": "My workflow", "nodes": [...], "connections": {...} }'
          spellCheck={false}
          rows={10}
          className="mono"
          style={{
            width: "100%",
            fontSize: "var(--text-xs)",
            color: "var(--ink)",
            background: "var(--card-2)",
            border: "1px solid var(--line-mid)",
            borderRadius: "var(--radius-xs)",
            padding: 10,
            resize: "vertical",
          }}
        />
        <div
          style={{
            display: "flex",
            gap: 12,
            alignItems: "center",
            marginTop: 10,
          }}
        >
          <Button
            variant="primary"
            disabled={busy || !text.trim()}
            onClick={() => void translate()}
          >
            {busy ? "Translating…" : "Translate"}
          </Button>
          {error && (
            <span
              style={{
                fontSize: "var(--text-sm)",
                color: "var(--danger, #c0392b)",
              }}
            >
              {error}
            </span>
          )}
        </div>
      </div>

      {result && counts && (
        <>
          <div style={{ ...card, marginBottom: 16 }}>
            <div
              style={{
                fontSize: "var(--text-md)",
                fontWeight: "var(--weight-semibold)",
                color: "var(--ink)",
              }}
            >
              {result.name}
            </div>
            <div
              style={{
                display: "flex",
                gap: 14,
                flexWrap: "wrap",
                marginTop: 8,
                fontSize: "var(--text-sm)",
              }}
            >
              {(
                ["imported", "approximated", "unmapped", "skipped"] as const
              ).map((s) => (
                <span key={s} style={{ color: STATUS_COLOR[s] }}>
                  <strong>{counts[s] ?? 0}</strong> {s}
                </span>
              ))}
              <span style={{ color: "var(--ink-3)" }}>
                {result.graph.nodes.length} nodes · {result.graph.edges.length}{" "}
                edges
              </span>
            </div>
          </div>

          {result.warnings.length > 0 && (
            <div style={{ ...card, marginBottom: 16 }}>
              <div style={{ ...sectionTitle }}>Read before saving</div>
              <ul style={listStyle}>
                {result.warnings.map((w) => (
                  <li key={w} style={{ marginBottom: 5 }}>
                    {w}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {result.credentials.length > 0 && (
            <div style={{ ...card, marginBottom: 16 }}>
              <div style={sectionTitle}>
                Connections to create ({result.credentials.length})
              </div>
              <ul style={listStyle}>
                {result.credentials.map((c) => (
                  <li key={c.n8nType} style={{ marginBottom: 5 }}>
                    <code>{c.n8nType}</code>
                    {c.suggestedConnectionType ? (
                      <>
                        {" → create a "}
                        <strong>{c.suggestedConnectionType}</strong> connection
                      </>
                    ) : (
                      " → no direct equivalent here"
                    )}
                    <span style={{ color: "var(--ink-3)" }}>
                      {" "}
                      (used by {c.usedBy.join(", ")})
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {attention.length > 0 && (
            <div style={{ ...card, marginBottom: 16 }}>
              <div style={sectionTitle}>
                Nodes needing attention ({attention.length})
              </div>
              {attention.map((n) => (
                <div
                  key={`${n.n8nName}-${n.n8nType}`}
                  style={{
                    paddingTop: 10,
                    marginTop: 10,
                    borderTop: "1px solid var(--line-soft, var(--line-mid))",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      gap: 8,
                      alignItems: "baseline",
                      flexWrap: "wrap",
                    }}
                  >
                    <strong
                      style={{
                        fontSize: "var(--text-sm)",
                        color: "var(--ink)",
                      }}
                    >
                      {n.n8nName}
                    </strong>
                    <span
                      style={{
                        fontSize: "var(--text-xs)",
                        color: STATUS_COLOR[n.status],
                        fontWeight: "var(--weight-semibold)",
                      }}
                    >
                      {n.status}
                    </span>
                    <code
                      style={{
                        fontSize: 10,
                        color: "var(--ink-faint)",
                      }}
                    >
                      {n.n8nType}
                      {n.nodeType ? ` → ${n.nodeType}` : ""}
                    </code>
                  </div>
                  <div
                    style={{
                      fontSize: "var(--text-xs)",
                      color: "var(--ink-3)",
                      marginTop: 2,
                    }}
                  >
                    {STATUS_BLURB[n.status]}
                  </div>
                  <ul style={{ ...listStyle, marginTop: 5 }}>
                    {n.notes.map((note) => (
                      <li key={note} style={{ marginBottom: 3 }}>
                        {note}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}

          {result.unconvertedExpressions.length > 0 && (
            <div style={{ ...card, marginBottom: 16 }}>
              <div style={sectionTitle}>
                Expressions to rewrite ({result.unconvertedExpressions.length})
              </div>
              <div
                style={{
                  fontSize: "var(--text-xs)",
                  color: "var(--ink-3)",
                  marginBottom: 6,
                }}
              >
                Kept exactly as n8n wrote them so you can see what to change.
                Until you do, each resolves to an empty value.
              </div>
              <ul style={listStyle}>
                {result.unconvertedExpressions.map((u, i) => (
                  <li
                    key={`${u.nodeId}-${u.field}-${i}`}
                    style={{ marginBottom: 5 }}
                  >
                    <code>{u.nodeId}</code>.<code>{u.field}</code>:{" "}
                    <code>{u.expression}</code>
                    <div style={{ color: "var(--ink-3)" }}>{u.reason}</div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <Button
              variant="primary"
              disabled={saving}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save & open in canvas"}
            </Button>
            <span style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}>
              Saves as a new workflow. It is never activated automatically.
            </span>
          </div>
        </>
      )}
    </div>
  );
}

const sectionTitle: React.CSSProperties = {
  fontSize: "var(--text-sm)",
  fontWeight: "var(--weight-semibold)",
  color: "var(--ink)",
  marginBottom: 6,
};

const listStyle: React.CSSProperties = {
  margin: 0,
  paddingLeft: 18,
  fontSize: "var(--text-xs)",
  lineHeight: "var(--leading-snug)",
  color: "var(--ink-2)",
};
