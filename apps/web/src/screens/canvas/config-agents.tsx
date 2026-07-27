// Agent / code-agent / MCP tool / integration config sections of the node inspector (extracted verbatim from CanvasPage).
import type { ConfigSectionCtx } from "./ConfigPanel";
import type { ConnectionRow } from "../../lib/api";
import { getIntegrationProvider } from "@naary/dsl";
import { ExpressionField } from "../../components/ExpressionField";
import type { JsonSchemaObject } from "../../lib/schema-fields";
import { SchemaEditor } from "./SchemaFieldEditor";
import { ACCENT } from "../../lib/graph-model";
import { summarize } from "./flow";
import {
  type BindingRow,
  BindingsEditor,
  CONNECTION_TYPES,
  ConnectionSelect,
  inputStyle,
  JsonField,
  Labeled,
  MODELS,
  PROVIDER_LABELS,
  PROVIDERS,
} from "./fields";
import { RowHead } from "./PinSection";

/**
 * How this provider authenticates, shown under the Connection picker (#815).
 *
 * Filed from a real question — *"I'm confused, how can I add PagerDuty integration configuration
 * in the app?"* — where the answer already existed in the catalog as `provider.auth` and was
 * rendered in exactly one place the user would never be standing: the Node Catalog's detail
 * drawer. Nothing here is new knowledge; it is the same string, moved to where it's needed.
 *
 * Emphasised when there is NO connection selected yet (that's the moment of the question) and
 * quiet once one is, so it stops being noise on every subsequent visit to the node.
 */
function ProviderAuthHint({
  provider,
  auth,
  baseUrl,
  fromConnection,
  needsConnection,
}: {
  provider: string;
  auth: string;
  baseUrl?: string;
  /** This provider's API host comes from the CONNECTION's Server URL, not the catalog. */
  fromConnection: boolean;
  needsConnection: boolean;
}) {
  return (
    <div
      style={{
        marginTop: 6,
        padding: "7px 9px",
        border: `1px solid ${needsConnection ? "var(--line-2)" : "var(--line)"}`,
        borderRadius: "var(--radius-sm)",
        background: needsConnection ? "var(--card)" : "transparent",
        fontSize: "var(--text-xs)",
        color: needsConnection ? "var(--ink-2)" : "var(--ink-3)",
        lineHeight: 1.5,
      }}
    >
      {needsConnection && (
        <div style={{ marginBottom: 4 }}>
          <strong>Connecting {provider}:</strong> Integrations → Apps &amp;
          agents → Connect, Type <strong>Custom</strong>, Server URL{" "}
          {fromConnection ? (
            // These providers are per-tenant hosts (a Jira site, a Shopify store): the request's
            // base URL IS this field, so telling the user it's cosmetic would break them.
            <em>your own {provider} host</em>
          ) : baseUrl ? (
            <code className="mono">{baseUrl}</code>
          ) : (
            <em>any https URL (a label only)</em>
          )}
          .{" "}
          <a href="/app/integrations" target="_blank" rel="noreferrer">
            Open Integrations
          </a>
        </div>
      )}
      {auth}
      {needsConnection && (
        // The trap that produces a 401 with no form error: the code adds the scheme prefix
        // itself, so a pasted "Token token=…" is wrong in a way nothing tells you.
        <div style={{ marginTop: 4, color: "var(--ink-3)" }}>
          Paste the token raw — the prefix is added for you.
        </div>
      )}
    </div>
  );
}

/** One in-loop MCP tool the agent may call (#449). All fields optional in the editor so a
 *  half-filled row doesn't break saving; the activity treats a missing connection/tool as a no-op. */
interface AgentToolRow {
  connectionId?: string;
  tool?: string;
  name?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  costUsd?: number;
}

/** Add/remove editor for the agent node's `tools[]` (#449 follow-up). Mirrors the mcpTool node's
 *  connection + tool fields; each tool the model can call mid-reasoning is one card. */
