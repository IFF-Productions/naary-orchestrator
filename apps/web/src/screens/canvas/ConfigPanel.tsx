// Node inspector body: common header, test/pin UI, and per-type config section dispatch (extracted from CanvasPage).
import type { Node } from "@xyflow/react";
import type { NodeType } from "@naary/dsl";
import { ExpressionField } from "../../components/ExpressionField";
import type { ConnectionRow, TestNodeResult } from "../../lib/api";
import {
  ACCENT,
  NODE_DESCRIPTION,
  nodeDisplayLabel,
} from "../../lib/graph-model";
import type { NaaryData } from "./flow";
import {
  ERRORABLE_KINDS,
  inputStyle,
  JsonField,
  Labeled,
  RETRYABLE_KINDS,
} from "./fields";
import { CopyButton, leafPaths, PinSection, WebhookInfo } from "./PinSection";
import { renderAgentSections } from "./config-agents";
import { renderTriggerSections } from "./config-triggers";
import { renderHttpRequestSection } from "./config-http";
import { renderDataSections } from "./config-data";
import { renderTransformSections } from "./config-transform";
import { renderLogicSections } from "./config-logic";
import { renderControlSections } from "./config-control";

/** Shared closures/props handed to the extracted per-node-type config section renderers. */
export interface ConfigSectionCtx {
  node: Node<NaaryData>;
  kind: NodeType;
  config: Record<string, unknown>;
  str: (k: string) => string;
  num: (k: string) => number | undefined;
  obj: (k: string) => Record<string, unknown> | undefined;
  exprText: (
    k: string,
    opts?: { multiline?: boolean; placeholder?: string; minHeight?: string },
  ) => React.JSX.Element;
  onChange: (patch: Record<string, unknown>) => void;
  upstreamIds: string[];
  edges: { source: string; target: string }[];
  nodeKinds: Record<string, string>;
  connections: ConnectionRow[];
  pins: Record<string, unknown>;
}

/** Per-type config editor for the selected node — matches the design's inspector.
 *  Only the types with meaningful config (agent, mcpTool) expose fields; others
 *  are structural. Every field maps to a real DSL/runtime config key. */
