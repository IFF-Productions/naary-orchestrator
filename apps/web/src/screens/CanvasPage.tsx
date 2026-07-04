/**
 * The workflow canvas: a drag-and-drop editor (react-flow) that compiles to the
 * platform GraphDef and runs it. Closes the core loop — author visually → save →
 * durable execution.
 *
 * Flow: edit nodes/edges → live compileGraph() (same validation the API runs) →
 * Run → saveGraph("canvas") → startExecution("canvas") → land on the run view.
 * Seeded with a credential-free start → approval → end graph, so a first Run
 * completes (pauses at approval, no BYOK LLM key needed).
 */
import "@xyflow/react/dist/style.css";
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  type Connection,
  Controls,
  type Edge,
  Handle,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { NodeType } from "@naary/dsl";
import { Button } from "../components";
import {
  api,
  type GraphSummary,
  UnauthorizedError,
  type WebhookRow,
} from "../lib/api";
import { compileGraph } from "../lib/compile-graph";
import { decompileGraph } from "../lib/decompile-graph";
import type { JsonSchemaObject } from "../lib/schema-fields";
import { SchemaEditor } from "./canvas/SchemaFieldEditor";
import {
  type CanvasEdge,
  type CanvasNode,
  CONDITION_OPS,
  type EdgeConditionDraft,
  NODE_GROUPS,
  NODE_KINDS,
} from "../lib/graph-model";

const DEFAULT_KEY = "canvas";

/** Stable workflowKey derived from a display name (for newly-created workflows). */
function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || DEFAULT_KEY
  );
}

function toFlowNodes(cs: CanvasNode[]): Node<NaaryData>[] {
  return cs.map((c) => ({
    id: c.id,
    type: "naary",
    position: c.position,
    data: { kind: c.type, config: c.config },
  }));
}
function toFlowEdges(cs: CanvasEdge[]): FlowEdge[] {
  return cs.map((c) => ({
    id: c.id,
    source: c.source,
    target: c.target,
    data: { condition: c.condition },
    label: summarize(c.condition),
  }));
}

/** DSL node type → theme accent color (the design palette). */
const ACCENT: Record<NodeType, string> = {
  start: "var(--node-trigger)",
  webhookTrigger: "var(--node-trigger)",
  agent: "var(--node-agent)",
  mcpTool: "var(--node-mcp)",
  httpRequest: "var(--node-http, #2f9e8f)",
  sqlQuery: "var(--node-sql, #b06fd6)",
  set: "var(--node-set, #d98a3d)",
  renameKeys: "var(--node-rename, #c9803e)",
  filter: "var(--node-filter, #3f9e8f)",
  aggregate: "var(--node-aggregate, #b0863e)",
  listOps: "var(--node-listops, #4f9e7f)",
  dateTime: "var(--node-datetime, #6f8fd6)",
  merge: "var(--node-merge, #3fae86)",
  hmac: "var(--node-hmac, #a86fd6)",
  jwt: "var(--node-jwt, #7a6fd6)",
  totp: "var(--node-totp, #9a6fc6)",
  sendEmail: "var(--node-email, #4f9ad6)",
  rssRead: "var(--node-rss, #d98a5a)",
  executeSubWorkflow: "var(--node-subflow, #5b8def)",
  forEach: "var(--node-foreach, #5b6fd6)",
  wait: "var(--node-wait, #8a8f98)",
  stopAndError: "var(--node-error, #d6584f)",
  respondToWebhook: "var(--node-respond, #3f8fae)",
  code: "var(--node-code, #6f7a8f)",
  humanApproval: "var(--node-approval)",
  end: "var(--node-end)",
};
const LABEL = Object.fromEntries(
  NODE_KINDS.map((k) => [k.type, k.label]),
) as Record<NodeType, string>;

interface NaaryData extends Record<string, unknown> {
  kind: NodeType;
  config?: Record<string, unknown>;
}

/** A node on the canvas: accent bar, label, and connection handles. Entry nodes
 *  have no inbound handle; `end` has no outbound. */
