/**
 * The MCP-tool authoring surface: the `mcpTool` node's own panel, and the per-tool card inside the
 * agent node's in-loop `tools[]` editor.
 *
 * Both used to ask for a tool NAME as free text and — for the mcpTool node — its argument names as
 * free text too. #915 closed that for the `integration` node using the catalog; an MCP server's
 * equivalent has to be ASKED for, which is what `useMcpTools` does (`GET …/connections/:id/mcp/
 * tools`). With the answer in hand both names come from a list, and the tool's own `inputSchema`
 * supplies the argument names the bindings editor offers.
 *
 * Degradation is the design constraint, not an afterthought: an unreachable server, an
 * unauthorized connection, or a tool with no schema yields an EMPTY option list, and every control
 * here falls back to exactly the free text it had before. Nothing becomes uneditable because a
 * remote server is down.
 */
import type { McpToolSummary } from "@naary/dsl";
import { MCP_TOOL_COPY, mcpToolBindingOptions } from "./binding-name-model";
import type { ConnectionRow } from "../../lib/api";
import {
  BindingsEditor,
  type BindingRow,
  CONNECTION_TYPES,
  ConnectionSelect,
  JsonField,
  Labeled,
  PickOrTypeField,
  inputStyle,
} from "./fields";
import { type McpToolsState, useMcpTools } from "./useMcpTools";

/** Tool names as pick-options. The label is the NAME — never a prettified title, because the name
 *  is what gets stored and called. The description is shown separately, under the control. */
function toolOptions(tools: McpToolSummary[]) {
  return tools.map((t) => ({ value: t.name, label: t.name }));
}

/**
 * One line under the tool picker saying where the list came from — so an empty list is explained
 * rather than merely empty. This is the difference between "this server offers no tools" and "we
 * couldn't ask", which an author needs in order to know whether to fix the connection or the name.
 */
function ToolListStatus({
  state,
  connectionId,
  selected,
}: {
  state: McpToolsState;
  connectionId: string;
  selected?: McpToolSummary;
}) {
  if (!connectionId) {
    return <div style={hintStyle}>Pick a connection to list its tools.</div>;
  }
  if (state.loading) {
    return <div style={hintStyle}>Listing this server's tools…</div>;
  }
  if (state.error) {
    return (
      <div style={hintStyle}>
        <span style={{ color: "var(--state-error)" }}>{state.error}</span>{" "}
        <button type="button" onClick={state.reload} style={linkBtn}>
          Try again
        </button>{" "}
        — or type the tool name.
      </div>
    );
  }
  if (state.tools.length === 0) {
    return (
      <div style={hintStyle}>
        This server listed no tools.{" "}
        <button type="button" onClick={state.reload} style={linkBtn}>
          Refresh
        </button>
      </div>
    );
  }
  return (
    <div style={hintStyle}>
      {/* Rendered as TEXT: a description is written by whoever runs that server. */}
      {selected?.description ? (
        selected.description
      ) : (
        <>
          {state.tools.length} tool{state.tools.length === 1 ? "" : "s"} on this
          server.{" "}
          <button type="button" onClick={state.reload} style={linkBtn}>
            Refresh
          </button>
        </>
      )}
    </div>
  );
}

/**
 * The whole `mcpTool` node panel.
 *
 * A component (not a fragment inlined into `renderAgentSections`) because it owns a hook, and
 * `renderAgentSections` is a plain function called from a branch — a hook there would appear and
 * disappear as the selected node's kind changes, which is exactly the hook-order violation React
 * refuses to run.
 */