export function ConfigPanel({
  node,
  upstreamIds,
  edges,
  nodeKinds,
  hookUrls,
  connections,
  pins,
  canPin,
  pinnedOutput,
  isPinned,
  onPin,
  onUnpin,
  onTest,
  onChange,
}: {
  node: Node<NaaryData>;
  upstreamIds: string[];
  edges: { source: string; target: string }[];
  nodeKinds: Record<string, string>;
  hookUrls: string[];
  connections: ConnectionRow[];
  pins: Record<string, unknown>;
  canPin: boolean;
  pinnedOutput: unknown;
  isPinned: boolean;
  onPin: (output: unknown) => Promise<void>;
  onUnpin: () => Promise<void>;
  onTest: (autofillUpstream?: boolean) => Promise<TestNodeResult>;
  onChange: (patch: Record<string, unknown>) => void;
}) {
  const kind = node.data.kind;
  const config = node.data.config ?? {};
  const str = (k: string) => (config[k] as string | undefined) ?? "";
  const num = (k: string) => config[k] as number | undefined;
  const obj = (k: string) =>
    (config[k] as Record<string, unknown> | undefined) ?? undefined;

  // A text field that understands {{ node.path }} — highlighting + autocomplete. Use for
  // free-text config that the runtime templates (URLs, bodies, prompts, email fields), NOT
  // for selects/numbers/secrets/JSON. Wraps the value/onChange({[k]:v}) boilerplate.
  const exprText = (
    k: string,
    opts?: { multiline?: boolean; placeholder?: string; minHeight?: string },
  ) => (
    <ExpressionField
      value={str(k)}
      onChange={(v) => onChange({ [k]: v })}
      nodeId={node.id}
      edges={edges}
      pins={pins}
      nodeKinds={nodeKinds}
      multiline={opts?.multiline}
      placeholder={opts?.placeholder}
      minHeight={opts?.minHeight}
    />
  );

  // Bundle the shared closures for the extracted per-type section renderers.
  const sectionCtx: ConfigSectionCtx = {
    node,
    kind,
    config,
    str,
    num,
    obj,
    exprText,
    onChange,
    upstreamIds,
    edges,
    nodeKinds,
    connections,
    pins,
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 14,
        maxWidth: 640,
      }}
    >
      {/* header */}
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <span
          style={{
            width: 28,
            height: 28,
            borderRadius: "var(--radius-md)",
            flex: "none",
            background: `color-mix(in srgb, ${ACCENT[kind]} 18%, transparent)`,
            color: ACCENT[kind],
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: "currentColor",
            }}
          />
        </span>
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: "var(--text-md)",
              fontWeight: "var(--weight-semibold)",
            }}
          >
            {nodeDisplayLabel(kind, config)}
          </div>
          <div
            className="mono"
            style={{ fontSize: "var(--text-2xs)", color: "var(--ink-3)" }}
          >
            {kind} · {node.id}
          </div>
        </div>
      </div>

      <div
        style={{
          fontSize: "var(--text-sm)",
          color: "var(--ink-2)",
          lineHeight: 1.4,
        }}
      >
        {NODE_DESCRIPTION[kind]}
      </div>

      {/* Insert-reference helper (design EXPRESSIONS.md §5): use {{ nodeId.path }} in any string
          field to splice an upstream output. Chips copy a starter token to paste at the cursor. */}
      {upstreamIds.length > 0 && (
        <div
          style={{
            padding: "8px 10px",
            borderRadius: "var(--radius-md)",
            border: "1px dashed var(--line-2)",
            background: "var(--card-2)",
          }}
        >
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginBottom: 6,
            }}
          >
            References — put <code>{"{{ node.path }}"}</code> in any field.
            Pinned/tested nodes suggest real paths; click to copy:
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {upstreamIds.flatMap((uid) => {
              const pin = pins[uid];
              const paths =
                pin && typeof pin === "object" ? leafPaths(pin) : [];
              if (paths.length === 0) {
                return [
                  <CopyButton
                    key={uid}
                    text={`{{ ${uid}. }}`}
                    label={`{{ ${uid} }}`}
                  />,
                ];
              }
              return paths.map((p) => (
                <CopyButton
                  key={`${uid}.${p}`}
                  text={`{{ ${uid}.${p} }}`}
                  label={`{{ ${uid}.${p} }}`}
                />
              ));
            })}
          </div>
        </div>
      )}

      <PinSection
        canPin={canPin}
        isPinned={isPinned}
        pinnedOutput={pinnedOutput}
        onPin={onPin}
        onUnpin={onUnpin}
        onTest={onTest}
      />

      {/* Per-node error policy (n8n's "On Error"), shown for nodes that can fail. */}
      {ERRORABLE_KINDS.has(kind) && (
        <Labeled label="On error">
          <select
            value={str("onError") || "stop"}
            onChange={(e) =>
              onChange({
                onError: e.target.value === "continue" ? "continue" : undefined,
              })
            }
            style={inputStyle}
          >
            <option value="stop">Stop the run (default)</option>
            <option value="continue">
              Continue — output an error and carry on
            </option>
          </select>
          {str("onError") === "continue" && (
            <div
              style={{
                fontSize: "var(--text-xs)",
                color: "var(--ink-3)",
                marginTop: 4,
              }}
            >
              On failure this node outputs <code>{node.id}.error</code> and the
              flow continues — branch on it (op <code>exists</code>) to handle
              it.
            </div>
          )}
        </Labeled>
      )}

      {/* Per-node retry (n8n's "Retry On Fail"), backed by Temporal — unbounded + exponential. */}
      {RETRYABLE_KINDS.has(kind) &&
        (() => {
          const retry = config.retry as
            | {
                maxAttempts?: number;
                initialIntervalSeconds?: number;
                backoffCoefficient?: number;
              }
            | undefined;
          const on = Boolean(retry);
          const setRetry = (patch: Record<string, unknown> | undefined) =>
            onChange({ retry: patch });
          return (
            <div
              style={{
                border: "1px solid var(--line)",
                borderRadius: "var(--radius-md)",
                padding: 10,
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <label
                style={{
                  display: "flex",
                  gap: 6,
                  alignItems: "center",
                  fontSize: "var(--text-sm)",
                  color: "var(--ink-2)",
                }}
              >
                <input
                  type="checkbox"
                  checked={on}
                  onChange={(e) =>
                    setRetry(
                      e.target.checked
                        ? {
                            maxAttempts: 3,
                            initialIntervalSeconds: 1,
                            backoffCoefficient: 2,
                          }
                        : undefined,
                    )
                  }
                />
                Retry on failure (Temporal — exponential, no 5-try cap)
              </label>
              {on && (
                <div style={{ display: "flex", gap: 8 }}>
                  <Labeled label="Max attempts">
                    <input
                      type="number"
                      min={1}
                      value={retry?.maxAttempts ?? ""}
                      onChange={(e) =>
                        setRetry({
                          ...retry,
                          maxAttempts: e.target.value
                            ? Number(e.target.value)
                            : undefined,
                        })
                      }
                      style={inputStyle}
                      placeholder="3"
                    />
                  </Labeled>
                  <Labeled label="Initial wait (s)">
                    <input
                      type="number"
                      min={0}
                      value={retry?.initialIntervalSeconds ?? ""}
                      onChange={(e) =>
                        setRetry({
                          ...retry,
                          initialIntervalSeconds: e.target.value
                            ? Number(e.target.value)
                            : undefined,
                        })
                      }
                      style={inputStyle}
                      placeholder="1"
                    />
                  </Labeled>
                  <Labeled label="Backoff ×">
                    <input
                      type="number"
                      min={1}
                      step={0.5}
                      value={retry?.backoffCoefficient ?? ""}
                      onChange={(e) =>
                        setRetry({
                          ...retry,
                          backoffCoefficient: e.target.value
                            ? Number(e.target.value)
                            : undefined,
                        })
                      }
                      style={inputStyle}
                      placeholder="2"
                    />
                  </Labeled>
                </div>
              )}
            </div>
          );
        })()}

      {renderAgentSections(sectionCtx)}
      {renderTriggerSections(sectionCtx)}
      {renderHttpRequestSection(sectionCtx)}
      {renderDataSections(sectionCtx)}
      {renderTransformSections(sectionCtx)}
      {renderLogicSections(sectionCtx)}
      {renderControlSections(sectionCtx)}

      {kind === "start" && (
        <JsonField
          label="Sample input (JSON)"
          value={obj("sampleInput")}
          placeholder={'{\n  "message": "I was charged twice"\n}'}
          onChange={(v) => onChange({ sampleInput: v })}
        />
      )}

      {kind === "webhookTrigger" && <WebhookInfo hookUrls={hookUrls} />}

      {kind === "errorTrigger" && (
        <div
          style={{
            fontSize: "var(--text-sm)",
            color: "var(--ink-3)",
            lineHeight: 1.6,
          }}
        >
          <div
            style={{
              fontWeight: "var(--weight-semibold)",
              color: "var(--ink-2)",
              marginBottom: 4,
            }}
          >
            Error handler entry
          </div>
          Start a graph with this node, then set it as another workflow's{" "}
          <strong>error workflow</strong>. When that workflow fails, this graph
          runs with the failure context as input —{" "}
          <code>{node.id}.failedWorkflowId</code>, <code>.status</code>,{" "}
          <code>.error</code>.
        </div>
      )}

      {kind === "end" && (
        <div style={{ fontSize: "var(--text-sm)", color: "var(--ink-3)" }}>
          The terminal node — no configuration.
        </div>
      )}
    </div>
  );
}