function NaaryNode({ data, selected }: NodeProps<Node<NaaryData>>) {
  const kind = data.kind;
  const accent = ACCENT[kind];
  const isEntry = kind === "start" || kind === "webhookTrigger";
  const subtitle = nodeSubtitle(kind, data.config);
  return (
    <div
      style={{
        minWidth: 132,
        borderRadius: 10,
        border: `1px solid ${accent}`,
        outline: selected ? `2px solid ${accent}` : "none",
        background: "var(--card)",
        color: "var(--ink)",
        fontFamily: "var(--font-sans)",
        fontSize: 13,
        overflow: "hidden",
        boxShadow: "0 1px 2px rgba(0,0,0,.18)",
      }}
    >
      {!isEntry && <Handle type="target" position={Position.Left} />}
      <div style={{ height: 4, background: accent }} />
      <div
        style={{
          padding: subtitle ? "9px 12px 4px" : "9px 12px",
          fontWeight: 600,
        }}
      >
        {LABEL[kind]}
      </div>
      {subtitle && (
        <div
          className="mono"
          style={{
            padding: "0 12px 9px",
            fontSize: 10,
            color: "var(--ink-3)",
            maxWidth: 180,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {subtitle}
        </div>
      )}
      {kind !== "end" && <Handle type="source" position={Position.Right} />}
    </div>
  );
}

/** A one-line config preview under the node title (model for agents, the tool for
 *  mcpTool) — mirrors the design's nodes showing their key config. */
function nodeSubtitle(
  kind: NodeType,
  config?: Record<string, unknown>,
): string | undefined {
  if (!config) return undefined;
  if (kind === "agent") {
    const model = config.model as string | undefined;
    return model ? model.replace("claude-", "") : undefined;
  }
  if (kind === "mcpTool") {
    const tool = config.tool as string | undefined;
    const conn = config.connectionId as string | undefined;
    if (tool && conn) return `${conn} · ${tool}`;
    return tool || conn || undefined;
  }
  if (kind === "httpRequest") {
    const method = (config.method as string | undefined) ?? "GET";
    const url = config.url as string | undefined;
    if (!url) return method;
    const short = url.replace(/^https?:\/\//, "");
    return `${method} ${short}`;
  }
  if (kind === "sqlQuery") {
    const conn = config.connectionId as string | undefined;
    const sql = config.sql as string | undefined;
    const snippet = sql
      ? sql.replace(/\s+/g, " ").trim().slice(0, 32)
      : undefined;
    if (conn && snippet) return `${conn} · ${snippet}`;
    return conn || snippet || undefined;
  }
  if (kind === "set") {
    const fields = (config.fields as Record<string, unknown> | undefined) ?? {};
    const binds =
      (config.fieldBindings as Record<string, unknown> | undefined) ?? {};
    const keys = new Set([...Object.keys(fields), ...Object.keys(binds)]);
    const n = keys.size;
    return n ? `${n} field${n === 1 ? "" : "s"}` : undefined;
  }
  if (kind === "merge") {
    const mode = (config.mode as string | undefined) ?? "array";
    return `join · ${mode}`;
  }
  if (kind === "renameKeys") {
    const from = config.from as string | undefined;
    return from ? `from ${from}` : undefined;
  }
  if (kind === "filter") {
    const c = config.condition as { path?: string; op?: string } | undefined;
    return c?.path ? `${c.path} ${c.op ?? ""}`.trim() : undefined;
  }
  if (kind === "aggregate" || kind === "listOps") {
    const op = config.operation as string | undefined;
    return op || undefined;
  }
  if (kind === "dateTime") {
    const src = config.source;
    return src && src !== "now" ? "from upstream" : "now";
  }
  if (kind === "hmac" || kind === "jwt" || kind === "totp") {
    const conn = config.connectionId as string | undefined;
    return conn || undefined;
  }
  if (kind === "sendEmail") {
    const to = config.to as string | undefined;
    return to ? `→ ${to}` : (config.connectionId as string | undefined);
  }
  if (kind === "rssRead") {
    const url = config.url as string | undefined;
    return url ? url.replace(/^https?:\/\//, "").slice(0, 32) : undefined;
  }
  if (kind === "executeSubWorkflow") {
    const key = config.workflowKey as string | undefined;
    return key ? `↳ ${key}` : undefined;
  }
  if (kind === "forEach") {
    const key = config.workflowKey as string | undefined;
    return key ? `⟳ ${key}` : undefined;
  }
  if (kind === "wait") {
    const secs = config.durationSeconds as number | undefined;
    return secs && secs > 0 ? `${secs}s` : undefined;
  }
  if (kind === "stopAndError") {
    const msg = config.message as string | undefined;
    return msg ? msg.slice(0, 32) : undefined;
  }
  if (kind === "respondToWebhook") {
    return `HTTP ${(config.statusCode as number | undefined) ?? 200}`;
  }
  if (kind === "code") {
    const c = config.code as string | undefined;
    if (!c) return "JS";
    const lines = c.split("\n").length;
    return `JS · ${lines} line${lines === 1 ? "" : "s"}`;
  }
  return undefined;
}

const nodeTypes = { naary: NaaryNode };

interface EdgeData extends Record<string, unknown> {
  condition?: EdgeConditionDraft;
}
type FlowEdge = Edge<EdgeData>;

/** Short label for a conditional edge (shown on the canvas). */
function summarize(c?: EdgeConditionDraft): string | undefined {
  if (!c || !c.path.trim()) return undefined;
  if (c.op === "exists") return `${c.path} exists`;
  return `${c.path} ${c.op} ${c.value}`;
}

const SEED_NODES: Node<NaaryData>[] = [
  {
    id: "start",
    type: "naary",
    position: { x: 40, y: 140 },
    data: { kind: "start" },
  },
  {
    id: "approval",
    type: "naary",
    position: { x: 300, y: 140 },
    data: { kind: "humanApproval" },
  },
  {
    id: "end",
    type: "naary",
    position: { x: 560, y: 140 },
    data: { kind: "end" },
  },
];
const SEED_EDGES: FlowEdge[] = [
  { id: "e1", source: "start", target: "approval" },
  { id: "e2", source: "approval", target: "end" },
];

export function CanvasPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [nodes, setNodes] = useState<Node<NaaryData>[]>(SEED_NODES);
  const [edges, setEdges] = useState<FlowEdge[]>(SEED_EDGES);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [name, setName] = useState("Canvas draft");
  const [paletteQuery, setPaletteQuery] = useState("");
  // The saved workflowKey (empty until first save of a NEW workflow → slug(name)).
  const [workflowKey, setWorkflowKey] = useState("");
  const [workflows, setWorkflows] = useState<GraphSummary[]>([]);
  const [webhooks, setWebhooks] = useState<WebhookRow[]>([]);
  // Optional per-run input (JSON) — overrides the Start node's sampleInput for the
  // next run. Blank ⇒ the server falls back to the sample (api.startExecution).
  const [showInput, setShowInput] = useState(false);
  const [runInput, setRunInput] = useState("");

  const keyParam = searchParams.get("key");
  const templateParam = searchParams.get("template");

  // Registered webhook endpoints (so a webhookTrigger node can show its hook URL).
  useEffect(() => {
    let live = true;
    api
      .getMe()
      .then((me) => api.listWebhooks(me.tenantId))
      .then((ws) => live && setWebhooks(ws))
      .catch(() => {
        /* unauthenticated / none — webhook node shows the register hint */
      });
    return () => {
      live = false;
    };
  }, []);

  // Load the workflow list (for the selector) + open ?key= if present.
  useEffect(() => {
    let live = true;
    api
      .listGraphs()
      .then((ws) => live && setWorkflows(ws))
      .catch(() => {
        /* unauthenticated / offline — selector stays empty */
      });
    if (templateParam) {
      // Fork a built-in template: load its graph as a NEW draft (workflowKey stays
      // empty so Save creates a fresh workflow; name is prefilled + editable).
      api
        .getTemplate(templateParam)
        .then((t) => {
          if (!live) return;
          const { nodes: cn, edges: ce } = decompileGraph(t.graph);
          setNodes(toFlowNodes(cn));
          setEdges(toFlowEdges(ce));
          setName(t.name);
          setWorkflowKey("");
          setStatus(`Forked from template "${t.name}" — Save to keep it.`);
        })
        .catch(
          () => live && setStatus(`Couldn't load template '${templateParam}'.`),
        );
    } else if (keyParam) {
      api
        .getGraph(keyParam)
        .then((g) => {
          if (!live) return;
          const { nodes: cn, edges: ce } = decompileGraph(g.graph);
          setNodes(toFlowNodes(cn));
          setEdges(toFlowEdges(ce));
          setName(g.name);
          setWorkflowKey(g.workflowKey);
          setStatus(null);
        })
        .catch(
          () => live && setStatus(`Couldn't open workflow '${keyParam}'.`),
        );
    }
    return () => {
      live = false;
    };
  }, [keyParam, templateParam]);

  const onNodesChange = useCallback(
    (changes: Parameters<typeof applyNodeChanges>[0]) =>
      setNodes((ns) => applyNodeChanges(changes, ns) as Node<NaaryData>[]),
    [],
  );
  const onEdgesChange = useCallback(
    (changes: Parameters<typeof applyEdgeChanges>[0]) =>
      setEdges((es) => applyEdgeChanges(changes, es) as FlowEdge[]),
    [],
  );
  const onConnect = useCallback(
    (c: Connection) => setEdges((es) => addEdge(c, es) as FlowEdge[]),
    [],
  );

  // Compile live so the status line mirrors what the API would accept.
  const { graph, error } = useMemo(() => {
    const canvasNodes: CanvasNode[] = nodes.map((n) => ({
      id: n.id,
      type: n.data.kind,
      position: n.position,
      config: n.data.config,
    }));
    const canvasEdges = edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      condition: e.data?.condition,
    }));
    return compileGraph(canvasNodes, canvasEdges);
  }, [nodes, edges]);

  const selected = nodes.find((n) => n.selected);
  const selectedEdge = edges.find((e) => e.selected);

  // Webhook endpoint URLs registered for THIS workflow (shown in the webhook node).
  const hookUrls = webhooks
    .filter((w) => workflowKey && w.workflowId === workflowKey)
    .map((w) => `/hooks/${w.id}`);

  // Close the inspector modal by clearing the react-flow selection.
  function closeInspector(): void {
    setNodes((ns) =>
      ns.map((n) => (n.selected ? { ...n, selected: false } : n)),
    );
    setEdges((es) =>
      es.map((e) => (e.selected ? { ...e, selected: false } : e)),
    );
  }

  // Remove a node + any edges touching it (the modal's Delete button). Removing the
  // node clears the selection, so the inspector modal closes on its own.
  function deleteNode(id: string): void {
    setNodes((ns) => ns.filter((n) => n.id !== id));
    setEdges((es) => es.filter((e) => e.source !== id && e.target !== id));
  }
  function deleteEdge(id: string): void {
    setEdges((es) => es.filter((e) => e.id !== id));
  }

  function addNode(kind: NodeType) {
    const id = `${kind}-${crypto.randomUUID().slice(0, 8)}`;
    // Seed agent defaults so a node the user never opens still runs (provider/model
    // are otherwise only written to config when the inspector dropdowns change).
    const config: Record<string, unknown> | undefined =
      kind === "agent"
        ? { provider: "anthropic", model: "claude-opus-4-8" }
        : kind === "httpRequest"
          ? { method: "GET" }
          : undefined;
    setNodes((ns) => [
      ...ns,
      {
        id,
        type: "naary",
        position: {
          x: 160 + (ns.length % 5) * 40,
          y: 300 + (ns.length % 3) * 30,
        },
        data: { kind, config },
      },
    ]);
  }

  function updateConfig(nodeId: string, patch: Record<string, unknown>) {
    setNodes((ns) =>
      ns.map((n) =>
        n.id === nodeId
          ? {
              ...n,
              data: { ...n.data, config: { ...n.data.config, ...patch } },
            }
          : n,
      ),
    );
  }

  function updateEdgeCondition(
    edgeId: string,
    patch: Partial<EdgeConditionDraft>,
  ) {
    setEdges((es) =>
      es.map((e) => {
        if (e.id !== edgeId) return e;
        const condition: EdgeConditionDraft = {
          path: "",
          op: "eq",
          value: "",
          ...e.data?.condition,
          ...patch,
        };
        return {
          ...e,
          data: { ...e.data, condition },
          label: summarize(condition),
        };
      }),
    );
  }

  function clearEdgeCondition(edgeId: string) {
    setEdges((es) =>
      es.map((e) =>
        e.id === edgeId
          ? {
              ...e,
              data: { ...e.data, condition: undefined },
              label: undefined,
            }
          : e,
      ),
    );
  }

  /** The key to save/run under: an opened workflow's key, else slug(name). */
  const activeKey = workflowKey || slugify(name);

  function newWorkflow() {
    setNodes(SEED_NODES);
    setEdges(SEED_EDGES);
    setName("Untitled workflow");
    setWorkflowKey("");
    setStatus(null);
    if (keyParam) setSearchParams({}, { replace: true });
  }

  function openWorkflow(key: string) {
    if (key) setSearchParams({ key }, { replace: true });
    else newWorkflow();
  }

  async function save(): Promise<string | null> {
    if (!graph) {
      setStatus(error ?? "Graph is not runnable.");
      return null;
    }
    const key = activeKey;
    await api.saveGraph(key, name.trim() || "Untitled workflow", graph);
    setWorkflowKey(key);
    api
      .listGraphs()
      .then(setWorkflows)
      .catch(() => {});
    return key;
  }

  async function run() {
    // Parse the optional run input BEFORE any save, so a malformed payload doesn't
    // mutate state. Blank ⇒ undefined (server uses the Start node's sampleInput).
    let input: Record<string, unknown> | undefined;
    if (showInput && runInput.trim()) {
      try {
        const parsed = JSON.parse(runInput);
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          Array.isArray(parsed)
        ) {
          setStatus("Run input must be a JSON object.");
          return;
        }
        input = parsed as Record<string, unknown>;
      } catch {
        setStatus("Run input is not valid JSON.");
        return;
      }
    }
    setBusy(true);
    setStatus(null);
    try {
      const key = await save();
      if (!key) return;
      const { workflowId } = await api.startExecution(key, input);
      navigate(`/app/runs/${encodeURIComponent(workflowId)}`);
    } catch (e) {
      if (e instanceof UnauthorizedError) {
        navigate("/auth");
        return;
      }
      setStatus(e instanceof Error ? e.message : "Run failed.");
    } finally {
      setBusy(false);
    }
  }

  async function saveOnly() {
    setBusy(true);
    setStatus(null);
    try {
      const key = await save();
      if (key) setStatus(`Saved as "${name}" (${key}).`);
    } catch (e) {
      if (e instanceof UnauthorizedError) {
        navigate("/auth");
        return;
      }
      setStatus(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        background: "var(--bg)",
        color: "var(--ink)",
      }}
    >
      {/* header */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          padding: "12px 18px",
          borderBottom: "1px solid var(--line)",
          background: "var(--surface)",
        }}
      >
        <Button variant="secondary" onClick={() => navigate("/app")}>
          ← Back
        </Button>

        {/* workflow selector */}
        <select
          value={keyParam ?? ""}
          onChange={(e) => openWorkflow(e.target.value)}
          style={{ ...headerInputStyle, maxWidth: 180 }}
          title="Open a saved workflow"
        >
          <option value="">+ New workflow</option>
          {workflows.map((w) => (
            <option key={w.workflowKey} value={w.workflowKey}>
              {w.name} (v{w.version})
            </option>
          ))}
        </select>

        {/* name */}
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Workflow name"
          style={{ ...headerInputStyle, width: 170 }}
          aria-label="Workflow name"
        />
        <span style={{ fontSize: 11, color: "var(--ink-3)" }}>
          key: {activeKey}
        </span>

        <span
          style={{
            fontSize: 12,
            padding: "3px 10px",
            borderRadius: 999,
            background: graph ? "var(--state-done)" : "var(--state-error)",
            color: "#fff",
          }}
        >
          {graph ? "valid" : (error ?? "invalid")}
        </span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 10 }}>
          {status && (
            <span
              style={{
                fontSize: 12,
                color: "var(--ink-2)",
                alignSelf: "center",
                maxWidth: 280,
              }}
            >
              {status}
            </span>
          )}
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => setShowInput((s) => !s)}
          >
            {showInput ? "Hide input" : "Input"}
          </Button>
          <Button
            variant="secondary"
            disabled={busy || !graph}
            onClick={() => void saveOnly()}
          >
            Save
          </Button>
          <Button
            variant="primary"
            disabled={busy || !graph}
            onClick={() => void run()}
          >
            {busy ? "Running…" : "Save & run"}
          </Button>
        </div>
      </header>

      {showInput && (
        <div
          style={{
            padding: "10px 16px",
            borderBottom: "1px solid var(--line)",
            background: "var(--surface)",
          }}
        >
          <div style={{ fontSize: 11, color: "var(--ink-3)", marginBottom: 4 }}>
            Run input (JSON) — overrides the Start node's sample input for this
            run; leave blank to use the sample.
          </div>
          <textarea
            value={runInput}
            onChange={(e) => setRunInput(e.target.value)}
            rows={3}
            spellCheck={false}
            className="mono"
            placeholder={'{\n  "message": "I was charged twice"\n}'}
            style={{
              width: "100%",
              fontFamily: "var(--font-mono)",
              fontSize: 11.5,
              padding: "7px 9px",
              borderRadius: 7,
              border: "1px solid var(--line-2)",
              background: "var(--card)",
              color: "var(--ink)",
              resize: "vertical",
            }}
          />
        </div>
      )}

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {/* palette */}
        <aside
          style={{
            width: 168,
            padding: 14,
            borderRight: "1px solid var(--line)",
            background: "var(--surface)",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div style={{ fontSize: 11, color: "var(--ink-3)", marginBottom: 2 }}>
            ADD NODE
          </div>
          <input
            value={paletteQuery}
            onChange={(e) => setPaletteQuery(e.target.value)}
            placeholder="Search nodes…"
            aria-label="Search nodes"
            style={{
              padding: "6px 9px",
              borderRadius: 8,
              border: "1px solid var(--line-2)",
              background: "var(--card)",
              color: "var(--ink)",
              fontSize: 12.5,
            }}
          />
          <div
            style={{
              overflowY: "auto",
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            {NODE_GROUPS.map((group) => {
              const q = paletteQuery.trim().toLowerCase();
              const items = NODE_KINDS.filter(
                (k) =>
                  k.group === group &&
                  (!q ||
                    k.label.toLowerCase().includes(q) ||
                    k.type.toLowerCase().includes(q)),
              );
              if (items.length === 0) return null;
              return (
                <div
                  key={group}
                  style={{ display: "flex", flexDirection: "column", gap: 6 }}
                >
                  <div
                    style={{
                      fontSize: 10,
                      fontWeight: 600,
                      letterSpacing: 0.4,
                      textTransform: "uppercase",
                      color: "var(--ink-3)",
                    }}
                  >
                    {group}
                  </div>
                  {items.map((k) => (
                    <button
                      type="button"
                      key={k.type}
                      onClick={() => addNode(k.type)}
                      style={{
                        textAlign: "left",
                        padding: "8px 10px",
                        borderRadius: 8,
                        border: "1px solid var(--line-2)",
                        borderLeft: `3px solid ${ACCENT[k.type]}`,
                        background: "var(--card)",
                        color: "var(--ink)",
                        cursor: "pointer",
                        fontSize: 13,
                      }}
                    >
                      {k.label}
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
          <div
            style={{
              marginTop: "auto",
              fontSize: 11,
              color: "var(--ink-3)",
              lineHeight: 1.5,
            }}
          >
            Drag to move · drag a handle to connect · select + Backspace to
            delete.
          </div>
        </aside>

        {/* canvas */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            fitView
          >
            <Background />
            <Controls />
          </ReactFlow>
        </div>
      </div>

      {/* node / edge editor — a modal so it has room for the richer config */}
      {(selected || selectedEdge) && (
        <InspectorModal
          title={selected ? "Edit node" : "Edit branch condition"}
          onClose={closeInspector}
          onDelete={
            selected
              ? () => deleteNode(selected.id)
              : selectedEdge
                ? () => deleteEdge(selectedEdge.id)
                : undefined
          }
          deleteLabel={selected ? "Delete node" : "Delete edge"}
        >
          {selected ? (
            <ConfigPanel
              key={selected.id}
              node={selected}
              upstreamIds={nodes
                .filter((n) => n.id !== selected.id)
                .map((n) => n.id)}
              hookUrls={hookUrls}
              onChange={(patch) => updateConfig(selected.id, patch)}
            />
          ) : selectedEdge ? (
            <EdgeConfigPanel
              key={selectedEdge.id}
              condition={selectedEdge.data?.condition}
              onChange={(patch) => updateEdgeCondition(selectedEdge.id, patch)}
              onClear={() => clearEdgeCondition(selectedEdge.id)}
            />
          ) : null}
        </InspectorModal>
      )}
    </div>
  );
}

/** Centered modal overlay for the node/edge editor; backdrop + Esc close it. */
function InspectorModal({
  title,
  onClose,
  onDelete,
  deleteLabel,
  children,
}: {
  title: string;
  onClose: () => void;
  onDelete?: () => void;
  deleteLabel?: string;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click-to-close; Esc handled below
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 50,
        padding: 24,
      }}
    >
      <div
        // biome-ignore lint/a11y/useKeyWithClickEvents: stop backdrop close when clicking inside
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 520,
          maxWidth: "100%",
          maxHeight: "85vh",
          display: "flex",
          flexDirection: "column",
          background: "var(--surface)",
          border: "1px solid var(--line)",
          borderRadius: 12,
          boxShadow: "0 12px 40px rgba(0,0,0,.4)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "12px 16px",
            borderBottom: "1px solid var(--line)",
          }}
        >
          <strong style={{ fontSize: 14 }}>{title}</strong>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            style={{
              border: "1px solid var(--line-2)",
              background: "var(--card)",
              color: "var(--ink-2)",
              borderRadius: 6,
              cursor: "pointer",
              padding: "2px 9px",
              fontSize: 14,
            }}
          >
            ✕
          </button>
        </div>
        <div style={{ padding: 16, overflowY: "auto" }}>{children}</div>
        {onDelete && (
          <div
            style={{
              padding: "10px 16px",
              borderTop: "1px solid var(--line)",
              display: "flex",
              justifyContent: "flex-end",
            }}
          >
            <Button variant="danger" icon="trash" onClick={onDelete}>
              {deleteLabel ?? "Delete"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Provider/model options the runtime actually supports today (buildModel is
 *  anthropic-only — offering others would author nodes that fail at run time). */
const PROVIDERS = ["anthropic"] as const;
const MODELS: Record<string, string[]> = {
  anthropic: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"],
};

/** One upstream→argument binding row in the mcpTool editor. */
interface BindingRow {
  from: string;
  path?: string;
}

/** Per-type config editor for the selected node — matches the design's inspector.
 *  Only the types with meaningful config (agent, mcpTool) expose fields; others
 *  are structural. Every field maps to a real DSL/runtime config key. */
function ConfigPanel({
  node,
  upstreamIds,
  hookUrls,
  onChange,
}: {
  node: Node<NaaryData>;
  upstreamIds: string[];
  hookUrls: string[];
  onChange: (patch: Record<string, unknown>) => void;
}) {
  const kind = node.data.kind;
  const config = node.data.config ?? {};
  const str = (k: string) => (config[k] as string | undefined) ?? "";
  const num = (k: string) => config[k] as number | undefined;
  const obj = (k: string) =>
    (config[k] as Record<string, unknown> | undefined) ?? undefined;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* header */}
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <span
          style={{
            width: 28,
            height: 28,
            borderRadius: 8,
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
          <div style={{ fontSize: 14, fontWeight: 600 }}>{LABEL[kind]}</div>
          <div className="mono" style={{ fontSize: 10, color: "var(--ink-3)" }}>
            {kind} · {node.id}
          </div>
        </div>
      </div>

      {kind === "agent" && (
        <>
          <Labeled label="Provider">
            <select
              value={str("provider") || "anthropic"}
              onChange={(e) => onChange({ provider: e.target.value })}
              style={inputStyle}
            >
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {p}
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
                      fontSize: 10.5,
                      cursor: "pointer",
                      border: `1px solid ${active ? ACCENT.agent : "var(--line-2)"}`,
                      color: active ? ACCENT.agent : "var(--ink-2)",
                      background: "var(--card)",
                      padding: "3px 9px",
                      borderRadius: 6,
                    }}
                  >
                    {m.replace("claude-", "")}
                  </button>
                );
              })}
            </div>
          </Labeled>

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

          <div>
            <RowHead
              label="System prompt"
              value={`~${Math.ceil(str("systemPrompt").length / 4)} tok`}
            />
            <textarea
              value={str("systemPrompt")}
              onChange={(e) => onChange({ systemPrompt: e.target.value })}
              rows={5}
              style={textareaStyle}
              placeholder="You are a support triage agent…"
            />
          </div>

          <div>
            <RowHead label="Structured output" value="fields" />
            <SchemaEditor
              schema={obj("outputSchema") as JsonSchemaObject | undefined}
              onChange={(v) => onChange({ outputSchema: v })}
            />
          </div>

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
        </>
      )}

      {kind === "mcpTool" && (
        <>
          <Labeled label="Connection id">
            <input
              value={str("connectionId")}
              onChange={(e) => onChange({ connectionId: e.target.value })}
              style={inputStyle}
              placeholder="github"
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

      {kind === "httpRequest" && (
        <>
          <Labeled label="Method">
            <select
              value={str("method") || "GET"}
              onChange={(e) => onChange({ method: e.target.value })}
              style={inputStyle}
            >
              {["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </Labeled>
          <Labeled label="URL">
            <input
              value={str("url")}
              onChange={(e) => onChange({ url: e.target.value })}
              style={inputStyle}
              placeholder="https://api.example.com/v1/things"
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
            label="Query params (JSON)"
            value={obj("query")}
            placeholder={'{\n  "q": "open"\n}'}
            onChange={(v) => onChange({ query: v })}
          />
          <JsonField
            label="Headers (JSON, non-secret)"
            value={obj("headers")}
            placeholder={'{\n  "Accept": "application/json"\n}'}
            onChange={(v) => onChange({ headers: v })}
          />
          <JsonField
            label="Body (JSON)"
            value={obj("body")}
            placeholder={'{\n  "title": "hello"\n}'}
            onChange={(v) => onChange({ body: v })}
          />

          <Labeled label="Auth connection id (optional)">
            <input
              value={str("connectionId")}
              onChange={(e) => onChange({ connectionId: e.target.value })}
              style={inputStyle}
              placeholder="my-api"
            />
          </Labeled>
          <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: -6 }}>
            Auth is attached server-side from the connection — never put tokens
            in the headers above (they'd be stored in the run history).
          </div>

          <Labeled label="Timeout (ms)">
            <input
              type="number"
              min={1}
              value={num("timeoutMs") ?? ""}
              onChange={(e) =>
                onChange({
                  timeoutMs: e.target.value
                    ? Number(e.target.value)
                    : undefined,
                })
              }
              style={inputStyle}
              placeholder="30000 (default)"
            />
          </Labeled>

          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 12,
              color: "var(--ink-2)",
            }}
          >
            <input
              type="checkbox"
              checked={Boolean(config.failOnErrorStatus)}
              onChange={(e) =>
                onChange({ failOnErrorStatus: e.target.checked })
              }
            />
            Fail the node on status ≥ 400 (otherwise branch on{" "}
            <code>.status</code>)
          </label>

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

      {kind === "sqlQuery" && (
        <>
          <Labeled label="Database connection id">
            <input
              value={str("connectionId")}
              onChange={(e) => onChange({ connectionId: e.target.value })}
              style={inputStyle}
              placeholder="my-postgres"
            />
          </Labeled>
          <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: -6 }}>
            A <code>postgres</code> or <code>mssql</code> connection. Read-only
            — the query runs in a transaction that's always rolled back.
          </div>

          <div>
            <RowHead label="SQL" value="read-only" />
            <textarea
              value={str("sql")}
              onChange={(e) => onChange({ sql: e.target.value })}
              rows={5}
              style={textareaStyle}
              placeholder={"SELECT id, email FROM users WHERE id = $1"}
            />
          </div>
          <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: -6 }}>
            Placeholders are engine-specific: <code>$1, $2…</code> (Postgres) or{" "}
            <code>@p1, @p2…</code> (MSSQL). Bindings fill the values — never
            build SQL from upstream output.
          </div>

          <BindingsEditor
            bindings={
              obj("paramBindings") as Record<string, BindingRow> | undefined
            }
            upstreamIds={upstreamIds}
            onChange={(v) => onChange({ paramBindings: v })}
          />

          <JsonArrayField
            label="Static params (JSON array)"
            value={config.params as unknown[] | undefined}
            placeholder={"[\n  42\n]"}
            onChange={(v) => onChange({ params: v })}
          />

          <Labeled label="Statement timeout (ms)">
            <input
              type="number"
              min={1}
              value={num("statementTimeoutMs") ?? ""}
              onChange={(e) =>
                onChange({
                  statementTimeoutMs: e.target.value
                    ? Number(e.target.value)
                    : undefined,
                })
              }
              style={inputStyle}
              placeholder="30000 (default)"
            />
          </Labeled>

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

      {kind === "set" && (
        <>
          <div style={{ fontSize: 11, color: "var(--ink-3)" }}>
            Builds a plain object passed downstream. The output <em>is</em> this
            object — bindings fill/override fields from upstream outputs. Read a
            field later as <code>{node.id}.fieldName</code>.
          </div>

          <BindingsEditor
            bindings={
              obj("fieldBindings") as Record<string, BindingRow> | undefined
            }
            upstreamIds={upstreamIds}
            onChange={(v) => onChange({ fieldBindings: v })}
          />

          <JsonField
            label="Static fields (JSON)"
            value={obj("fields")}
            placeholder={'{\n  "status": "reviewed"\n}'}
            onChange={(v) => onChange({ fields: v })}
          />
        </>
      )}

      {kind === "renameKeys" && (
        <>
          <Labeled label="Source node id">
            <input
              value={str("from")}
              onChange={(e) => onChange({ from: e.target.value })}
              style={inputStyle}
              placeholder="upstream-node-id"
            />
          </Labeled>
          <Labeled label="Source path (optional)">
            <input
              value={str("path")}
              onChange={(e) => onChange({ path: e.target.value })}
              style={inputStyle}
              placeholder="output"
            />
          </Labeled>
          <JsonField
            label="Rename (JSON: oldKey → newKey)"
            value={obj("rename")}
            placeholder={'{\n  "user_id": "userId"\n}'}
            onChange={(v) => onChange({ rename: v })}
          />
          <JsonArrayField
            label="Drop keys (JSON array)"
            value={config.drop as unknown[] | undefined}
            placeholder={'[\n  "internal"\n]'}
            onChange={(v) => onChange({ drop: v })}
          />
        </>
      )}

      {kind === "filter" && (
        <>
          <Labeled label="Array source node id">
            <input
              value={str("from")}
              onChange={(e) => onChange({ from: e.target.value })}
              style={inputStyle}
              placeholder="upstream-node-id"
            />
          </Labeled>
          <Labeled label="Array path (optional)">
            <input
              value={str("path")}
              onChange={(e) => onChange({ path: e.target.value })}
              style={inputStyle}
              placeholder="rows"
            />
          </Labeled>
          <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: -6 }}>
            Keeps array items matching the predicate below (paths are relative
            to each item). Output is the filtered array.
          </div>
          <ConditionEditor
            condition={
              config.condition as
                { path?: string; op?: string; value?: unknown } | undefined
            }
            onChange={(c) => onChange({ condition: c })}
          />
        </>
      )}

      {kind === "aggregate" && (
        <>
          <Labeled label="Array source node id">
            <input
              value={str("from")}
              onChange={(e) => onChange({ from: e.target.value })}
              style={inputStyle}
              placeholder="upstream-node-id"
            />
          </Labeled>
          <Labeled label="Array path (optional)">
            <input
              value={str("path")}
              onChange={(e) => onChange({ path: e.target.value })}
              style={inputStyle}
              placeholder="rows"
            />
          </Labeled>
          <Labeled label="Operation">
            <select
              value={str("operation") || "collect"}
              onChange={(e) => onChange({ operation: e.target.value })}
              style={inputStyle}
            >
              {[
                "collect",
                "count",
                "sum",
                "min",
                "max",
                "avg",
                "first",
                "last",
              ].map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </Labeled>
          <Labeled label="Field (item path, optional)">
            <input
              value={str("field")}
              onChange={(e) => onChange({ field: e.target.value })}
              style={inputStyle}
              placeholder="email"
            />
          </Labeled>
          <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: -6 }}>
            Collapses the array into <code>{node.id}.result</code>. For
            collect/sum, pick a field from each item.
          </div>
        </>
      )}

      {kind === "listOps" && (
        <>
          <Labeled label="Array source node id">
            <input
              value={str("from")}
              onChange={(e) => onChange({ from: e.target.value })}
              style={inputStyle}
              placeholder="upstream-node-id"
            />
          </Labeled>
          <Labeled label="Array path (optional)">
            <input
              value={str("path")}
              onChange={(e) => onChange({ path: e.target.value })}
              style={inputStyle}
              placeholder="rows"
            />
          </Labeled>
          <Labeled label="Operation">
            <select
              value={str("operation") || "sort"}
              onChange={(e) => onChange({ operation: e.target.value })}
              style={inputStyle}
            >
              {["sort", "limit", "dedupe"].map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </Labeled>
          <Labeled label="Field (item path — sort/dedupe)">
            <input
              value={str("field")}
              onChange={(e) => onChange({ field: e.target.value })}
              style={inputStyle}
              placeholder="createdAt"
            />
          </Labeled>
          <Labeled label="Order (sort)">
            <select
              value={str("order") || "asc"}
              onChange={(e) => onChange({ order: e.target.value })}
              style={inputStyle}
            >
              <option value="asc">asc</option>
              <option value="desc">desc</option>
            </select>
          </Labeled>
          <Labeled label="Count (limit)">
            <input
              type="number"
              min={1}
              value={num("count") ?? ""}
              onChange={(e) =>
                onChange({
                  count: e.target.value ? Number(e.target.value) : undefined,
                })
              }
              style={inputStyle}
              placeholder="10"
            />
          </Labeled>
          <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: -6 }}>
            Outputs the resulting array. sort/dedupe use the field (whole item
            if blank); limit takes the first N.
          </div>
        </>
      )}

      {kind === "dateTime" && (
        <>
          <Labeled label="Source node id (blank = current time)">
            <input
              value={
                typeof config.source === "object" && config.source
                  ? ((config.source as { from?: string }).from ?? "")
                  : ""
              }
              onChange={(e) =>
                onChange({
                  source: e.target.value ? { from: e.target.value } : undefined,
                })
              }
              style={inputStyle}
              placeholder="(now)"
            />
          </Labeled>
          <div style={{ fontSize: 11, color: "var(--ink-3)" }}>
            Blank = the current time (read server-side). Otherwise bind an
            upstream epoch-ms or ISO value to do timestamp math on. Output is{" "}
            <code>{node.id}.iso</code> / <code>{node.id}.epochMs</code>.
          </div>
          <Labeled label="Add seconds (may be negative)">
            <input
              type="number"
              value={num("addSeconds") ?? ""}
              onChange={(e) =>
                onChange({
                  addSeconds: e.target.value
                    ? Number(e.target.value)
                    : undefined,
                })
              }
              style={inputStyle}
              placeholder="0"
            />
          </Labeled>
        </>
      )}

      {kind === "merge" && (
        <>
          <Labeled label="Combine mode">
            <select
              value={str("mode") || "array"}
              onChange={(e) => onChange({ mode: e.target.value })}
              style={inputStyle}
            >
              <option value="array">Array — [input1, input2, …]</option>
              <option value="object">Object — merge fields together</option>
            </select>
          </Labeled>
          <div style={{ fontSize: 11, color: "var(--ink-3)" }}>
            Joins parallel branches: runs once, after <em>all</em> inbound
            branches arrive, and combines their outputs into{" "}
            <code>{node.id}</code>. Inbound edges must be unconditional (no
            branch conditions into a merge).
          </div>
        </>
      )}

      {kind === "hmac" && (
        <>
          <Labeled label="Signing connection id">
            <input
              value={str("connectionId")}
              onChange={(e) => onChange({ connectionId: e.target.value })}
              style={inputStyle}
              placeholder="my-signing-key"
            />
          </Labeled>
          <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: -6 }}>
            A <code>signing</code> connection — its key is read server-side,
            never stored in the graph. Output is <code>{node.id}.digest</code>.
          </div>
          <Labeled label="Algorithm">
            <select
              value={str("algorithm") || "sha256"}
              onChange={(e) => onChange({ algorithm: e.target.value })}
              style={inputStyle}
            >
              <option value="sha256">sha256</option>
              <option value="sha1">sha1</option>
            </select>
          </Labeled>
          <Labeled label="Encoding">
            <select
              value={str("encoding") || "hex"}
              onChange={(e) => onChange({ encoding: e.target.value })}
              style={inputStyle}
            >
              <option value="hex">hex</option>
              <option value="base64">base64</option>
            </select>
          </Labeled>
          <BindingsEditor
            bindings={
              config.payloadBinding
                ? { payload: config.payloadBinding as BindingRow }
                : undefined
            }
            upstreamIds={upstreamIds}
            onChange={(v) =>
              onChange({ payloadBinding: v ? Object.values(v)[0] : undefined })
            }
          />
          <JsonField
            label="Static payload (JSON, optional)"
            value={obj("payload")}
            placeholder={'{\n  "amount": 100\n}'}
            onChange={(v) => onChange({ payload: v })}
          />
        </>
      )}

      {kind === "jwt" && (
        <>
          <Labeled label="Signing connection id">
            <input
              value={str("connectionId")}
              onChange={(e) => onChange({ connectionId: e.target.value })}
              style={inputStyle}
              placeholder="my-signing-key"
            />
          </Labeled>
          <Labeled label="Algorithm">
            <select
              value={str("algorithm") || "HS256"}
              onChange={(e) => onChange({ algorithm: e.target.value })}
              style={inputStyle}
            >
              <option value="HS256">HS256 (shared secret)</option>
              <option value="RS256">RS256 (RSA private key)</option>
            </select>
          </Labeled>
          <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: -6 }}>
            Signed by a <code>signing</code> connection's key (read server-side)
            — a shared secret for HS256, or a PEM PKCS#8 RSA private key for
            RS256. Output is <code>{node.id}.token</code>.
          </div>
          <BindingsEditor
            bindings={
              obj("claimsBindings") as Record<string, BindingRow> | undefined
            }
            upstreamIds={upstreamIds}
            onChange={(v) => onChange({ claimsBindings: v })}
          />
          <JsonField
            label="Static claims (JSON)"
            value={obj("claims")}
            placeholder={'{\n  "sub": "user-1"\n}'}
            onChange={(v) => onChange({ claims: v })}
          />
          <Labeled label="Expires in (seconds, optional)">
            <input
              type="number"
              min={1}
              value={num("expiresInSeconds") ?? ""}
              onChange={(e) =>
                onChange({
                  expiresInSeconds: e.target.value
                    ? Number(e.target.value)
                    : undefined,
                })
              }
              style={inputStyle}
              placeholder="3600"
            />
          </Labeled>
        </>
      )}

      {kind === "totp" && (
        <>
          <Labeled label="Signing connection id (base32 seed)">
            <input
              value={str("connectionId")}
              onChange={(e) => onChange({ connectionId: e.target.value })}
              style={inputStyle}
              placeholder="my-totp-seed"
            />
          </Labeled>
          <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: -6 }}>
            A <code>signing</code> connection whose secret is the base32 TOTP
            seed (read server-side). Output is <code>{node.id}.code</code>.
          </div>
          <Labeled label="Digits">
            <input
              type="number"
              min={6}
              max={8}
              value={num("digits") ?? ""}
              onChange={(e) =>
                onChange({
                  digits: e.target.value ? Number(e.target.value) : undefined,
                })
              }
              style={inputStyle}
              placeholder="6"
            />
          </Labeled>
          <Labeled label="Period (seconds)">
            <input
              type="number"
              min={1}
              value={num("period") ?? ""}
              onChange={(e) =>
                onChange({
                  period: e.target.value ? Number(e.target.value) : undefined,
                })
              }
              style={inputStyle}
              placeholder="30"
            />
          </Labeled>
        </>
      )}

      {kind === "sendEmail" && (
        <>
          <Labeled label="SMTP connection id">
            <input
              value={str("connectionId")}
              onChange={(e) => onChange({ connectionId: e.target.value })}
              style={inputStyle}
              placeholder="my-smtp"
            />
          </Labeled>
          <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: -6 }}>
            An <code>smtp</code> connection — its URI (with credentials) is read
            server-side, never stored in the graph. Output is{" "}
            <code>{node.id}.messageId</code>.
          </div>
          <Labeled label="From (blank = SMTP user)">
            <input
              value={str("from")}
              onChange={(e) => onChange({ from: e.target.value })}
              style={inputStyle}
              placeholder="noreply@example.com"
            />
          </Labeled>
          <Labeled label="To">
            <input
              value={str("to")}
              onChange={(e) => onChange({ to: e.target.value })}
              style={inputStyle}
              placeholder="user@example.com"
            />
          </Labeled>
          <Labeled label="Subject">
            <input
              value={str("subject")}
              onChange={(e) => onChange({ subject: e.target.value })}
              style={inputStyle}
              placeholder="Your workflow finished"
            />
          </Labeled>
          <Labeled label="Body (text)">
            <textarea
              value={str("text")}
              onChange={(e) => onChange({ text: e.target.value })}
              rows={4}
              style={textareaStyle}
              placeholder="Plain-text body…"
            />
          </Labeled>
          <BindingsEditor
            bindings={
              obj("fieldBindings") as Record<string, BindingRow> | undefined
            }
            upstreamIds={upstreamIds}
            onChange={(v) => onChange({ fieldBindings: v })}
          />
          <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: -6 }}>
            Bind <code>to</code> / <code>subject</code> / <code>text</code> /{" "}
            <code>html</code> from upstream outputs to override the static
            values.
          </div>
        </>
      )}

      {kind === "rssRead" && (
        <>
          <Labeled label="Feed URL (https)">
            <input
              value={str("url")}
              onChange={(e) => onChange({ url: e.target.value })}
              style={inputStyle}
              placeholder="https://example.com/feed.xml"
            />
          </Labeled>
          <BindingsEditor
            bindings={
              config.urlBinding
                ? { url: config.urlBinding as BindingRow }
                : undefined
            }
            upstreamIds={upstreamIds}
            onChange={(v) =>
              onChange({ urlBinding: v ? Object.values(v)[0] : undefined })
            }
          />
          <div style={{ fontSize: 11, color: "var(--ink-3)" }}>
            Fetches + parses the RSS/Atom feed (egress-guarded). Output is{" "}
            <code>{node.id}.items</code> — an array you can
            filter/sort/aggregate.
          </div>
        </>
      )}

      {kind === "executeSubWorkflow" && (
        <>
          <Labeled label="Sub-workflow key">
            <input
              value={str("workflowKey")}
              onChange={(e) => onChange({ workflowKey: e.target.value })}
              style={inputStyle}
              placeholder="my-saved-workflow"
            />
          </Labeled>
          <div style={{ fontSize: 11, color: "var(--ink-3)" }}>
            Runs that saved graph's latest version as a child run (its own row
            in Runs). Read the result later as <code>{node.id}.status</code> /{" "}
            <code>{node.id}.output.*</code>. Nesting is capped to prevent
            recursion.
          </div>

          <BindingsEditor
            bindings={
              obj("inputBindings") as Record<string, BindingRow> | undefined
            }
            upstreamIds={upstreamIds}
            onChange={(v) => onChange({ inputBindings: v })}
          />

          <JsonField
            label="Static input (JSON)"
            value={obj("input")}
            placeholder={'{\n  "message": "hello"\n}'}
            onChange={(v) => onChange({ input: v })}
          />
          <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: -6 }}>
            Leave input empty to forward this run's trigger input to the child.
          </div>
        </>
      )}

      {kind === "forEach" && (
        <>
          <Labeled label="Sub-workflow key (run per item)">
            <input
              value={str("workflowKey")}
              onChange={(e) => onChange({ workflowKey: e.target.value })}
              style={inputStyle}
              placeholder="process-one-item"
            />
          </Labeled>
          <Labeled label="Array source node id">
            <input
              value={str("from")}
              onChange={(e) => onChange({ from: e.target.value })}
              style={inputStyle}
              placeholder="upstream-node-id"
            />
          </Labeled>
          <Labeled label="Array path (optional)">
            <input
              value={str("path")}
              onChange={(e) => onChange({ path: e.target.value })}
              style={inputStyle}
              placeholder="rows"
            />
          </Labeled>
          <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: -6 }}>
            Runs that saved workflow once per array item (item = the child's
            input), concurrently. Output is an array of{" "}
            <code>{node.id}.N.status</code> / <code>.output</code>, one per
            item. Capped at 100 items — filter first if larger.
          </div>
        </>
      )}

      {kind === "wait" && (
        <>
          <Labeled label="Wait (seconds)">
            <input
              type="number"
              min={0}
              value={num("durationSeconds") ?? ""}
              onChange={(e) =>
                onChange({
                  durationSeconds: e.target.value
                    ? Number(e.target.value)
                    : undefined,
                })
              }
              style={inputStyle}
              placeholder="0"
            />
          </Labeled>
          <div style={{ fontSize: 11, color: "var(--ink-3)" }}>
            Pauses the run with a durable timer — it survives restarts and costs
            nothing while waiting.
          </div>
        </>
      )}

      {kind === "stopAndError" && (
        <>
          <Labeled label="Error message">
            <input
              value={str("message")}
              onChange={(e) => onChange({ message: e.target.value })}
              style={inputStyle}
              placeholder="Stopped: unexpected input"
            />
          </Labeled>
          <div style={{ fontSize: 11, color: "var(--ink-3)" }}>
            Ends the run as <strong>failed</strong> with this message. Nothing
            downstream runs.
          </div>
        </>
      )}

      {kind === "respondToWebhook" && (
        <>
          <Labeled label="Status code">
            <input
              type="number"
              min={100}
              max={599}
              value={num("statusCode") ?? ""}
              onChange={(e) =>
                onChange({
                  statusCode: e.target.value
                    ? Number(e.target.value)
                    : undefined,
                })
              }
              style={inputStyle}
              placeholder="200"
            />
          </Labeled>
          <JsonField
            label="Response body (JSON)"
            value={config.body as Record<string, unknown> | undefined}
            placeholder={'{\n  "ok": true\n}'}
            onChange={(v) => onChange({ body: v })}
          />
          <BindingsEditor
            bindings={
              config.bodyBinding
                ? { body: config.bodyBinding as BindingRow }
                : undefined
            }
            upstreamIds={upstreamIds}
            onChange={(v) =>
              onChange({ bodyBinding: v ? Object.values(v)[0] : undefined })
            }
          />
          <div style={{ fontSize: 11, color: "var(--ink-3)" }}>
            For webhook-triggered graphs: returns this response to the caller
            synchronously, then the run continues. Bind <code>body</code> from
            an upstream output to override the static JSON.
          </div>
        </>
      )}

      {kind === "code" && (
        <>
          <div>
            <RowHead label="JavaScript" value="sandboxed" />
            <textarea
              value={str("code")}
              onChange={(e) => onChange({ code: e.target.value })}
              rows={8}
              spellCheck={false}
              className="mono"
              style={{ ...textareaStyle, fontFamily: "monospace" }}
              placeholder={
                "// $input = trigger input, $ctx = upstream outputs\nreturn { total: $input.a + $input.b };"
              }
            />
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Labeled label="Timeout ms (≤5000)">
              <input
                type="number"
                min={1}
                max={5000}
                value={num("timeoutMs") ?? ""}
                onChange={(e) =>
                  onChange({
                    timeoutMs: e.target.value
                      ? Number(e.target.value)
                      : undefined,
                  })
                }
                style={inputStyle}
                placeholder="2000"
              />
            </Labeled>
            <Labeled label="Memory MB (≤128)">
              <input
                type="number"
                min={1}
                max={128}
                value={num("memoryMb") ?? ""}
                onChange={(e) =>
                  onChange({
                    memoryMb: e.target.value
                      ? Number(e.target.value)
                      : undefined,
                  })
                }
                style={inputStyle}
                placeholder="64"
              />
            </Labeled>
          </div>
          <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: -6 }}>
            Runs in a QuickJS/WASM sandbox — no network, no filesystem, capped
            time + memory. <code>return</code> a value; it becomes{" "}
            <code>{node.id}</code>'s output.
          </div>
        </>
      )}

      {kind === "humanApproval" && (
        <>
          <Labeled label="Approval title">
            <input
              value={str("title")}
              onChange={(e) => onChange({ title: e.target.value })}
              style={inputStyle}
              placeholder="Approve refund?"
            />
          </Labeled>
          <Labeled label="Instructions">
            <textarea
              value={str("instructions")}
              onChange={(e) => onChange({ instructions: e.target.value })}
              rows={3}
              style={textareaStyle}
              placeholder="What the approver should check…"
            />
          </Labeled>
          <Labeled label="Auto-reject after (hours)">
            <input
              type="number"
              min={0}
              step={1}
              value={num("timeoutHours") ?? ""}
              onChange={(e) =>
                onChange({
                  timeoutHours: e.target.value
                    ? Number(e.target.value)
                    : undefined,
                })
              }
              style={inputStyle}
              placeholder="blank = wait forever"
            />
          </Labeled>
        </>
      )}

      {kind === "start" && (
        <JsonField
          label="Sample input (JSON)"
          value={obj("sampleInput")}
          placeholder={'{\n  "message": "I was charged twice"\n}'}
          onChange={(v) => onChange({ sampleInput: v })}
        />
      )}

      {kind === "webhookTrigger" && <WebhookInfo hookUrls={hookUrls} />}

      {kind === "end" && (
        <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
          The terminal node — no configuration.
        </div>
      )}
    </div>
  );
}