export function McpToolSection({
  connections,
  connectionId,
  tool,
  argumentBindings,
  staticArguments,
  costUsd,
  upstreamIds,
  onChange,
}: {
  connections: ConnectionRow[];
  connectionId: string;
  tool: string;
  argumentBindings: Record<string, BindingRow> | undefined;
  staticArguments: Record<string, unknown> | undefined;
  costUsd: number | undefined;
  upstreamIds: string[];
  onChange: (patch: Record<string, unknown>) => void;
}) {
  const mcp = useMcpTools(connectionId || undefined);
  const selected = mcp.tools.find((t) => t.name === tool);

  return (
    <>
      <Labeled label="Connection">
        <ConnectionSelect
          connections={connections}
          types={CONNECTION_TYPES.mcpTool ?? []}
          value={connectionId}
          onChange={(id) => onChange({ connectionId: id })}
        />
      </Labeled>
      <Labeled label="Tool">
        <PickOrTypeField
          value={tool}
          options={toolOptions(mcp.tools)}
          onChange={(next) => onChange({ tool: next })}
          copy={MCP_TOOL_COPY}
        />
        <ToolListStatus
          state={mcp}
          connectionId={connectionId}
          selected={selected}
        />
      </Labeled>

      {/* The chosen tool's own inputSchema names its arguments — so a binding is picked, not
          retyped. No schema (unlisted tool, unreachable server, a server that ships none) ⇒ an
          empty list ⇒ the name stays free text, exactly as it was before. */}
      <BindingsEditor
        bindings={argumentBindings}
        upstreamIds={upstreamIds}
        onChange={(v) => onChange({ argumentBindings: v })}
        options={mcpToolBindingOptions(selected?.inputSchema)}
      />

      <JsonField
        label="Static arguments (JSON)"
        value={staticArguments}
        placeholder={'{\n  "state": "open"\n}'}
        onChange={(v) => onChange({ arguments: v })}
      />

      <Labeled label="Cost (USD per call)">
        <input
          type="number"
          min={0}
          step={0.001}
          value={costUsd ?? ""}
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
  );
}

/**
 * The identity fields of ONE in-loop agent tool: which tool, what the model sees it as, and the
 * JSON Schema the model is given for its arguments.
 *
 * The schema matters more here than anywhere else: the worker falls back to an OPEN object
 * (`{type:"object", additionalProperties:true}`) when it's absent, so a model calling this tool is
 * guessing argument names. The server already knows them — "Fill from the server" copies them in.
 *
 * That fill is always an EXPLICIT click, never a side effect of picking a tool: `description` and
 * `inputSchema` are author-editable, and silently replacing hand-tuned JSON the moment someone
 * re-picks the same tool would destroy work with no undo.
 */
export function AgentMcpToolFields({
  connectionId,
  tool,
  name,
  description,
  inputSchema,
  onChange,
}: {
  connectionId: string;
  tool: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown> | undefined;
  onChange: (patch: {
    tool?: string;
    name?: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  }) => void;
}) {
  const mcp = useMcpTools(connectionId || undefined);
  const selected = mcp.tools.find((t) => t.name === tool);
  const fillable = selected?.inputSchema !== undefined;

  return (
    <>
      <Labeled label="Tool name">
        <PickOrTypeField
          value={tool}
          options={toolOptions(mcp.tools)}
          onChange={(next) => onChange({ tool: next })}
          copy={MCP_TOOL_COPY}
        />
        <ToolListStatus
          state={mcp}
          connectionId={connectionId}
          selected={selected}
        />
      </Labeled>
      <Labeled label="Exposed name (optional)">
        <input
          value={name}
          onChange={(e) => onChange({ name: e.target.value || undefined })}
          style={inputStyle}
          placeholder="defaults to the tool name"
        />
      </Labeled>
      <Labeled label="Description">
        <input
          value={description}
          onChange={(e) =>
            onChange({ description: e.target.value || undefined })
          }
          style={inputStyle}
          placeholder="what the model uses to decide when to call it"
        />
      </Labeled>
      <JsonField
        label="Input schema (JSON)"
        value={inputSchema}
        placeholder={'{\n  "type": "object",\n  "properties": {}\n}'}
        onChange={(v) =>
          onChange({ inputSchema: v as Record<string, unknown> | undefined })
        }
      />
      {fillable && (
        <div style={hintStyle}>
          <button
            type="button"
            onClick={() =>
              onChange({
                inputSchema: selected?.inputSchema,
                // Only when the author left it blank — their words win over the server's.
                ...(description ? {} : { description: selected?.description }),
              })
            }
            style={linkBtn}
          >
            Fill from the server
          </button>{" "}
          — use <code>{tool}</code>&apos;s own schema, so the model is told the
          real argument names.
        </div>
      )}
    </>
  );
}

const hintStyle: React.CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--ink-3)",
  marginTop: 4,
};
const linkBtn: React.CSSProperties = {
  all: "unset",
  cursor: "pointer",
  color: "var(--brand)",
  fontWeight: 600,
};
