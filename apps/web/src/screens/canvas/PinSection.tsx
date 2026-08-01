// Pinned-output (authoring sample) section + copy/webhook/row-header helpers (extracted from CanvasPage).
import { useState } from "react";
import { Button } from "../../components";
import type { TestNodeResult } from "../../lib/api";
import { jsonErrorText } from "../../lib/json-error";

/**
 * Data pinning (design SINGLE-NODE-EXECUTION.md slice 1): pin a sample output for this node so you
 * can build downstream nodes against it without re-running upstream. Authoring-only — the
 * interpreter never reads pins. Source in slice 1 is a manual JSON paste (single-node "Test" that
 * fills it is slice 2).
 */
export function PinSection({
  canPin,
  isPinned,
  pinnedOutput,
  onPin,
  onUnpin,
  onTest,
}: {
  canPin: boolean;
  isPinned: boolean;
  pinnedOutput: unknown;
  onPin: (output: unknown) => Promise<void>;
  onUnpin: () => Promise<void>;
  onTest: (autofillUpstream?: boolean) => Promise<TestNodeResult>;
}) {
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState<TestNodeResult | null>(null);
  const [autofill, setAutofill] = useState(false);

  async function runTest() {
    setTesting(true);
    setErr(null);
    setTested(null);
    try {
      setTested(await onTest(autofill));
    } catch {
      setErr("Test failed — save the workflow, then try again.");
    } finally {
      setTesting(false);
    }
  }

  const label = (
    <div
      style={{
        fontSize: "var(--text-xs)",
        color: "var(--ink-3)",
        marginBottom: 6,
      }}
    >
      📌 Pinned sample — authoring only; the interpreter never uses it (a real
      run always executes upstream).
    </div>
  );

  if (!canPin) {
    return (
      <div
        style={{
          padding: "8px 10px",
          borderRadius: "var(--radius-md)",
          border: "1px dashed var(--line-2)",
          background: "var(--card-2)",
        }}
      >
        {label}
        <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}>
          Save the workflow first to pin a sample output.
        </div>
      </div>
    );
  }

  async function pin() {
    setErr(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(draft);
    } catch (e) {
      setErr(jsonErrorText(e));
      return;
    }
    setBusy(true);
    try {
      await onPin(parsed);
      setDraft("");
    } catch {
      setErr("Could not save the pin.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        padding: "8px 10px",
        borderRadius: "var(--radius-md)",
        border: "1px solid var(--line-2)",
        background: "var(--card-2)",
      }}
    >
      {label}

      {/* Single-node Test: run this node against pins → output you can pin. Optionally auto-run
          + pin un-pinned upstream first (slice 4). */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 10,
        }}
      >
        <Button
          variant="secondary"
          size="sm"
          icon="bolt"
          disabled={testing}
          onClick={runTest}
        >
          {testing ? "Testing…" : "Test node"}
        </Button>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
            fontSize: "var(--text-xs)",
            color: "var(--ink-3)",
            cursor: "pointer",
          }}
          title="Run + pin any un-pinned upstream nodes first (can call real activities)"
        >
          <input
            type="checkbox"
            checked={autofill}
            onChange={(e) => setAutofill(e.target.checked)}
          />
          auto-fill upstream
        </label>
      </div>
      {tested && tested.pure && (
        <div style={{ marginBottom: 10 }}>
          <pre
            className="mono"
            style={{
              margin: 0,
              maxHeight: 160,
              overflow: "auto",
              fontSize: "var(--text-xs)",
              color: "var(--ink)",
              background: "var(--card)",
              border: "1px solid var(--line-2)",
              borderRadius: "var(--radius-sm)",
              padding: "6px 8px",
            }}
          >
            {JSON.stringify(tested.output, null, 2)}
          </pre>
          <div style={{ marginTop: 6 }}>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                onPin(tested.output).finally(() => setBusy(false));
              }}
            >
              Pin this output
            </Button>
          </div>
        </div>
      )}
      {tested && !tested.pure && (
        <div
          style={{
            fontSize: "var(--text-xs)",
            color: "var(--ink-3)",
            marginBottom: 10,
          }}
        >
          {tested.message}
        </div>
      )}

      {isPinned ? (
        <>
          <pre
            className="mono"
            style={{
              margin: 0,
              maxHeight: 160,
              overflow: "auto",
              fontSize: "var(--text-xs)",
              color: "var(--ink)",
              background: "var(--card)",
              border: "1px solid var(--line-2)",
              borderRadius: "var(--radius-sm)",
              padding: "6px 8px",
            }}
          >
            {JSON.stringify(pinnedOutput, null, 2)}
          </pre>
          <div style={{ marginTop: 8 }}>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                onUnpin().finally(() => setBusy(false));
              }}
            >
              Unpin
            </Button>
          </div>
        </>
      ) : (
        <>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={'{\n  "example": "output"\n}'}
            spellCheck={false}
            className="mono"
            style={{
              width: "100%",
              minHeight: 64,
              resize: "vertical",
              fontSize: "var(--text-xs)",
              padding: "6px 8px",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--line-2)",
              background: "var(--card)",
              color: "var(--ink)",
            }}
          />
          {err && (
            <div
              style={{
                fontSize: "var(--text-xs)",
                color: "var(--state-error)",
                marginTop: 4,
              }}
            >
              {err}
            </div>
          )}
          <div style={{ marginTop: 8 }}>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy || !draft.trim()}
              onClick={pin}
            >
              Pin sample
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