/** Read-only webhook binding: the registered endpoint URL(s) for this workflow
 *  (config lives in the registry, not the node). Empty → guidance to register. */
function WebhookInfo({ hookUrls }: { hookUrls: string[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontSize: 12, color: "var(--ink-2)" }}>
        This workflow is webhook-triggered. The inbound event becomes the
        trigger output.
      </div>
      {hookUrls.length > 0 ? (
        <div>
          <RowHead label="Endpoint(s)" value={`${hookUrls.length}`} />
          {hookUrls.map((u) => (
            <div
              key={u}
              className="mono"
              style={{
                fontSize: 11,
                color: "var(--ink)",
                background: "var(--card-2)",
                border: "1px solid var(--line-2)",
                borderRadius: 6,
                padding: "6px 8px",
                marginBottom: 4,
                wordBreak: "break-all",
              }}
            >
              POST {u}
            </div>
          ))}
        </div>
      ) : (
        <div style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
          No endpoint registered yet — add one on the Integrations screen (it'll
          be bound to this workflow's key). Save the workflow first.
        </div>
      )}
    </div>
  );
}

/** Uppercase section label + a right-aligned mono value (design's field heads). */
function RowHead({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: 6,
      }}
    >
      <span style={{ fontSize: 12, color: "var(--ink-2)" }}>{label}</span>
      <span className="mono" style={{ fontSize: 10.5, color: "var(--ink-3)" }}>
        {value}
      </span>
    </div>
  );
}