function AgentToolsEditor({
  tools,
  connections,
  onChange,
}: {
  tools: AgentToolRow[];
  connections: ConnectionRow[];
  onChange: (tools: AgentToolRow[] | undefined) => void;
}) {
  const update = (i: number, patch: Partial<AgentToolRow>) =>
    onChange(tools.map((t, idx) => (idx === i ? { ...t, ...patch } : t)));
  const remove = (i: number) => {
    const next = tools.filter((_, idx) => idx !== i);
    onChange(next.length ? next : undefined);
  };
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {tools.map((t, i) => (
        <div
          // Index key: rows are positional (no stable id) and only reorder on remove, which
          // re-renders the whole list from the new array — acceptable for a small config list.
          key={i}
          style={{
            border: "1px solid var(--line)",
            borderRadius: "var(--radius-md)",
            padding: 10,
            display: "grid",
            gap: 8,
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}>
              Tool {i + 1}
            </span>
            <button
              type="button"
              onClick={() => remove(i)}
              style={{
                fontSize: "var(--text-2xs)",
                cursor: "pointer",
                border: "1px solid var(--line-2)",
                color: "var(--ink-2)",
                background: "var(--card)",
                padding: "2px 8px",
                borderRadius: "var(--radius-sm)",
              }}
            >
              Remove
            </button>
          </div>
          <Labeled label="Connection">
            <ConnectionSelect
              connections={connections}
              types={CONNECTION_TYPES.mcpTool ?? []}
              value={t.connectionId ?? ""}
              onChange={(id) => update(i, { connectionId: id })}
            />
          </Labeled>
          <Labeled label="Tool name">
            <input
              value={t.tool ?? ""}
              onChange={(e) => update(i, { tool: e.target.value })}
              style={inputStyle}
              placeholder="search_issues"
            />
          </Labeled>
          <Labeled label="Exposed name (optional)">
            <input
              value={t.name ?? ""}
              onChange={(e) => update(i, { name: e.target.value || undefined })}
              style={inputStyle}
              placeholder="defaults to the tool name"
            />
          </Labeled>
          <Labeled label="Description">
            <input
              value={t.description ?? ""}
              onChange={(e) =>
                update(i, { description: e.target.value || undefined })
              }
              style={inputStyle}
              placeholder="what the model uses to decide when to call it"
            />
          </Labeled>
          <JsonField
            label="Input schema (JSON)"
            value={t.inputSchema}
            placeholder={'{\n  "type": "object",\n  "properties": {}\n}'}
            onChange={(v) =>
              update(i, {
                inputSchema: v as Record<string, unknown> | undefined,
              })
            }
          />
          <Labeled label="Cost (USD per call)">
            <input
              type="number"
              min={0}
              step={0.001}
              value={t.costUsd ?? ""}
              onChange={(e) =>
                update(i, {
                  costUsd: e.target.value ? Number(e.target.value) : undefined,
                })
              }
              style={inputStyle}
              placeholder="0.00"
            />
          </Labeled>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...tools, {}])}
        style={{
          fontSize: "var(--text-xs)",
          cursor: "pointer",
          border: "1px dashed var(--line-2)",
          color: "var(--ink-2)",
          background: "var(--card)",
          padding: "6px 10px",
          borderRadius: "var(--radius-sm)",
        }}
      >
        + Add tool
      </button>
    </div>
  );
}

