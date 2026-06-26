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
import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { NodeType } from "@naary/dsl";
import { Button } from "../components";
import { api, UnauthorizedError } from "../lib/api";
import { compileGraph } from "../lib/compile-graph";
import { type CanvasNode, NODE_KINDS } from "../lib/graph-model";

const WORKFLOW_KEY = "canvas";

/** DSL node type → theme accent color (the design palette). */
const ACCENT: Record<NodeType, string> = {
  start: "var(--node-trigger)",
  webhookTrigger: "var(--node-trigger)",
  agent: "var(--node-agent)",
  mcpTool: "var(--node-mcp)",
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
      <div style={{ padding: "9px 12px", fontWeight: 600 }}>{LABEL[kind]}</div>
      {kind !== "end" && <Handle type="source" position={Position.Right} />}
    </div>
  );
}

const nodeTypes = { naary: NaaryNode };

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
const SEED_EDGES: Edge[] = [
  { id: "e1", source: "start", target: "approval" },
  { id: "e2", source: "approval", target: "end" },
];

export function CanvasPage() {
  const navigate = useNavigate();
  const [nodes, setNodes] = useState<Node<NaaryData>[]>(SEED_NODES);
  const [edges, setEdges] = useState<Edge[]>(SEED_EDGES);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const onNodesChange = useCallback(
    (changes: Parameters<typeof applyNodeChanges>[0]) =>
      setNodes((ns) => applyNodeChanges(changes, ns) as Node<NaaryData>[]),
    [],
  );
  const onEdgesChange = useCallback(
    (changes: Parameters<typeof applyEdgeChanges>[0]) =>
      setEdges((es) => applyEdgeChanges(changes, es)),
    [],
  );
  const onConnect = useCallback(
    (c: Connection) => setEdges((es) => addEdge(c, es)),
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
    }));
    return compileGraph(canvasNodes, canvasEdges);
  }, [nodes, edges]);

  const selected = nodes.find((n) => n.selected);

  function addNode(kind: NodeType) {
    const id = `${kind}-${crypto.randomUUID().slice(0, 8)}`;
    setNodes((ns) => [
      ...ns,
      {
        id,
        type: "naary",
        position: {
          x: 160 + (ns.length % 5) * 40,
          y: 300 + (ns.length % 3) * 30,
        },
        data: { kind },
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

  async function run() {
    if (!graph) {
      setStatus(error ?? "Graph is not runnable.");
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      await api.saveGraph(WORKFLOW_KEY, "Canvas draft", graph);
      const { workflowId } = await api.startExecution(WORKFLOW_KEY);
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
        <strong style={{ fontSize: 15 }}>Workflow canvas</strong>
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
                color: "var(--state-error)",
                alignSelf: "center",
              }}
            >
              {status}
            </span>
          )}
          <Button
            variant="primary"
            disabled={busy || !graph}
            onClick={() => void run()}
          >
            {busy ? "Running…" : "Run"}
          </Button>
        </div>
      </header>

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
          {NODE_KINDS.map((k) => (
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

        {/* config panel */}
        <aside
          style={{
            width: 248,
            padding: 16,
            borderLeft: "1px solid var(--line)",
            background: "var(--surface)",
            overflowY: "auto",
          }}
        >
          {selected ? (
            <ConfigPanel
              key={selected.id}
              node={selected}
              onChange={(patch) => updateConfig(selected.id, patch)}
            />
          ) : (
            <div style={{ fontSize: 13, color: "var(--ink-3)" }}>
              Select a node to edit its configuration.
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

/** Per-type config editor for the selected node. Only the types with meaningful
 *  config (agent, mcpTool) expose fields; others are structural. */
function ConfigPanel({
  node,
  onChange,
}: {
  node: Node<NaaryData>;
  onChange: (patch: Record<string, unknown>) => void;
}) {
  const kind = node.data.kind;
  const config = node.data.config ?? {};
  const str = (k: string) => (config[k] as string | undefined) ?? "";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div>
        <div style={{ fontSize: 11, color: "var(--ink-3)" }}>NODE</div>
        <div style={{ fontWeight: 600 }}>{LABEL[kind]}</div>
        <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>
          id: {node.id}
        </div>
      </div>

      {kind === "agent" && (
        <Labeled label="System prompt">
          <textarea
            value={str("systemPrompt")}
            onChange={(e) => onChange({ systemPrompt: e.target.value })}
            rows={5}
            style={textareaStyle}
            placeholder="You are a support triage agent…"
          />
        </Labeled>
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
        </>
      )}

      {kind !== "agent" && kind !== "mcpTool" && (
        <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
          This node has no configuration.
        </div>
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