/** A JSON object field: edits as text, commits the parsed object on valid JSON,
 *  shows an inline error otherwise (last valid value stays in the config). Empty
 *  text clears the field (undefined). */
/** "true"/"false" → boolean, numeric string → number, else the trimmed string.
 *  Mirrors compile-graph's edge-condition coercion so the filter predicate's typed
 *  comparisons (===, >) work. */
function coerceCond(s: string): string | number | boolean {
  if (s === "true") return true;
  if (s === "false") return false;
  if (s !== "" && !Number.isNaN(Number(s))) return Number(s);
  return s;
}

/** Editor for a structured predicate (path/op/value) stored as a DSL EdgeCondition
 *  on the filter node's config. Coerces the value on change (like the edge editor). */
function ConditionEditor({
  condition,
  onChange,
}: {
  condition?: { path?: string; op?: string; value?: unknown };
  onChange: (c: { path: string; op: string; value?: unknown }) => void;
}) {
  const path = condition?.path ?? "";
  const op = (condition?.op as EdgeConditionDraft["op"]) ?? "eq";
  const valStr = Array.isArray(condition?.value)
    ? (condition?.value as unknown[]).join(", ")
    : condition?.value === undefined || condition?.value === null
      ? ""
      : String(condition?.value);

  function build(nextPath: string, nextOp: string, nextVal: string): void {
    const c: { path: string; op: string; value?: unknown } = {
      path: nextPath,
      op: nextOp,
    };
    if (nextOp === "in") {
      c.value = nextVal
        .split(",")
        .map((s) => coerceCond(s.trim()))
        .filter((v) => v !== "");
    } else if (nextOp !== "exists") {
      c.value = coerceCond(nextVal);
    }
    onChange(c);
  }

  return (
    <>
      <Labeled label="Item path">
        <input
          value={path}
          onChange={(e) => build(e.target.value, op, valStr)}
          style={inputStyle}
          placeholder="active"
        />
      </Labeled>
      <Labeled label="Operator">
        <select
          value={op}
          onChange={(e) => build(path, e.target.value, valStr)}
          style={inputStyle}
        >
          {CONDITION_OPS.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </Labeled>
      {op !== "exists" && (
        <Labeled label={op === "in" ? "Values (comma-separated)" : "Value"}>
          <input
            value={valStr}
            onChange={(e) => build(path, op, e.target.value)}
            style={inputStyle}
            placeholder={op === "in" ? "active, pending" : "true"}
          />
        </Labeled>
      )}
    </>
  );
}

function JsonField({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: Record<string, unknown> | undefined;
  placeholder?: string;
  onChange: (v: Record<string, unknown> | undefined) => void;
}) {
  const [text, setText] = useState(value ? JSON.stringify(value, null, 2) : "");
  const [error, setError] = useState<string | null>(null);

  function commit(next: string) {
    setText(next);
    const trimmed = next.trim();
    if (!trimmed) {
      setError(null);
      onChange(undefined);
      return;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        setError("Must be a JSON object");
        return;
      }
      setError(null);
      onChange(parsed as Record<string, unknown>);
    } catch {
      setError("Invalid JSON");
    }
  }

  return (
    <div>
      <RowHead label={label} value={error ? "⚠ error" : "JSON"} />
      <textarea
        value={text}
        onChange={(e) => commit(e.target.value)}
        rows={5}
        spellCheck={false}
        className="mono"
        style={{
          ...textareaStyle,
          fontFamily: "var(--font-mono)",
          fontSize: 11.5,
          borderColor: error ? "var(--state-error)" : "var(--line-2)",
        }}
        placeholder={placeholder}
      />
      {error && (
        <div
          style={{ fontSize: 11, color: "var(--state-error)", marginTop: 4 }}
        >
          {error}
        </div>
      )}
    </div>
  );
}

