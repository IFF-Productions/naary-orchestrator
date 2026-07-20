/**
 * OUTPUT / LOGS tabs at the bottom of the inspector dock (split out of
 * InspectorDock for the large-files check). Output = the selected node's REAL
 * last test result (or its pinned sample) as draggable green-card rows, the
 * dashed "No output yet" empty state, or the error card. Logs = the real
 * test-run facts only — never fabricated log lines.
 */
import { useState } from "react";
import { Icon } from "../../components";
import type { DockRun } from "./InspectorDock";
import { FieldRow, flattenOutput } from "./output-fields";

function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`;
}

export function DockOutputTabs({
  nodeId,
  run,
  isPinned,
  pinnedOutput,
}: {
  nodeId: string;
  run?: DockRun;
  isPinned?: boolean;
  pinnedOutput?: unknown;
}) {
  const [tab, setTab] = useState<"out" | "logs">("out");
  const running = run?.status === "running";
  const freshOutput = run?.status === "done" && run.output !== undefined;
  const showPinnedCard = !freshOutput && isPinned;
  const outputRows = freshOutput
    ? flattenOutput(run?.output)
    : showPinnedCard
      ? flattenOutput(pinnedOutput)
      : [];

  return (
    <div style={{ padding: "12px 20px 24px" }}>
      <div
        style={{
          display: "flex",
          gap: 4,
          background: "var(--bg)",
          border: "1px solid var(--line-mid)",
          borderRadius: 9,
          padding: 3,
          marginBottom: 12,
          width: "fit-content",
        }}
      >
        {(["out", "logs"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            style={{
              fontSize: "var(--text-xs)",
              padding: "5px 13px",
              borderRadius: 6,
              cursor: "pointer",
              fontWeight: "var(--weight-semibold)",
              color: tab === t ? "var(--ink)" : "var(--ink-faint)",
              background: tab === t ? "var(--brand-soft)" : "transparent",
              border: "none",
            }}
          >
            {t === "out" ? "Output" : "Logs"}
          </button>
        ))}
      </div>

      {tab === "out" &&
        (outputRows.length > 0 ? (
          <div
            style={{
              border: `1px solid ${
                showPinnedCard
                  ? "color-mix(in srgb, var(--state-paused) 40%, transparent)"
                  : "color-mix(in srgb, var(--state-done) 40%, transparent)"
              }`,
              background: showPinnedCard
                ? "color-mix(in srgb, var(--state-paused) 4%, var(--panel))"
                : "color-mix(in srgb, var(--state-done) 4%, var(--panel))",
              borderRadius: 11,
              overflow: "hidden",
              animation: "naaryFadeUp .3s ease",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "9px 13px",
                borderBottom: `1px solid ${
                  showPinnedCard
                    ? "color-mix(in srgb, var(--state-paused) 30%, transparent)"
                    : "color-mix(in srgb, var(--state-done) 30%, transparent)"
                }`,
                background: showPinnedCard
                  ? "color-mix(in srgb, var(--state-paused) 8%, var(--panel))"
                  : "color-mix(in srgb, var(--state-done) 8%, var(--panel))",
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: "50%",
                  background: showPinnedCard
                    ? "var(--state-paused)"
                    : "var(--state-done)",
                  color: "#04120b",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  animation: "naaryPopIn .3s ease",
                  flex: "none",
                }}
              >
                <Icon name="check" size={9} />
              </span>
              <span
                style={{
                  fontSize: "var(--text-xs)",
                  color: showPinnedCard
                    ? "var(--state-paused)"
                    : "var(--state-done)",
                  fontWeight: "var(--weight-semibold)",
                }}
              >
                {showPinnedCard ? "Pinned sample" : "Output ready"}
              </span>
              {run?.stale && !showPinnedCard && (
                <span
                  className="mono"
                  style={{
                    fontSize: 9.5,
                    color: "var(--state-paused)",
                    border:
                      "1px solid color-mix(in srgb, var(--state-paused) 45%, transparent)",
                    borderRadius: 20,
                    padding: "1px 7px",
                  }}
                >
                  stale
                </span>
              )}
              {(run?.ms !== undefined || run?.costUsd !== undefined) &&
                !showPinnedCard && (
                  <span
                    className="mono"
                    style={{
                      marginLeft: "auto",
                      fontSize: "var(--text-2xs)",
                      color: "var(--ink-3)",
                    }}
                  >
                    {/* Server-measured duration + real metered cost (Slice 2). */}
                    {[
                      run.ms !== undefined ? fmtMs(run.ms) : null,
                      run.costUsd !== undefined && run.costUsd > 0
                        ? `$${run.costUsd.toFixed(4)}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                )}
            </div>
            <div style={{ padding: 6 }}>
              {outputRows.map((f) => (
                <FieldRow
                  key={f.path}
                  token={`{{ ${nodeId}.${f.path} }}`}
                  path={f.path}
                  valuePreview={f.preview}
                  variant="output"
                />
              ))}
            </div>
            <div
              style={{
                padding: "8px 13px",
                borderTop: `1px solid ${
                  showPinnedCard
                    ? "color-mix(in srgb, var(--state-paused) 30%, transparent)"
                    : "color-mix(in srgb, var(--state-done) 30%, transparent)"
                }`,
                fontSize: 10.5,
                color: "var(--ink-3)",
              }}
            >
              Drag any output field into a downstream node's parameters.
            </div>
          </div>
        ) : run?.status === "error" ? (
          <div
            style={{
              border:
                "1px solid color-mix(in srgb, var(--state-error) 45%, transparent)",
              background:
                "color-mix(in srgb, var(--state-error) 6%, var(--panel))",
              borderRadius: 11,
              padding: "14px 16px",
              fontSize: "var(--text-sm)",
              color: "var(--state-error)",
              lineHeight: 1.5,
              overflowWrap: "anywhere",
            }}
          >
            ✗ {run.message ?? "Test failed."}
          </div>
        ) : (
          <div
            style={{
              border: "1px dashed var(--line-2)",
              borderRadius: 11,
              padding: "26px 18px",
              textAlign: "center",
            }}
          >
            <div
              style={{
                width: 38,
                height: 38,
                borderRadius: 10,
                border: "1px solid var(--line-2)",
                background: "var(--card)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                margin: "0 auto 11px",
              }}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="var(--ink-3)"
                aria-hidden
              >
                <path d="M7 5v14l12-7z" />
              </svg>
            </div>
            <div style={{ fontSize: "var(--text-sm)", color: "var(--ink-2)" }}>
              No output yet
            </div>
            <div
              style={{
                fontSize: "var(--text-xs)",
                color: "var(--ink-3)",
                marginTop: 3,
              }}
            >
              Press{" "}
              <span
                style={{
                  color: "var(--brand)",
                  fontWeight: "var(--weight-semibold)",
                }}
              >
                Test step
              </span>{" "}
              to run this node with the pinned data.
            </div>
          </div>
        ))}

      {tab === "logs" && (
        <div
          className="mono"
          style={{
            border: "1px solid var(--line-mid)",
            background: "var(--bg)",
            borderRadius: 11,
            padding: "12px 14px",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            lineHeight: 1.85,
            minHeight: 120,
          }}
        >
          {/* Real test-run facts only — never fabricated log lines. */}
          {running && <div style={{ color: "var(--brand-2)" }}>▸ running…</div>}
          {run?.status === "done" && (
            <div style={{ color: "var(--state-done)" }}>
              ✓ completed
              {run.ms !== undefined ? ` · ${fmtMs(run.ms)}` : ""}
              {run.costUsd !== undefined && run.costUsd > 0
                ? ` · $${run.costUsd.toFixed(4)}`
                : ""}
            </div>
          )}
          {run?.status === "done" && run.stale && (
            <div style={{ color: "var(--state-paused)" }}>
              ⚠ inputs changed upstream since this run — output is stale
            </div>
          )}
          {run?.status === "error" && (
            <div
              style={{ color: "var(--state-error)", overflowWrap: "anywhere" }}
            >
              ✗ {run.message ?? "Test failed."}
              {run.ms !== undefined ? ` · ${fmtMs(run.ms)}` : ""}
            </div>
          )}
          {!run && (
            <div style={{ color: "var(--ink-3)" }}>
              No logs yet — run this step to see execution output.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