/** A small copy-to-clipboard button with brief "Copied ✓" feedback. */
export function CopyButton({
  text,
  label = "Copy",
}: {
  text: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard unavailable — the value is still visible to copy manually */
        }
      }}
      style={{
        flex: "none",
        padding: "0 10px",
        borderRadius: "var(--radius-sm)",
        border: "1px solid var(--line-2)",
        background: "var(--card)",
        color: "var(--ink-2)",
        fontSize: "var(--text-xs)",
        fontWeight: "var(--weight-semibold)",
        cursor: "pointer",
        fontFamily: "inherit",
      }}
    >
      {copied ? "Copied ✓" : label}
    </button>
  );
}

/** Read-only webhook binding: the registered endpoint URL(s) for this workflow
 *  (config lives in the registry, not the node). Empty → guidance to register. */
export function WebhookInfo({ hookUrls }: { hookUrls: string[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontSize: "var(--text-sm)", color: "var(--ink-2)" }}>
        This workflow is webhook-triggered. The inbound event becomes the
        trigger output.
      </div>
      {hookUrls.length > 0 ? (
        <div>
          <RowHead label="Invoke with (POST)" value={`${hookUrls.length}`} />
          {hookUrls.map((u) => (
            <div
              key={u}
              style={{
                display: "flex",
                alignItems: "stretch",
                gap: 6,
                marginBottom: 4,
              }}
            >
              <span
                className="mono"
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: "var(--text-xs)",
                  color: "var(--ink)",
                  background: "var(--card-2)",
                  border: "1px solid var(--line-2)",
                  borderRadius: "var(--radius-sm)",
                  padding: "6px 8px",
                  wordBreak: "break-all",
                }}
              >
                {u}
              </span>
              <CopyButton text={u} />
            </div>
          ))}
        </div>
      ) : (
        <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}>
          No endpoint registered yet — add one on the Integrations screen (it'll
          be bound to this workflow's key). Save the workflow first.
        </div>
      )}
    </div>
  );
}

/** Uppercase section label + a right-aligned mono value (design's field heads). */
export function RowHead({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: 6,
      }}
    >
      <span style={{ fontSize: "var(--text-sm)", color: "var(--ink-2)" }}>
        {label}
      </span>
      <span
        className="mono"
        style={{ fontSize: "var(--text-2xs)", color: "var(--ink-3)" }}
      >
        {value}
      </span>
    </div>
  );
}