/** Like JsonField, but the value must be a JSON ARRAY (the sqlQuery params list). */
function JsonArrayField({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: unknown[] | undefined;
  placeholder?: string;
  onChange: (v: unknown[] | undefined) => void;
}) {
  const [text, setText] = useState(value ? JSON.stringify(value, null, 2) : "");
  const [error, setError] = useState<string | null>(null);

  function commit(next: string) {
    setText(next);
    const trimmed = next.trim();
    if (!trimmed) {
      setError(null);
      onChange(undefined);
      return;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) {
        setError("Must be a JSON array");
        return;
      }
      setError(null);
      onChange(parsed as unknown[]);
    } catch {
      setError("Invalid JSON");
    }
  }

  return (
    <div>
      <RowHead label={label} value={error ? "⚠ error" : "JSON"} />
      <textarea
        value={text}
        onChange={(e) => commit(e.target.value)}
        rows={3}
        spellCheck={false}
        className="mono"
        style={{
          ...textareaStyle,
          fontFamily: "var(--font-mono)",
          fontSize: 11.5,
          borderColor: error ? "var(--state-error)" : "var(--line-2)",
        }}
        placeholder={placeholder}
      />
      {error && (
        <div
          style={{ fontSize: 11, color: "var(--state-error)", marginTop: 4 }}
        >
          {error}
        </div>
      )}
    </div>
  );
}

