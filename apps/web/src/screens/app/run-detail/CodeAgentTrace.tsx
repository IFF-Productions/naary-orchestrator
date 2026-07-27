/**
 * codeAgent execution trace — the step-by-step agentic log (what the agent read/grepped, which
 * tools it called, its reasoning) captured from the CLI's `stream-json` stream and surfaced so a
 * codeAgent run is debuggable. Rendered as a COLLAPSIBLE log inside the node's detail card, one
 * compact row per step — not a raw JSON dump.
 *
 * The trace is captured after the CLI process exits (not live-streamed to the browser), so this is
 * a capture-then-show view of the completed run. When the trace was large it is offloaded to object
 * storage as a claim-check and normally resolved by the API before it reaches us; if we still see an
 * unresolved reference (e.g. a dev in-memory store, or the object expired) we show an honest marker
 * rather than a raw `{__claimCheck}` blob.
 */
import { useState } from "react";

/** One trace step — mirrors @naary/worker's `TraceStep` (kept local so the web stays decoupled). */
export interface TraceStep {
  kind: "assistant" | "tool" | "result" | "truncated";
  text?: string;
  tool?: string;
  toolInput?: string;
  isError?: boolean;
}

type ClaimCheckRef = { __claimCheck: string; bytes: number };

function isClaimCheckRef(v: unknown): v is ClaimCheckRef {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as ClaimCheckRef).__claimCheck === "string"
  );
}

/** Pull the codeAgent trace out of a node output (`{ status, output: { …, trace }, costUsd }`). */
export function extractCodeAgentTrace(
  output: unknown,
): TraceStep[] | ClaimCheckRef | undefined {
  if (!output || typeof output !== "object") return undefined;
  const inner = (output as { output?: unknown }).output;
  if (!inner || typeof inner !== "object") return undefined;
  const trace = (inner as { trace?: unknown }).trace;
  if (Array.isArray(trace)) return trace as TraceStep[];
  if (isClaimCheckRef(trace)) return trace;
  return undefined;
}

function kib(bytes: number): string {
  return bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`;
}

const KIND_LABEL: Record<TraceStep["kind"], string> = {
  assistant: "THINK",
  tool: "TOOL",
  result: "RESULT",
  truncated: "TRUNCATED",
};

const KIND_COLOR: Record<TraceStep["kind"], string> = {
  assistant: "var(--ink-3)",
  tool: "var(--ink-soft)",
  result: "var(--state-done, var(--ink-soft))",
  truncated: "var(--state-paused, var(--ink-3))",
};

function StepRow({ step }: { step: TraceStep }) {
  const color = step.isError ? "var(--state-error)" : KIND_COLOR[step.kind];
  return (
    <li
      style={{
        display: "flex",
        gap: 10,
        padding: "8px 0",
        borderTop: "1px solid var(--line)",
        alignItems: "flex-start",
      }}
    >
      <span
        className="mono"
        style={{
          flex: "none",
          fontSize: "var(--text-2xs)",
          fontWeight: "var(--weight-bold)",
          letterSpacing: ".06em",
          color,
          minWidth: 64,
          paddingTop: 1,
        }}
      >
        {KIND_LABEL[step.kind]}
      </span>
      <span style={{ minWidth: 0, flex: 1 }}>
        {step.kind === "tool" ? (
          <span>
            <span
              className="mono"
              style={{
                fontSize: "var(--text-xs)",
                fontWeight: "var(--weight-semibold)",
                color: "var(--ink)",
              }}
            >
              {step.tool}
            </span>
            {step.toolInput && (
              <span
                className="mono"
                style={{
                  fontSize: "var(--text-2xs)",
                  color: "var(--ink-3)",
                  marginLeft: 8,
                  wordBreak: "break-word",
                }}
              >
                {step.toolInput}
              </span>
            )}
          </span>
        ) : (
          <span
            style={{
              fontSize: "var(--text-xs)",
              color: step.isError ? "var(--state-error)" : "var(--ink-soft)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              lineHeight: 1.5,
            }}
          >
            {step.text}
          </span>
        )}
      </span>
    </li>
  );
}

export function CodeAgentTrace({
  trace,
}: {
  trace: TraceStep[] | ClaimCheckRef;
}) {
  const [open, setOpen] = useState(false);

  // Offloaded and not resolved for us — be honest instead of dumping the raw reference.
  if (isClaimCheckRef(trace)) {
    return (
      <div style={{ marginBottom: 12 }}>
        <div
          className="mono"
          style={{ fontSize: "var(--text-2xs)", color: "var(--ink-3)" }}
        >
          Execution trace offloaded to storage ({kib(trace.bytes)}) — too large
          to display inline.
        </div>
      </div>
    );
  }

  if (trace.length === 0) return null;
  const toolCount = trace.filter((s) => s.kind === "tool").length;

  return (
    <div style={{ marginBottom: 12 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="mono"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          background: "none",
          border: "1px solid var(--line-mid)",
          borderRadius: 8,
          padding: "8px 12px",
          cursor: "pointer",
          color: "var(--ink-soft)",
          fontSize: "var(--text-xs)",
          textAlign: "left",
        }}
        aria-expanded={open}
      >
        <span style={{ transform: open ? "rotate(90deg)" : "none" }}>▸</span>
        <span style={{ fontWeight: "var(--weight-semibold)" }}>
          Execution trace
        </span>
        <span style={{ color: "var(--ink-3)" }}>
          {trace.length} steps · {toolCount} tool calls
        </span>
      </button>
      {open && (
        <ol
          style={{
            listStyle: "none",
            margin: "8px 0 0",
            padding: "0 4px",
            maxHeight: 360,
            overflow: "auto",
            border: "1px solid var(--line)",
            borderRadius: 8,
            background: "var(--bg)",
          }}
        >
          {trace.map((step, i) => (
            // Trace order is stable (append-only capture); index is a valid key here.
            // biome-ignore lint/suspicious/noArrayIndexKey: stable append-only capture order
            <StepRow key={i} step={step} />
          ))}
        </ol>
      )}
    </div>
  );
}