export function renderAgentSections(c: ConfigSectionCtx) {
  const {
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
  } = c;
  // "claude-code" runs the agent's instruction through the Claude Code CLI (read-mode plan run)
  // instead of a raw LLM call, so the LLM-only knobs below (temperature, structured output, max
  // tokens, in-loop MCP tools, prompt caching) are no-ops for it and are hidden.
  const isClaudeCode = (str("provider") || "anthropic") === "claude-code";
  return (
    <>
      {kind === "agent" && (
        <>
          <Labeled label="Provider">
            <select
              value={str("provider") || "anthropic"}
              onChange={(e) =>
                // Switching provider resets the model to that provider's default —
                // otherwise a Claude model could linger on an OpenAI node (a run-time mismatch).
                onChange({
                  provider: e.target.value,
                  model: MODELS[e.target.value]?.[0],
                })
              }
              style={inputStyle}
            >
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {PROVIDER_LABELS[p] ?? p}
                </option>
              ))}
            </select>
          </Labeled>

          <Labeled label="Model">
            <select
              value={str("model") || MODELS.anthropic[0]}
              onChange={(e) => onChange({ model: e.target.value })}
              style={inputStyle}
            >
              {(MODELS[str("provider") || "anthropic"] ?? []).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <div
              style={{
                display: "flex",
                gap: 6,
                marginTop: 8,
                flexWrap: "wrap",
              }}
            >
              {(MODELS[str("provider") || "anthropic"] ?? []).map((m) => {
                const active = (str("model") || MODELS.anthropic[0]) === m;
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => onChange({ model: m })}
                    className="mono"
                    style={{
                      fontSize: "var(--text-2xs)",
                      cursor: "pointer",
                      border: `1px solid ${active ? ACCENT.agent : "var(--line-2)"}`,
                      color: active ? ACCENT.agent : "var(--ink-2)",
                      background: "var(--card)",
                      padding: "3px 9px",
                      borderRadius: "var(--radius-sm)",
                    }}
                  >
                    {m.replace("claude-", "")}
                  </button>
                );
              })}
            </div>
          </Labeled>

          {isClaudeCode && (
            <div
              style={{
                fontSize: "var(--text-xs)",
                color: "var(--ink-3)",
                lineHeight: "var(--leading-snug)",
                padding: "8px 10px",
                border: "1px solid var(--line-2)",
                borderRadius: 8,
                background: "var(--card)",
              }}
            >
              Runs your instruction through the Claude Code CLI (read-only plan
              mode, no repo). The system prompt below is the task; the upstream
              input is appended. Without a structured-output schema the result
              is plain text at <span className="mono">output.text</span>; with
              one, the CLI is constrained to your schema and the fields land on{" "}
              <span className="mono">output.&lt;field&gt;</span> — same as any
              other provider.
            </div>
          )}

          {!isClaudeCode && (
            <div>
              <RowHead
                label="Temperature"
                value={
                  num("temperature") === undefined
                    ? "default"
                    : (num("temperature") as number).toFixed(2)
                }
              />
              <input
                type="range"
                min={0}
                max={2}
                step={0.05}
                value={num("temperature") ?? 0}
                onChange={(e) =>
                  onChange({ temperature: Number(e.target.value) })
                }
                style={{ width: "100%", accentColor: ACCENT.agent }}
              />
            </div>
          )}

          <div>
            <RowHead
              label={isClaudeCode ? "Instruction" : "System prompt"}
              value={`~${Math.ceil(str("systemPrompt").length / 4)} tok`}
            />
            {exprText("systemPrompt", {
              multiline: true,
              minHeight: "7em",
              placeholder: "You are a support triage agent…",
            })}
          </div>

          {/* Structured output works on EVERY provider now, Claude Code included: the CLI enforces
              the schema with `--json-schema` (verified against the pinned version) exactly as the
              model APIs do. It used to be hidden here because the CLI could only return text. */}
          <div>
            <RowHead label="Structured output" value="fields" />
            <SchemaEditor
              schema={obj("outputSchema") as JsonSchemaObject | undefined}
              onChange={(v) => onChange({ outputSchema: v })}
            />
          </div>

          {!isClaudeCode && (
            <>
              <Labeled label="Max output tokens">
                <input
                  type="number"
                  min={1}
                  value={num("maxOutputTokens") ?? ""}
                  onChange={(e) =>
                    onChange({
                      maxOutputTokens: e.target.value
                        ? Number(e.target.value)
                        : undefined,
                    })
                  }
                  style={inputStyle}
                  placeholder="1024 (default)"
                />
              </Labeled>

              <div>
                <RowHead
                  label="Tools (MCP)"
                  value={`${((config.tools as unknown[] | undefined)?.length ?? 0) || "none"}`}
                />
                <div
                  style={{
                    fontSize: "var(--text-xs)",
                    color: "var(--ink-3)",
                    marginBottom: 6,
                    lineHeight: "var(--leading-snug)",
                  }}
                >
                  MCP tools the agent can call mid-reasoning (a bounded tool
                  loop). With tools and no structured-output fields above, the
                  agent returns free text.
                </div>
                <AgentToolsEditor
                  tools={(config.tools as AgentToolRow[] | undefined) ?? []}
                  connections={connections}
                  onChange={(tools) => onChange({ tools })}
                />
              </div>

              {Boolean((config.tools as unknown[] | undefined)?.length) && (
                <Labeled label="Max tool steps">
                  <input
                    type="number"
                    min={1}
                    value={num("maxToolSteps") ?? ""}
                    onChange={(e) =>
                      onChange({
                        maxToolSteps: e.target.value
                          ? Number(e.target.value)
                          : undefined,
                      })
                    }
                    style={inputStyle}
                    placeholder="8 (default)"
                  />
                </Labeled>
              )}

              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: "var(--text-sm)",
                  color: "var(--ink-2)",
                }}
              >
                <input
                  type="checkbox"
                  checked={Boolean(config.cacheSystemPrompt)}
                  onChange={(e) =>
                    onChange({
                      cacheSystemPrompt: e.target.checked || undefined,
                    })
                  }
                />
                Cache the system prompt (Anthropic)
              </label>
              <div
                style={{
                  fontSize: "var(--text-xs)",
                  color: "var(--ink-3)",
                  marginTop: -6,
                }}
              >
                Only worth it for a HIGH-VOLUME agent reusing a large, stable
                system prompt within ~5&nbsp;minutes. For one-shot flows it can
                slightly increase cost (a cache-write premium with no reuse), so
                leave it off unless this agent runs often with the same prompt.
              </div>
            </>
          )}
        </>
      )}

      {kind === "codeAgent" && (
        <>
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              lineHeight: "var(--leading-snug)",
              marginBottom: 4,
            }}
          >
            Runs an agentic coding CLI on your task. <strong>Read</strong> mode
            reads code and returns a plan (in-worker, no repo).{" "}
            <strong>Write</strong> mode clones a repo, edits it in an isolated
            sandbox, and can open a pull request — enabled per deployment.
          </div>

          <Labeled label="Tool">
            <select
              value={str("tool") || "claude"}
              onChange={(e) => onChange({ tool: e.target.value })}
              style={inputStyle}
            >
              <option value="claude">Claude Code</option>
              <option value="cursor" disabled>
                Cursor (coming soon)
              </option>
              <option value="copilot" disabled>
                Copilot (coming soon)
              </option>
            </select>
          </Labeled>

          <Labeled label="Mode">
            <select
              value={str("mode") || "read"}
              onChange={(e) =>
                onChange({
                  mode: e.target.value === "write" ? "write" : "read",
                })
              }
              style={inputStyle}
            >
              <option value="read">Read — plan only (no repo)</option>
              <option value="write">Write — edit a repo in a sandbox</option>
            </select>
          </Labeled>

          <div>
            <RowHead
              label="Prompt"
              value={`~${Math.ceil(str("prompt").length / 4)} tok`}
            />
            {exprText("prompt", {
              multiline: true,
              minHeight: "7em",
              placeholder:
                "Review the auth module and summarize any security issues…",
            })}
          </div>

          <div>
            <RowHead label="System prompt" value="optional" />
            {exprText("systemPrompt", {
              multiline: true,
              minHeight: "4em",
              placeholder: "House rules for the agent…",
            })}
          </div>

          <Labeled label="Model">
            <input
              value={str("model")}
              onChange={(e) => onChange({ model: e.target.value || undefined })}
              style={inputStyle}
              placeholder="default (tenant's Anthropic default)"
            />
          </Labeled>

          {/* Structured output — only the `claude` tool can enforce a schema (`--json-schema`); the
              activity REFUSES one on cursor/copilot rather than returning unvalidated prose in a
              field the graph reads as typed data. Shown for every tool so the choice is visible,
              with the constraint stated rather than the control silently missing. */}
          <div>
            <RowHead label="Structured output" value="fields" />
            <SchemaEditor
              schema={obj("outputSchema") as JsonSchemaObject | undefined}
              onChange={(v) => onChange({ outputSchema: v })}
            />
            {obj("outputSchema") !== undefined &&
              (str("tool") || "claude") !== "claude" && (
                <div
                  style={{
                    fontSize: "var(--text-xs)",
                    color: "var(--state-error)",
                    lineHeight: "var(--leading-snug)",
                    marginTop: 6,
                  }}
                >
                  The {str("tool")} CLI can't enforce a schema — this run will
                  fail. Switch the tool to Claude, or clear the schema.
                </div>
              )}
          </div>

          <div style={{ display: "flex", gap: 10 }}>
            <Labeled label="Max turns">
              <input
                type="number"
                min={1}
                value={num("maxTurns") ?? ""}
                onChange={(e) =>
                  onChange({
                    maxTurns: e.target.value
                      ? Number(e.target.value)
                      : undefined,
                  })
                }
                style={inputStyle}
                placeholder="default"
              />
            </Labeled>
            <Labeled label="Max budget (USD)">
              <input
                type="number"
                min={0.5}
                step={0.5}
                value={num("maxBudgetUsd") ?? ""}
                onChange={(e) => {
                  // Schema requires > 0 — use valueAsNumber (a partial/empty number input is
                  // NaN) and coerce anything non-positive/non-finite to undefined so the node
                  // stays saveable (rather than persisting an invalid 0).
                  const v = e.target.valueAsNumber;
                  onChange({
                    maxBudgetUsd: Number.isFinite(v) && v > 0 ? v : undefined,
                  });
                }}
                style={inputStyle}
                placeholder="hard stop"
              />
            </Labeled>
          </div>

          {str("mode") === "write" && (
            <div
              style={{
                border: "1px solid var(--line)",
                borderRadius: "var(--radius-md)",
                padding: 10,
                display: "grid",
                gap: 10,
                marginTop: 2,
              }}
            >
              <div
                style={{
                  fontSize: "var(--text-xs)",
                  color: "var(--ink-3)",
                  lineHeight: "var(--leading-snug)",
                }}
              >
                The repo is cloned and edited in an egress-isolated sandbox. The
                connection's GitHub App token authorizes the clone (and the PR)
                — it never enters the sandbox. Needs{" "}
                <code>CODE_AGENT_WRITE_ENABLED</code> on the worker.
              </div>

              <Labeled label="Repository">
                <input
                  value={str("repo")}
                  onChange={(e) =>
                    onChange({ repo: e.target.value || undefined })
                  }
                  style={inputStyle}
                  placeholder="owner/name"
                />
              </Labeled>

              <Labeled label="Base branch">
                <input
                  value={str("branch")}
                  onChange={(e) =>
                    onChange({ branch: e.target.value || undefined })
                  }
                  style={inputStyle}
                  placeholder="default branch"
                />
              </Labeled>

              <Labeled label="GitHub App connection">
                <ConnectionSelect
                  connections={connections}
                  types={CONNECTION_TYPES[kind] ?? []}
                  value={str("connectionId")}
                  onChange={(id) => onChange({ connectionId: id })}
                />
              </Labeled>

              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: "var(--text-sm)",
                  color: "var(--ink)",
                }}
              >
                <input
                  type="checkbox"
                  checked={Boolean(config.openPr)}
                  onChange={(e) =>
                    onChange({ openPr: e.target.checked || undefined })
                  }
                />
                Open a pull request with the edits
              </label>

              {Boolean(config.openPr) && (
                <>
                  <Labeled label="PR title">
                    {exprText("prTitle", {
                      placeholder: "Naary code agent changes",
                    })}
                  </Labeled>
                  <Labeled label="PR body">
                    {exprText("prBody", {
                      multiline: true,
                      minHeight: "4em",
                      placeholder: "What this PR changes and why…",
                    })}
                  </Labeled>
                  <Labeled label="Commit message">
                    {exprText("commitMessage", {
                      placeholder: "defaults to the PR title",
                    })}
                  </Labeled>
                  <Labeled label="Head branch">
                    <input
                      value={str("headBranch")}
                      onChange={(e) =>
                        onChange({ headBranch: e.target.value || undefined })
                      }
                      style={inputStyle}
                      placeholder="naary/code-agent/<run> (force-pushed)"
                    />
                  </Labeled>
                </>
              )}
            </div>
          )}
        </>
      )}

      {kind === "textToSpeech" && (
        <>
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              lineHeight: "var(--leading-snug)",
              marginBottom: 4,
            }}
          >
            Speaks the text with your tenant's OpenAI key (BYOK). The audio goes
            to object storage — the node output carries a reference plus{" "}
            <code>format</code> / <code>voice</code> / <code>bytes</code>, and
            the run view can play or download it.
          </div>

          <Labeled label="Voice">
            <input
              value={str("voice")}
              onChange={(e) => onChange({ voice: e.target.value || undefined })}
              style={inputStyle}
              placeholder="alloy"
            />
          </Labeled>

          {/* A free-text input, NOT a select, for the same reason codeAgent's Model field is one:
              the schema is an open `z.string()`, so a graph can legitimately carry a model a
              fixed option list doesn't know (gpt-4o-mini-tts, or whatever ships next). A select
              would render blank for that value and overwrite it on the first click. */}
          <Labeled label="Model">
            <input
              value={str("model")}
              onChange={(e) => onChange({ model: e.target.value || undefined })}
              style={inputStyle}
              placeholder="tts-1 (or tts-1-hd for higher quality)"
            />
          </Labeled>

          <div style={{ display: "flex", gap: 10 }}>
            <Labeled label="Format">
              <select
                value={str("format") || "mp3"}
                onChange={(e) => onChange({ format: e.target.value })}
                style={inputStyle}
              >
                {["mp3", "opus", "aac", "flac", "wav", "pcm"].map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </Labeled>
            <Labeled label="Speed (0.25–4)">
              <input
                type="number"
                min={0.25}
                max={4}
                step={0.25}
                value={num("speed") ?? ""}
                onChange={(e) => {
                  // Schema clamps 0.25–4 — anything outside that (or a partial/empty input,
                  // which reads as NaN) becomes undefined so an out-of-range keystroke can't
                  // make the whole GRAPH unsaveable from a different screen.
                  const v = e.target.valueAsNumber;
                  onChange({
                    speed:
                      Number.isFinite(v) && v >= 0.25 && v <= 4 ? v : undefined,
                  });
                }}
                style={inputStyle}
                placeholder="1"
              />
            </Labeled>
          </div>

          <div>
            <RowHead label="Text" value={`${str("text").length} chars`} />
            {/* Not exprText: that writes "" when cleared, and the schema is `min(1)` when
                `text` is PRESENT — a blank string would 400 the whole save. Empty → undefined
                (the node then takes its text from the binding below). */}
            <ExpressionField
              value={str("text")}
              onChange={(v) => onChange({ text: v || undefined })}
              nodeId={node.id}
              edges={edges}
              pins={pins}
              nodeKinds={nodeKinds}
              multiline
              minHeight="5em"
              placeholder="Text to speak, or {{ upstream.path }}…"
            />
          </div>

          <BindingsEditor
            bindings={
              config.textBinding
                ? { text: config.textBinding as BindingRow }
                : undefined
            }
            upstreamIds={upstreamIds}
            onChange={(v) =>
              onChange({ textBinding: v ? Object.values(v)[0] : undefined })
            }
          />
          <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}>
            Bind <code>text</code> from an upstream output instead of typing it
            (the resolved value replaces the field above).
          </div>
        </>
      )}

      {kind === "mcpTool" && (
        <>
          <Labeled label="Connection">
            <ConnectionSelect
              connections={connections}
              types={CONNECTION_TYPES[kind] ?? []}
              value={str("connectionId")}
              onChange={(id) => onChange({ connectionId: id })}
            />
          </Labeled>
          <Labeled label="Tool">
            <input
              value={str("tool")}
              onChange={(e) => onChange({ tool: e.target.value })}
              style={inputStyle}
              placeholder="add_pull_request_comment"
            />
          </Labeled>

          <BindingsEditor
            bindings={
              obj("argumentBindings") as Record<string, BindingRow> | undefined
            }
            upstreamIds={upstreamIds}
            onChange={(v) => onChange({ argumentBindings: v })}
          />

          <JsonField
            label="Static arguments (JSON)"
            value={obj("arguments")}
            placeholder={'{\n  "state": "open"\n}'}
            onChange={(v) => onChange({ arguments: v })}
          />

          <Labeled label="Cost (USD per call)">
            <input
              type="number"
              min={0}
              step={0.001}
              value={num("costUsd") ?? ""}
              onChange={(e) =>
                onChange({
                  costUsd: e.target.value ? Number(e.target.value) : undefined,
                })
              }
              style={inputStyle}
              placeholder="0.00"
            />
          </Labeled>
        </>
      )}

      {kind === "integration" &&
        (() => {
          // Data-driven from the integration catalog (@naary/dsl): provider is preset by the
          // palette tile; the action list + its fields come from the catalog, so a new
          // integration never needs a new panel branch.
          const provider = getIntegrationProvider(str("provider"));
          const action = provider?.actions.find((a) => a.key === str("action"));
          const fields = (obj("fields") ?? {}) as Record<string, unknown>;
          // A field can be satisfied by an upstream BINDING (below) instead of a typed value —
          // so a required field bound from a prior step is NOT "missing". Look up the binding
          // per field to show a "bound from …" hint and drop the required `*` nag when bound.
          const fieldBindings = (obj("fieldBindings") ?? {}) as Record<
            string,
            BindingRow
          >;
          const boundFrom = (key: string): string | null => {
            const b = fieldBindings[key];
            if (!b?.from) return null;
            return b.path ? `${b.from}.${b.path}` : b.from;
          };
          // Coerce the typed-in string to the catalog field's type, so a static value is stored
          // as the right JSON type (a number, or a string[] for labels) instead of a raw string
          // that would build a malformed request.
          const coerce = (type: string | undefined, raw: string): unknown => {
            if (type === "number") return raw === "" ? "" : Number(raw);
            if (type === "boolean") return raw === "true";
            if (type === "string[]")
              return raw
                .split(/[\n,]/)
                .map((s) => s.trim())
                .filter((s) => s.length > 0);
            return raw;
          };
          const setField = (
            key: string,
            type: string | undefined,
            raw: string,
          ) => onChange({ fields: { ...fields, [key]: coerce(type, raw) } });
          // Render the stored value back into the input.
          const display = (v: unknown): string =>
            Array.isArray(v) ? v.join(", ") : v == null ? "" : String(v);
          return (
            <>
              <Labeled label="Provider">
                <input
                  value={provider?.label ?? str("provider")}
                  disabled
                  style={inputStyle}
                />
              </Labeled>
              <Labeled label="Connection">
                <ConnectionSelect
                  connections={connections}
                  types={CONNECTION_TYPES[kind] ?? []}
                  value={str("connectionId")}
                  onChange={(id) => onChange({ connectionId: id })}
                />
                {/* #815 — the catalog already knows exactly how this provider authenticates, and
                    that string was rendered in exactly one place nobody stands: the Node Catalog
                    drawer. This is the moment the question gets asked ("how do I add PagerDuty?"),
                    so it is the moment to answer it. Read-only catalog data, no new concepts. */}
                {provider?.auth && (
                  <ProviderAuthHint
                    provider={provider.label}
                    auth={provider.auth}
                    baseUrl={provider.baseUrl}
                    fromConnection={!!provider.baseUrlFromConnection}
                    needsConnection={!str("connectionId")}
                  />
                )}
              </Labeled>
              <Labeled label="Action">
                <select
                  value={str("action")}
                  // Switching action clears the static fields (each action has its own set).
                  onChange={(e) =>
                    onChange({ action: e.target.value, fields: {} })
                  }
                  style={inputStyle}
                >
                  {(provider?.actions ?? []).map((a) => (
                    <option key={a.key} value={a.key}>
                      {a.label}
                    </option>
                  ))}
                </select>
              </Labeled>
              {action && (
                <div
                  style={{
                    fontSize: "var(--text-xs)",
                    color: "var(--ink-3)",
                    marginTop: -4,
                  }}
                >
                  {action.description}
                  {action.write ? " · runs at-most-once (no retry)" : ""}
                </div>
              )}
              {/* `const` fields are catalog-supplied API type discriminators (e.g. PagerDuty's
                  `incident.type`) — the request builder injects them, so rendering an input the
                  user can't change would only confuse. */}
              {(action?.fields ?? [])
                .filter((f) => f.const === undefined)
                .map((f) => {
                  const bound = boundFrom(f.key);
                  // Bound → the upstream value overrides any typed value at run time, and it
                  // satisfies "required", so show a hint + drop the `*` nag instead of the star.
                  const label = bound
                    ? `${f.label} · bound`
                    : `${f.label}${f.required ? " *" : ""}`;
                  const hint = bound ? (
                    <div
                      className="mono"
                      style={{
                        fontSize: "var(--text-2xs)",
                        color: "var(--ink-3)",
                        marginTop: 3,
                      }}
                    >
                      ↳ from {bound} (upstream value overrides this)
                    </div>
                  ) : null;
                  return f.type === "json" ? (
                    // Schema-driven value (Notion properties, etc.) — a raw JSON editor.
                    <div key={f.key}>
                      <JsonField
                        label={label}
                        value={fields[f.key]}
                        placeholder={f.hint ?? "{ }"}
                        // A `json` field accepts an object OR an array (e.g. Notion `children`).
                        allowArray
                        onChange={(v) =>
                          onChange({ fields: { ...fields, [f.key]: v } })
                        }
                      />
                      {hint}
                    </div>
                  ) : (
                    <div key={f.key}>
                      <Labeled label={label}>
                        {f.type === "string" ? (
                          // Free-text integration field (e.g. repo/owner/number) — supports
                          // {{ upstream.path }} with highlighting + autocomplete.
                          <ExpressionField
                            value={display(fields[f.key])}
                            onChange={(v) => setField(f.key, f.type, v)}
                            nodeId={node.id}
                            edges={edges}
                            pins={pins}
                            nodeKinds={nodeKinds}
                            placeholder={
                              bound
                                ? "bound from an upstream step ↓"
                                : (f.hint ?? "value or {{ upstream.path }}")
                            }
                          />
                        ) : (
                          <input
                            type={f.type === "number" ? "number" : "text"}
                            value={display(fields[f.key])}
                            onChange={(e) =>
                              setField(f.key, f.type, e.target.value)
                            }
                            style={inputStyle}
                            placeholder={
                              bound
                                ? "bound from an upstream step ↓"
                                : (f.hint ??
                                  (f.type === "string[]"
                                    ? "comma-separated, or bind from an upstream step"
                                    : ""))
                            }
                          />
                        )}
                      </Labeled>
                      {hint}
                    </div>
                  );
                })}
              <BindingsEditor
                bindings={
                  obj("fieldBindings") as Record<string, BindingRow> | undefined
                }
                upstreamIds={upstreamIds}
                onChange={(v) => onChange({ fieldBindings: v })}
              />
            </>
          );
        })()}
    </>
  );
}