/** Editor for mcpTool argumentBindings: argName → { from: nodeId, path? }. This is
 *  how data threads between nodes (an arg bound to an upstream node's output). */
function BindingsEditor({
  bindings,
  upstreamIds,
  onChange,
}: {
  bindings: Record<string, BindingRow> | undefined;
  upstreamIds: string[];
  onChange: (v: Record<string, BindingRow> | undefined) => void;
}) {
  const entries = Object.entries(bindings ?? {});

  function setEntry(oldName: string, name: string, row: BindingRow): void {
    const next: Record<string, BindingRow> = {};
    for (const [k, v] of entries) {
      if (k === oldName) continue;
      next[k] = v;
    }
    if (name.trim()) next[name.trim()] = row;
    onChange(Object.keys(next).length ? next : undefined);
  }
  function remove(name: string): void {
    const next = Object.fromEntries(entries.filter(([k]) => k !== name));
    onChange(Object.keys(next).length ? next : undefined);
  }
  function add(): void {
    const next = { ...(bindings ?? {}), "": { from: upstreamIds[0] ?? "" } };
    onChange(next);
  }

  return (
    <div>
      <RowHead label="Argument bindings" value={`${entries.length} bound`} />
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {entries.map(([name, row], i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional, names are editable/duplicable
            key={i}
            style={{
              border: "1px solid var(--line)",
              borderRadius: 8,
              padding: 8,
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            <div style={{ display: "flex", gap: 6 }}>
              <input
                value={name}
                onChange={(e) => setEntry(name, e.target.value, row)}
                style={{ ...inputStyle, flex: 1 }}
                placeholder="arg name"
              />
              <button
                type="button"
                aria-label="Remove binding"
                onClick={() => remove(name)}
                style={{
                  border: "1px solid var(--line-2)",
                  background: "var(--card)",
                  color: "var(--ink-3)",
                  borderRadius: 6,
                  cursor: "pointer",
                  padding: "0 9px",
                }}
              >
                ✕
              </button>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <select
                value={row.from}
                onChange={(e) =>
                  setEntry(name, name, { ...row, from: e.target.value })
                }
                style={{ ...inputStyle, flex: 1 }}
              >
                {upstreamIds.length === 0 && (
                  <option value="">(no nodes)</option>
                )}
                {upstreamIds.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
              <input
                value={row.path ?? ""}
                onChange={(e) =>
                  setEntry(name, name, {
                    ...row,
                    path: e.target.value || undefined,
                  })
                }
                style={{ ...inputStyle, flex: 1 }}
                placeholder="path (e.g. output.category)"
              />
            </div>
          </div>
        ))}
        <button
          type="button"
          onClick={add}
          style={{
            border: "1px dashed var(--line-2)",
            background: "transparent",
            color: "var(--ink-2)",
            borderRadius: 8,
            padding: 8,
            fontSize: 11.5,
            cursor: "pointer",
          }}
        >
          + Add binding
        </button>
      </div>
    </div>
  );
}

/** Edit the selected edge's branch condition. A blank path = unconditional edge
 *  (the edge always fires); `exists` needs no value. Compiled by compile-graph. */
function EdgeConfigPanel({
  condition,
  onChange,
  onClear,
}: {
  condition?: EdgeConditionDraft;
  onChange: (patch: Partial<EdgeConditionDraft>) => void;
  onClear: () => void;
}) {
  const c = condition ?? { path: "", op: "eq" as const, value: "" };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div>
        <div style={{ fontSize: 11, color: "var(--ink-3)" }}>EDGE</div>
        <div style={{ fontWeight: 600 }}>Branch condition</div>
        <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>
          Blank path = always fires. The edge is taken when the predicate holds.
        </div>
      </div>

      <Labeled label="Path (in ctx, e.g. agent.urgency)">
        <input
          value={c.path}
          onChange={(e) => onChange({ path: e.target.value })}
          style={inputStyle}
          placeholder="agent.category"
        />
      </Labeled>

      <Labeled label="Operator">
        <select
          value={c.op}
          onChange={(e) =>
            onChange({ op: e.target.value as EdgeConditionDraft["op"] })
          }
          style={inputStyle}
        >
          {CONDITION_OPS.map((op) => (
            <option key={op} value={op}>
              {op}
            </option>
          ))}
        </select>
      </Labeled>

      {c.op !== "exists" && (
        <Labeled label={c.op === "in" ? "Values (comma-separated)" : "Value"}>
          <input
            value={c.value}
            onChange={(e) => onChange({ value: e.target.value })}
            style={inputStyle}
            placeholder={c.op === "in" ? "billing, refunds" : "billing"}
          />
        </Labeled>
      )}

      {condition?.path?.trim() && (
        <button
          type="button"
          onClick={onClear}
          style={{
            alignSelf: "flex-start",
            padding: "6px 10px",
            borderRadius: 7,
            border: "1px solid var(--line-2)",
            background: "var(--card)",
            color: "var(--ink-2)",
            cursor: "pointer",
            fontSize: 12,
          }}
        >
          Clear condition (make unconditional)
        </button>
      )}
    </div>
  );
}

function Labeled({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "block", fontSize: 12 }}>
      <span style={{ color: "var(--ink-2)" }}>{label}</span>
      <div style={{ marginTop: 4 }}>{children}</div>
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "7px 9px",
  borderRadius: 7,
  border: "1px solid var(--line-2)",
  background: "var(--card)",
  color: "var(--ink)",
  fontSize: 13,
};
const textareaStyle: React.CSSProperties = {
  ...inputStyle,
  resize: "vertical",
  fontFamily: "var(--font-sans)",
};
const headerInputStyle: React.CSSProperties = {
  padding: "6px 9px",
  borderRadius: 7,
  border: "1px solid var(--line-2)",
  background: "var(--card)",
  color: "var(--ink)",
  fontSize: 13,
};
