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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  lintBindings,
  lintTemplates,
  getIntegrationProvider,
  validateIntegrationConfig,
  type NodeType,
} from "@naary/dsl";
import { Button } from "../components";
import {
  api,
  type ConnectionRow,
  type GraphSummary,
  type TestNodeResult,
  UnauthorizedError,
  type WebhookRow,
} from "../lib/api";
import { compileGraph } from "../lib/compile-graph";
import { decompileGraph } from "../lib/decompile-graph";
import type { JsonSchemaObject } from "../lib/schema-fields";
import { SchemaEditor } from "./canvas/SchemaFieldEditor";
import {
  ACCENT,
  type CanvasEdge,
  type CanvasNode,
  CONDITION_OPS,
  defaultConfigFor,
  type EdgeConditionDraft,
  NODE_DESCRIPTION,
  VALUELESS_OPS,
  NODE_GROUPS,
  NODE_KINDS,
  nodeDisplayLabel,
  nodeSubtitle,
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

interface NaaryData extends Record<string, unknown> {
  kind: NodeType;
  config?: Record<string, unknown>;
  /** Injected for rendering: this node has a pinned authoring sample (📌 badge). */
  pinned?: boolean;
  /** Injected for rendering: this node has lint issues (⚠ badge); text is the tooltip. */
  warning?: string;
}

/** A node on the canvas: accent bar, label, and connection handles. Entry nodes
 *  have no inbound handle; `end` has no outbound. */
function NaaryNode({ data, selected }: NodeProps<Node<NaaryData>>) {
  const kind = data.kind;
  const accent = ACCENT[kind];
  // Keep in sync with compile-graph's ENTRY_TYPES — every entry node has no inbound handle.
  const isEntry =
    kind === "start" ||
    kind === "webhookTrigger" ||
    kind === "scheduleTrigger" ||
    kind === "pollTrigger" ||
    kind === "errorTrigger" ||
    kind === "formTrigger" ||
    kind === "chatTrigger";
  const subtitle = nodeSubtitle(kind, data.config);
  // Provider-aware: an integration node reads "GitHub"/"Jira"/…, not the shared type
  // label "integration" (which collapses to the last-registered tile). See nodeDisplayLabel.
  const title = nodeDisplayLabel(kind, data.config);
  return (
    <div
      style={{
        minWidth: 132,
        borderRadius: "var(--radius-md)",
        border: data.warning
          ? "1px solid var(--state-paused)"
          : `1px solid ${accent}`,
        outline: selected
          ? `2px solid ${data.warning ? "var(--state-paused)" : accent}`
          : "none",
        background: "var(--card)",
        color: "var(--ink)",
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-body)",
        overflow: "hidden",
        boxShadow: "var(--shadow-node)",
      }}
    >
      {!isEntry && <Handle type="target" position={Position.Left} />}
      <div style={{ height: 4, background: accent }} />
      <div
        style={{
          padding: subtitle ? "9px 12px 4px" : "9px 12px",
          fontWeight: "var(--weight-semibold)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 6,
        }}
      >
        <span>{title}</span>
        <span style={{ display: "flex", gap: 4 }}>
          {data.warning && (
            <span title={data.warning} style={{ fontSize: "var(--text-xs)" }}>
              ⚠️
            </span>
          )}
          {data.pinned && (
            <span
              title="Has a pinned sample output"
              style={{ fontSize: "var(--text-xs)" }}
            >
              📌
            </span>
          )}
        </span>
      </div>
      {subtitle && (
        <div
          className="mono"
          style={{
            padding: "0 12px 9px",
            fontSize: "var(--text-2xs)",
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
  // Drag-resizable side panels (palette + node inspector). Widths persist per browser.
  const panelsRowRef = useRef<HTMLDivElement>(null);
  const [paletteWidth, setPaletteWidth] = useState(
    () => Number(localStorage.getItem("naary.paletteW")) || 180,
  );
  const [inspectorWidth, setInspectorWidth] = useState(
    () => Number(localStorage.getItem("naary.inspectorW")) || 440,
  );
  useEffect(() => {
    localStorage.setItem("naary.paletteW", String(paletteWidth));
  }, [paletteWidth]);
  useEffect(() => {
    localStorage.setItem("naary.inspectorW", String(inspectorWidth));
  }, [inspectorWidth]);
  // The saved workflowKey (empty until first save of a NEW workflow → slug(name)).
  const [workflowKey, setWorkflowKey] = useState("");
  const [workflows, setWorkflows] = useState<GraphSummary[]>([]);
  const [webhooks, setWebhooks] = useState<WebhookRow[]>([]);
  // Tenant connections (DBs, MCP servers, SMTP, signing) so a node's config can PICK one
  // by label instead of pasting a raw connectionId.
  const [connections, setConnections] = useState<ConnectionRow[]>([]);
  // Pinned node outputs (authoring samples) for the saved workflow, keyed by nodeId.
  const [pins, setPins] = useState<Record<string, unknown>>({});
  // Optional per-run input (JSON) — overrides the Start node's sampleInput for the
  // next run. Blank ⇒ the server falls back to the sample (api.startExecution).
  const [showInput, setShowInput] = useState(false);
  const [runInput, setRunInput] = useState("");
  // Whether the issues panel (lint warnings + missing resources) is expanded.
  const [showIssues, setShowIssues] = useState(false);
  // AI workflow builder: describe a flow → generate a draft onto the canvas.
  const [showAi, setShowAi] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  // "" = let the server auto-pick the tenant's configured provider.
  const [genProvider, setGenProvider] = useState("");
  const [generating, setGenerating] = useState(false);

  const keyParam = searchParams.get("key");
  const templateParam = searchParams.get("template");

  // Registered webhook endpoints + tenant connections (so a webhookTrigger node can show its
  // hook URL, and connection-based nodes can pick a connection by label).
  useEffect(() => {
    let live = true;
    api
      .getMe()
      .then((me) =>
        Promise.all([
          api.listWebhooks(me.tenantId).catch(() => []),
          api.listConnections(me.tenantId).catch(() => []),
        ]),
      )
      .then(([ws, conns]) => {
        if (!live) return;
        setWebhooks(ws);
        setConnections(conns);
      })
      .catch(() => {
        /* unauthenticated / none — nodes show their register/add hints */
      });
    return () => {
      live = false;
    };
  }, []);

  // Pinned outputs for the saved workflow (authoring samples). Cleared for an unsaved flow.
  useEffect(() => {
    if (!workflowKey) {
      setPins({});
      return;
    }
    let live = true;
    api
      .listPins(workflowKey)
      .then((p) => live && setPins(p))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [workflowKey]);

  const pinNode = useCallback(
    async (nodeId: string, output: unknown) => {
      if (!workflowKey) return;
      await api.pinNode(workflowKey, nodeId, output);
      setPins((p) => ({ ...p, [nodeId]: output }));
    },
    [workflowKey],
  );
  const unpinNode = useCallback(
    async (nodeId: string) => {
      if (!workflowKey) return;
      await api.unpinNode(workflowKey, nodeId);
      setPins((p) => {
        const next = { ...p };
        delete next[nodeId];
        return next;
      });
    },
    [workflowKey],
  );

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

  // Non-blocking lint: references to a node not in the graph — both `{{ nodeId.path }}` string
  // tokens AND structured `{from,path}` bindings (fieldBindings etc.). Each names WHICH source is
  // missing, so a typo'd/deleted binding source is caught at author time, not as an empty run.
  const templateWarnings = useMemo(
    () => (graph ? [...lintTemplates(graph), ...lintBindings(graph)] : []),
    [graph],
  );

  // Non-blocking lint: nodes that reference a resource that doesn't exist yet — the #1 reason a
  // saved workflow fails at RUN time (e.g. a template's placeholder `connectionId: "github"`).
  // Cross-references each node's connection against the tenant's real connections, and runs the
  // catalog-aware config check for integration nodes (missing required fields / bad action).
  const resourceWarnings = useMemo(() => {
    if (!graph) return [] as { nodeId: string; message: string }[];
    const connIds = new Set(connections.map((c) => c.id));
    const out: { nodeId: string; message: string }[] = [];
    for (const node of graph.nodes) {
      const cfg = (node.config ?? {}) as Record<string, unknown>;
      const cid = typeof cfg.connectionId === "string" ? cfg.connectionId : "";
      // A connection is named but isn't one of the tenant's real connections.
      if (cid && !connIds.has(cid)) {
        out.push({
          nodeId: node.id,
          message: `references connection "${cid}" which doesn't exist — create it in Integrations and pick it here`,
        });
      }
      if (node.type === "integration") {
        // Catalog-aware: unknown provider/action, missing required fields, or empty connection.
        const err = validateIntegrationConfig(
          cfg as unknown as Parameters<typeof validateIntegrationConfig>[0],
        );
        if (err) out.push({ nodeId: node.id, message: err });
      } else if (
        !cid &&
        node.type in CONNECTION_TYPES &&
        node.type !== "httpRequest"
      ) {
        // A non-integration node that needs a connection but has none (httpRequest's is optional).
        out.push({
          nodeId: node.id,
          message:
            "needs a connection — create one in Integrations and pick it",
        });
      }
    }
    return out;
  }, [graph, connections]);

  // Every canvas issue as one flat, displayable list: unknown-source references (from the
  // template/binding linter — names the node + field + which source is missing) plus missing
  // resources (unmatched connections / bad integration config). This is what the issues panel
  // renders and what marks the offending nodes.
  const allIssues = useMemo(
    () => [
      ...templateWarnings.map((w) => ({
        nodeId: w.nodeId,
        field: w.field as string | undefined,
        ref: w.ref as string | undefined,
        message: w.message,
        kind: "reference" as const,
      })),
      ...resourceWarnings.map((w) => ({
        nodeId: w.nodeId,
        field: undefined as string | undefined,
        ref: undefined as string | undefined,
        message: w.message,
        kind: "resource" as const,
      })),
    ],
    [templateWarnings, resourceWarnings],
  );

  // node id → its issue lines (for the ⚠ tooltip on the node badge).
  const issuesByNode = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const it of allIssues) {
      const line = it.field ? `${it.field}: ${it.message}` : it.message;
      m.set(it.nodeId, [...(m.get(it.nodeId) ?? []), line]);
    }
    return m;
  }, [allIssues]);

  // Overlay a 📌 badge on nodes with a pinned sample and a ⚠ badge on nodes with issues. Derived
  // (not stored on the node) so it doesn't churn the editable `nodes` state; onNodesChange still
  // applies to `nodes`. Returns the node unchanged when neither overlay differs (no render churn).
  const flowNodes = useMemo(
    () =>
      nodes.map((n) => {
        const pinned = Object.hasOwn(pins, n.id);
        const warning = issuesByNode.get(n.id)?.join("\n");
        if ((n.data.pinned ?? false) === pinned && n.data.warning === warning) {
          return n;
        }
        return { ...n, data: { ...n.data, pinned, warning } };
      }),
    [nodes, pins, issuesByNode],
  );

  const selected = nodes.find((n) => n.selected);

  // Jump to a node from the issues panel: select it (opens its inspector) and clear other selection.
  function selectNode(id: string): void {
    setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === id })));
    setEdges((es) =>
      es.map((e) => (e.selected ? { ...e, selected: false } : e)),
    );
    setShowIssues(true);
  }
  const selectedEdge = edges.find((e) => e.selected);

  // Webhook endpoint URLs registered for THIS workflow (shown in the webhook node).
  // The full, invokable URL: the hooks ingress lives at /hooks/:id on the API, reachable
  // through the same /api proxy the app uses (nginx rewrites /api/hooks/… → /hooks/…).
  const hookUrls = webhooks
    .filter((w) => workflowKey && w.workflowId === workflowKey)
    .map((w) => `${window.location.origin}/api/hooks/${w.id}`);

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

  function addNode(kind: NodeType, preset?: Record<string, unknown>) {
    const id = `${kind}-${crypto.randomUUID().slice(0, 8)}`;
    // Drop in with working example config (single source: the node registry), so a
    // non-technical user sees filled-in fields — and a node they never open still runs.
    // A palette tile may pass its own preset (e.g. GitHub vs Jira, both `integration`).
    const config = preset ? structuredClone(preset) : defaultConfigFor(kind);
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

  // Generate a draft graph from the description and load it onto the canvas as a
  // NEW unsaved draft (same as forking a template — Save persists it). Reuses the
  // decompile → flow-nodes path so the result is fully editable.
  async function generateFromPrompt() {
    const prompt = aiPrompt.trim();
    if (!prompt || generating) return;
    setGenerating(true);
    setStatus("Generating workflow…");
    try {
      const { name: genName, graph: gen } = await api.generateGraph(
        prompt,
        genProvider || undefined,
      );
      const { nodes: cn, edges: ce } = decompileGraph(gen);
      setNodes(toFlowNodes(cn));
      setEdges(toFlowEdges(ce));
      setName(genName);
      setWorkflowKey("");
      if (keyParam || templateParam) setSearchParams({}, { replace: true });
      setStatus("Generated — review, edit, and Save to keep it.");
      setShowAi(false);
    } catch (e) {
      setStatus(
        e instanceof Error ? e.message : "Couldn't generate a workflow.",
      );
    } finally {
      setGenerating(false);
    }
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
        <span style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}>
          key: {activeKey}
        </span>

        <span
          style={{
            fontSize: "var(--text-sm)",
            padding: "3px 10px",
            borderRadius: "var(--radius-full)",
            background: graph ? "var(--state-done)" : "var(--state-error)",
            color: "#fff",
          }}
        >
          {graph ? "valid" : (error ?? "invalid")}
        </span>
        {allIssues.length > 0 && (
          <button
            type="button"
            onClick={() => setShowIssues((s) => !s)}
            title="Show details of every issue"
            style={{
              fontSize: "var(--text-sm)",
              padding: "3px 10px",
              border: "none",
              borderRadius: "var(--radius-full)",
              background:
                resourceWarnings.length > 0
                  ? "var(--state-error)"
                  : "var(--state-paused)",
              color: "#fff",
              cursor: "pointer",
            }}
          >
            ⚠ {allIssues.length} issue{allIssues.length > 1 ? "s" : ""}{" "}
            {showIssues ? "▲" : "▼"}
          </button>
        )}
        <div style={{ marginLeft: "auto", display: "flex", gap: 10 }}>
          {status && (
            <span
              style={{
                fontSize: "var(--text-sm)",
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
            onClick={() => setShowAi((s) => !s)}
          >
            {showAi ? "Close AI" : "✨ Build with AI"}
          </Button>
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

      {showIssues && allIssues.length > 0 && (
        <div
          style={{
            padding: "10px 16px",
            borderBottom: "1px solid var(--line)",
            background: "var(--surface)",
            maxHeight: 220,
            overflowY: "auto",
          }}
        >
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginBottom: 8,
            }}
          >
            {allIssues.length} issue{allIssues.length > 1 ? "s" : ""} — click
            one to jump to its node. References point at a source that doesn't
            exist; resources are unmatched connections/config.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {allIssues.map((it, i) => (
              <button
                type="button"
                key={`${it.nodeId}.${it.field ?? ""}.${i}`}
                onClick={() => selectNode(it.nodeId)}
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  flexWrap: "wrap",
                  gap: 6,
                  textAlign: "left",
                  width: "100%",
                  padding: "6px 8px",
                  border: "1px solid var(--line)",
                  borderRadius: "var(--radius-sm)",
                  background: "var(--card)",
                  color: "var(--ink)",
                  fontSize: "var(--text-body)",
                  cursor: "pointer",
                }}
              >
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    flex: "none",
                    alignSelf: "center",
                    background:
                      it.kind === "resource"
                        ? "var(--state-error)"
                        : "var(--state-paused)",
                  }}
                />
                <span
                  className="mono"
                  style={{ fontWeight: "var(--weight-semibold)" }}
                >
                  {it.nodeId}
                </span>
                {it.field && (
                  <span className="mono" style={{ color: "var(--ink-2)" }}>
                    · {it.field}
                  </span>
                )}
                <span style={{ color: "var(--ink-1)" }}>— {it.message}</span>
                {it.ref && (
                  <span className="mono" style={{ color: "var(--ink-3)" }}>
                    ({it.ref})
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {showAi && (
        <div
          style={{
            padding: "12px 16px",
            borderBottom: "1px solid var(--line)",
            background: "var(--surface)",
          }}
        >
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginBottom: 6,
            }}
          >
            Describe the workflow in plain English — an agent drafts it onto the
            canvas for you to edit. (Uses your model provider key from
            Integrations.)
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
            <textarea
              value={aiPrompt}
              onChange={(e) => setAiPrompt(e.target.value)}
              placeholder="e.g. When a webhook comes in, have an agent summarize it, wait for my approval, then email the summary to my team."
              rows={2}
              disabled={generating}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter")
                  void generateFromPrompt();
              }}
              style={{
                flex: 1,
                resize: "vertical",
                padding: "8px 10px",
                borderRadius: "var(--radius-md)",
                border: "1px solid var(--line)",
                background: "var(--card)",
                color: "var(--ink)",
                fontSize: "var(--text-body)",
                fontFamily: "inherit",
              }}
            />
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <select
                value={genProvider}
                onChange={(e) => setGenProvider(e.target.value)}
                disabled={generating}
                title="Model provider for generation"
                style={{
                  padding: "7px 8px",
                  borderRadius: "var(--radius-md)",
                  border: "1px solid var(--line)",
                  background: "var(--card)",
                  color: "var(--ink)",
                  fontSize: "var(--text-sm)",
                  fontFamily: "inherit",
                }}
              >
                <option value="">Auto</option>
                {PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              <Button
                variant="primary"
                disabled={generating || aiPrompt.trim().length < 3}
                onClick={() => void generateFromPrompt()}
              >
                {generating ? "Generating…" : "Generate"}
              </Button>
            </div>
          </div>
          <div
            style={{
              fontSize: "var(--text-2xs)",
              color: "var(--ink-3)",
              marginTop: 4,
            }}
          >
            Generating replaces the current canvas with a new draft.
            ⌘/Ctrl+Enter to generate.
          </div>
        </div>
      )}

      {showInput && (
        <div
          style={{
            padding: "10px 16px",
            borderBottom: "1px solid var(--line)",
            background: "var(--surface)",
          }}
        >
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginBottom: 4,
            }}
          >
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
              fontSize: "var(--text-xs)",
              padding: "7px 9px",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--line-2)",
              background: "var(--card)",
              color: "var(--ink)",
              resize: "vertical",
            }}
          />
        </div>
      )}

      <div
        ref={panelsRowRef}
        style={{ display: "flex", flex: 1, minHeight: 0 }}
      >
        {/* palette (drag its right edge to resize) */}
        <aside
          style={{
            width: paletteWidth,
            flex: "none",
            padding: 14,
            background: "var(--surface)",
            display: "flex",
            flexDirection: "column",
            gap: 8,
            minHeight: 0,
          }}
        >
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginBottom: 2,
            }}
          >
            ADD NODE
          </div>
          <input
            value={paletteQuery}
            onChange={(e) => setPaletteQuery(e.target.value)}
            placeholder="Search nodes…"
            aria-label="Search nodes"
            style={{
              padding: "6px 9px",
              borderRadius: "var(--radius-md)",
              border: "1px solid var(--line-2)",
              background: "var(--card)",
              color: "var(--ink)",
              fontSize: "var(--text-sm)",
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
                      fontSize: "var(--text-2xs)",
                      fontWeight: "var(--weight-semibold)",
                      letterSpacing: "var(--tracking-label)",
                      textTransform: "uppercase",
                      color: "var(--ink-3)",
                    }}
                  >
                    {group}
                  </div>
                  {items.map((k) => (
                    <button
                      type="button"
                      key={k.label}
                      onClick={() => addNode(k.type, k.defaultConfig)}
                      title={k.description}
                      // Keep the accessible name exactly the label (the visible
                      // description div would otherwise widen it and break exact-name
                      // lookups, incl. the new-nodes Playwright spec).
                      aria-label={k.label}
                      style={{
                        textAlign: "left",
                        padding: "8px 10px",
                        borderRadius: "var(--radius-md)",
                        border: "1px solid var(--line-2)",
                        borderLeft: `3px solid ${k.accent}`,
                        background: "var(--card)",
                        color: "var(--ink)",
                        cursor: "pointer",
                        fontSize: "var(--text-body)",
                      }}
                    >
                      <div style={{ fontWeight: "var(--weight-semibold)" }}>
                        {k.label}
                      </div>
                      <div
                        style={{
                          fontSize: "var(--text-xs)",
                          color: "var(--ink-3)",
                          marginTop: 2,
                          lineHeight: 1.35,
                        }}
                      >
                        {k.description}
                      </div>
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
          <div
            style={{
              marginTop: "auto",
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              lineHeight: 1.5,
            }}
          >
            Drag to move · drag a handle to connect · select + Backspace to
            delete.
          </div>
        </aside>

        {/* drag to resize the palette */}
        <ResizeHandle
          onResize={(clientX) => {
            const r = panelsRowRef.current?.getBoundingClientRect();
            if (r) setPaletteWidth(clampW(clientX - r.left, 150, 420));
          }}
        />

        {/* canvas */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <ReactFlow
            nodes={flowNodes}
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

        {/* node / edge editor — a docked, drag-resizable side panel (right) */}
        {(selected || selectedEdge) && (
          <>
            <ResizeHandle
              onResize={(clientX) => {
                const r = panelsRowRef.current?.getBoundingClientRect();
                if (r) setInspectorWidth(clampW(r.right - clientX, 320, 760));
              }}
            />
            <InspectorPanel
              title={selected ? "Edit node" : "Edit branch condition"}
              width={inspectorWidth}
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
                  connections={connections}
                  pins={pins}
                  canPin={!!workflowKey}
                  pinnedOutput={pins[selected.id]}
                  isPinned={Object.hasOwn(pins, selected.id)}
                  onPin={(output) => pinNode(selected.id, output)}
                  onUnpin={() => unpinNode(selected.id)}
                  onTest={async (autofill) => {
                    const r = await api.testNode(
                      workflowKey,
                      selected.id,
                      undefined,
                      autofill,
                    );
                    // auto-fill pins upstream nodes server-side — refresh so they show.
                    if (autofill && workflowKey) {
                      api
                        .listPins(workflowKey)
                        .then(setPins)
                        .catch(() => undefined);
                    }
                    return r;
                  }}
                  onChange={(patch) => updateConfig(selected.id, patch)}
                />
              ) : selectedEdge ? (
                <EdgeConfigPanel
                  key={selectedEdge.id}
                  condition={selectedEdge.data?.condition}
                  onChange={(patch) =>
                    updateEdgeCondition(selectedEdge.id, patch)
                  }
                  onClear={() => clearEdgeCondition(selectedEdge.id)}
                />
              ) : null}
            </InspectorPanel>
          </>
        )}
      </div>
    </div>
  );
}

/** Centered modal overlay for the node/edge editor; backdrop + Esc close it. */
const clampW = (v: number, min: number, max: number) =>
  Math.max(min, Math.min(max, v));

/** A vertical drag bar for resizing an adjacent side panel. Shows a grip pill so it's
 *  discoverable; `onResize` gets the pointer's clientX during the drag and the caller derives
 *  the new width from the panels-row rect. */
function ResizeHandle({ onResize }: { onResize: (clientX: number) => void }) {
  const [active, setActive] = useState(false);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panel"
      title="Drag to resize"
      onPointerDown={(e) => {
        e.preventDefault();
        setActive(true);
        const move = (ev: PointerEvent) => onResize(ev.clientX);
        const up = () => {
          setActive(false);
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          document.body.style.cursor = "";
          document.body.style.userSelect = "";
        };
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      }}
      onMouseEnter={() => setActive(true)}
      onMouseLeave={() => setActive(false)}
      style={{
        flex: "none",
        width: 9,
        cursor: "col-resize",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--surface)",
        borderLeft: "1px solid var(--line)",
      }}
    >
      <span
        style={{
          width: 3,
          height: 30,
          borderRadius: 2,
          background: active ? "var(--brand)" : "var(--line-2)",
          transition: "background 120ms",
        }}
      />
    </div>
  );
}

/**
 * Docked, drag-resizable node/edge inspector (replaces the old centered modal). Lives inside the
 * canvas flex row as a right-hand column; a ResizeHandle on its left edge changes its width. Esc
 * still closes it.
 */
function InspectorPanel({
  title,
  width,
  onClose,
  onDelete,
  deleteLabel,
  children,
}: {
  title: string;
  width: number;
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
      style={{
        width,
        flex: "none",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        background: "var(--surface)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 16px",
          borderBottom: "1px solid var(--line)",
          flex: "none",
        }}
      >
        <strong style={{ fontSize: "var(--text-md)" }}>{title}</strong>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          style={{
            border: "1px solid var(--line-2)",
            background: "var(--card)",
            color: "var(--ink-2)",
            borderRadius: "var(--radius-sm)",
            cursor: "pointer",
            padding: "2px 9px",
            fontSize: "var(--text-md)",
          }}
        >
          ✕
        </button>
      </div>
      <div style={{ padding: 16, overflowY: "auto", flex: 1, minHeight: 0 }}>
        {children}
      </div>
      {onDelete && (
        <div
          style={{
            padding: "10px 16px",
            borderTop: "1px solid var(--line)",
            display: "flex",
            justifyContent: "flex-end",
            flex: "none",
          }}
        >
          <Button variant="danger" icon="trash" onClick={onDelete}>
            {deleteLabel ?? "Delete"}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Provider/model options the runtime actually supports today. Must stay in sync with the
 *  worker's buildModel() (the providers it can construct) + MODEL_PRICING (so runs are billed) —
 *  offering a provider/model outside those would author nodes that fail or misbill at run time. */
const PROVIDERS = ["anthropic", "openai", "google"] as const;
const MODELS: Record<string, string[]> = {
  anthropic: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"],
  openai: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini"],
  google: ["gemini-2.5-pro", "gemini-2.5-flash"],
};

/** One upstream→argument binding row in the mcpTool editor. */
interface BindingRow {
  from: string;
  path?: string;
}

/** Which connection types each connection-based node can use — mirrors the Integrations
 *  forms (MCP servers = github/atlassian/custom; DB engines; smtp; signing). */
const CONNECTION_TYPES: Record<string, ConnectionRow["type"][]> = {
  mcpTool: ["github", "atlassian", "custom"],
  integration: ["github", "atlassian", "custom"],
  httpRequest: ["github", "atlassian", "custom"],
  sqlQuery: ["postgres", "mssql", "mysql"],
  sqlExec: ["postgres", "mssql", "mysql"],
  sendEmail: ["smtp"],
  hmac: ["signing"],
  jwt: ["signing"],
  totp: ["signing"],
};

/** Pick a connection by LABEL instead of pasting a raw connectionId. Filtered to the node's
 *  connection types; keeps an unknown current value visible so older configs don't break. */
function ConnectionSelect({
  connections,
  types,
  value,
  onChange,
}: {
  connections: ConnectionRow[];
  types: readonly ConnectionRow["type"][];
  value: string;
  onChange: (id: string) => void;
}) {
  const matches = connections.filter((c) => types.includes(c.type));
  const hasCurrent = !!value && matches.some((c) => c.id === value);
  return (
    <>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={inputStyle}
      >
        <option value="">
          {matches.length ? "Select a connection…" : "No matching connections"}
        </option>
        {matches.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label} ({c.type})
          </option>
        ))}
        {value && !hasCurrent && (
          <option value={value}>{value} (current)</option>
        )}
      </select>
      {matches.length === 0 && (
        <div
          style={{
            fontSize: "var(--text-xs)",
            color: "var(--ink-3)",
            marginTop: 4,
          }}
        >
          No matching connection yet — add one on the Integrations screen, then
          reopen this node.
        </div>
      )}
    </>
  );
}

/** Per-type config editor for the selected node — matches the design's inspector.
 *  Only the types with meaningful config (agent, mcpTool) expose fields; others
 *  are structural. Every field maps to a real DSL/runtime config key. */
function ConfigPanel({
  node,
  upstreamIds,
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
          const fieldBindings = (obj("fieldBindings") ?? {}) as Record<string, BindingRow>;
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
              {(action?.fields ?? []).map((f) => {
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

      {kind === "pollTrigger" && (
        <>
          <Labeled label="URL to poll">
            <input
              value={str("url")}
              onChange={(e) => onChange({ url: e.target.value })}
              style={inputStyle}
              placeholder="https://api.example.com/resource"
            />
          </Labeled>
          <Labeled label="Check every (seconds)">
            <input
              type="number"
              value={num("intervalSeconds") ?? 300}
              onChange={(e) =>
                onChange({ intervalSeconds: Number(e.target.value) })
              }
              style={inputStyle}
              placeholder="300"
            />
          </Labeled>
          <Labeled label="Change key (JSON path, optional)">
            <input
              value={str("changeKey")}
              onChange={(e) => onChange({ changeKey: e.target.value })}
              style={inputStyle}
              placeholder="items.0.id (blank = whole response)"
            />
          </Labeled>
        </>
      )}

      {kind === "scheduleTrigger" && (
        <>
          <Labeled label="Cron expression">
            <input
              value={str("cron")}
              onChange={(e) => onChange({ cron: e.target.value })}
              style={inputStyle}
              placeholder="0 9 * * 1-5"
            />
          </Labeled>
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginTop: -6,
            }}
          >
            Standard cron (min hour day month weekday). The schedule is created
            server-side when you save. Examples: <code>*/15 * * * *</code>{" "}
            (every 15 min), <code>0 9 * * 1-5</code> (weekdays 9am),{" "}
            <code>0 0 1 * *</code> (1st of the month).
          </div>
        </>
      )}

      {kind === "chatTrigger" && (
        <>
          <Labeled label="Chat title (optional)">
            <input
              value={str("title")}
              onChange={(e) => onChange({ title: e.target.value })}
              style={inputStyle}
              placeholder="Ask us anything"
            />
          </Labeled>
          <Labeled label="Description (optional)">
            <input
              value={str("description")}
              onChange={(e) => onChange({ description: e.target.value })}
              style={inputStyle}
              placeholder="We're here to help."
            />
          </Labeled>
          <Labeled label="Input placeholder (optional)">
            <input
              value={str("placeholder")}
              onChange={(e) => onChange({ placeholder: e.target.value })}
              style={inputStyle}
              placeholder="Type a message…"
            />
          </Labeled>
          <Labeled label="Greeting (optional)">
            <input
              value={str("greeting")}
              onChange={(e) => onChange({ greeting: e.target.value })}
              style={inputStyle}
              placeholder="Hi! How can I help?"
            />
          </Labeled>
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
              checked={Boolean(config.durableSession)}
              onChange={(e) => onChange({ durableSession: e.target.checked })}
            />
            Durable session (remember the conversation across messages)
          </label>
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginTop: -6,
            }}
          >
            The message + session id arrive as <code>{node.id}</code>. With
            durable session on, a long-lived per-session workflow holds the
            conversation in Temporal; off, each message is threaded with the
            saved history.
          </div>
        </>
      )}

      {kind === "formTrigger" &&
        (() => {
          const fields = (
            Array.isArray(config.fields) ? config.fields : []
          ) as Array<{
            key?: string;
            label?: string;
            type?: string;
            required?: boolean;
            options?: string[];
          }>;
          const setFields = (next: unknown[]) => onChange({ fields: next });
          const patchField = (i: number, patch: Record<string, unknown>) =>
            setFields(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));
          return (
            <>
              <Labeled label="Form title (optional)">
                <input
                  value={str("title")}
                  onChange={(e) => onChange({ title: e.target.value })}
                  style={inputStyle}
                  placeholder="Contact us"
                />
              </Labeled>
              <Labeled label="Description (optional)">
                <input
                  value={str("description")}
                  onChange={(e) => onChange({ description: e.target.value })}
                  style={inputStyle}
                  placeholder="We'll get back to you shortly."
                />
              </Labeled>
              <Labeled label="Submit button label (optional)">
                <input
                  value={str("submitLabel")}
                  onChange={(e) => onChange({ submitLabel: e.target.value })}
                  style={inputStyle}
                  placeholder="Submit"
                />
              </Labeled>

              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <span
                    style={{
                      fontSize: "var(--text-sm)",
                      color: "var(--ink-2)",
                      fontWeight: "var(--weight-semibold)",
                    }}
                  >
                    Fields
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    icon="plus"
                    onClick={() =>
                      setFields([
                        ...fields,
                        { key: "", label: "", type: "text" },
                      ])
                    }
                  >
                    Add field
                  </Button>
                </div>
                {fields.length === 0 && (
                  <div
                    style={{
                      fontSize: "var(--text-xs)",
                      color: "var(--ink-3)",
                    }}
                  >
                    No fields yet. Each submitted value becomes the trigger
                    output, keyed by the field's key.
                  </div>
                )}
                {fields.map((f, i) => (
                  <div
                    // biome-ignore lint/suspicious/noArrayIndexKey: fields are positional
                    key={i}
                    style={{
                      border: "1px solid var(--line)",
                      borderRadius: "var(--radius-md)",
                      padding: 10,
                      display: "flex",
                      flexDirection: "column",
                      gap: 6,
                    }}
                  >
                    <div style={{ display: "flex", gap: 6 }}>
                      <input
                        value={f.key ?? ""}
                        onChange={(e) => patchField(i, { key: e.target.value })}
                        style={inputStyle}
                        placeholder="key (e.g. email)"
                      />
                      <input
                        value={f.label ?? ""}
                        onChange={(e) =>
                          patchField(i, { label: e.target.value })
                        }
                        style={inputStyle}
                        placeholder="Label"
                      />
                    </div>
                    <div
                      style={{ display: "flex", gap: 6, alignItems: "center" }}
                    >
                      <select
                        value={f.type ?? "text"}
                        onChange={(e) =>
                          patchField(i, { type: e.target.value })
                        }
                        style={inputStyle}
                      >
                        {["text", "textarea", "number", "email", "select"].map(
                          (t) => (
                            <option key={t} value={t}>
                              {t}
                            </option>
                          ),
                        )}
                      </select>
                      <label
                        style={{
                          display: "flex",
                          gap: 6,
                          alignItems: "center",
                          fontSize: "var(--text-sm)",
                          color: "var(--ink-2)",
                          whiteSpace: "nowrap",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={Boolean(f.required)}
                          onChange={(e) =>
                            patchField(i, {
                              required: e.target.checked || undefined,
                            })
                          }
                        />
                        Required
                      </label>
                      <Button
                        size="sm"
                        variant="secondary"
                        icon="trash"
                        iconOnly
                        title="Remove field"
                        onClick={() =>
                          setFields(fields.filter((_, j) => j !== i))
                        }
                      />
                    </div>
                    {f.type === "select" && (
                      <input
                        value={(f.options ?? []).join(", ")}
                        onChange={(e) =>
                          patchField(i, {
                            options: e.target.value
                              .split(",")
                              .map((s) => s.trim())
                              .filter(Boolean),
                          })
                        }
                        style={inputStyle}
                        placeholder="option1, option2, option3"
                      />
                    )}
                  </div>
                ))}
              </div>
            </>
          );
        })()}

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
            <ConnectionSelect
              connections={connections}
              types={CONNECTION_TYPES[kind] ?? []}
              value={str("connectionId")}
              onChange={(id) => onChange({ connectionId: id })}
            />
          </Labeled>
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginTop: -6,
            }}
          >
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
              fontSize: "var(--text-sm)",
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

          {/* Pagination — auto-follow pages; the loop runs in the activity, so the
              node returns the combined items. Every page URL is egress-guarded. */}
          {(() => {
            const pg = config.pagination as
              | {
                  mode?: "cursor" | "page" | "url";
                  itemsPath?: string;
                  cursorPath?: string;
                  cursorParam?: string;
                  pageParam?: string;
                  startPage?: number;
                  nextUrlPath?: string;
                  stopOnEmpty?: boolean;
                  maxPages?: number;
                }
              | undefined;
            const on = Boolean(pg);
            const mode = pg?.mode ?? "cursor";
            const setPg = (patch: Record<string, unknown> | undefined) =>
              onChange({ pagination: patch });
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
                      setPg(e.target.checked ? { mode: "cursor" } : undefined)
                    }
                  />
                  Paginate — fetch all pages, return the combined items
                </label>
                {on && (
                  <>
                    <Labeled label="Pagination style">
                      <select
                        value={mode}
                        onChange={(e) => setPg({ ...pg, mode: e.target.value })}
                        style={inputStyle}
                      >
                        <option value="cursor">
                          Cursor / token in the response
                        </option>
                        <option value="page">Increment a page number</option>
                        <option value="url">Follow a next-page URL</option>
                      </select>
                    </Labeled>
                    <Labeled label="Items path (dotted; blank = whole body)">
                      <input
                        value={pg?.itemsPath ?? ""}
                        onChange={(e) =>
                          setPg({
                            ...pg,
                            itemsPath: e.target.value || undefined,
                          })
                        }
                        style={inputStyle}
                        placeholder="data"
                      />
                    </Labeled>
                    {mode === "cursor" && (
                      <>
                        <Labeled label="Cursor path (in the response)">
                          <input
                            value={pg?.cursorPath ?? ""}
                            onChange={(e) =>
                              setPg({
                                ...pg,
                                cursorPath: e.target.value || undefined,
                              })
                            }
                            style={inputStyle}
                            placeholder="meta.next_cursor"
                          />
                        </Labeled>
                        <Labeled label="Cursor query param">
                          <input
                            value={pg?.cursorParam ?? ""}
                            onChange={(e) =>
                              setPg({
                                ...pg,
                                cursorParam: e.target.value || undefined,
                              })
                            }
                            style={inputStyle}
                            placeholder="cursor"
                          />
                        </Labeled>
                      </>
                    )}
                    {mode === "page" && (
                      <>
                        <Labeled label="Page query param">
                          <input
                            value={pg?.pageParam ?? ""}
                            onChange={(e) =>
                              setPg({
                                ...pg,
                                pageParam: e.target.value || undefined,
                              })
                            }
                            style={inputStyle}
                            placeholder="page"
                          />
                        </Labeled>
                        <Labeled label="First page number">
                          <input
                            type="number"
                            min={0}
                            value={pg?.startPage ?? ""}
                            onChange={(e) =>
                              setPg({
                                ...pg,
                                startPage: e.target.value
                                  ? Number(e.target.value)
                                  : undefined,
                              })
                            }
                            style={inputStyle}
                            placeholder="1"
                          />
                        </Labeled>
                      </>
                    )}
                    {mode === "url" && (
                      <Labeled label="Next-URL path (absolute URL in the response)">
                        <input
                          value={pg?.nextUrlPath ?? ""}
                          onChange={(e) =>
                            setPg({
                              ...pg,
                              nextUrlPath: e.target.value || undefined,
                            })
                          }
                          style={inputStyle}
                          placeholder="links.next"
                        />
                      </Labeled>
                    )}
                    <Labeled label="Max pages (safety cap, ≤ 100)">
                      <input
                        type="number"
                        min={1}
                        max={100}
                        value={pg?.maxPages ?? ""}
                        onChange={(e) =>
                          setPg({
                            ...pg,
                            maxPages: e.target.value
                              ? Number(e.target.value)
                              : undefined,
                          })
                        }
                        style={inputStyle}
                        placeholder="10"
                      />
                    </Labeled>
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
                        checked={pg?.stopOnEmpty !== false}
                        onChange={(e) =>
                          setPg({
                            ...pg,
                            stopOnEmpty: e.target.checked ? undefined : false,
                          })
                        }
                      />
                      Stop when a page returns no items
                    </label>
                  </>
                )}
              </div>
            );
          })()}
        </>
      )}

      {(kind === "sqlQuery" || kind === "sqlExec") && (
        <>
          <Labeled label="Database connection id">
            <ConnectionSelect
              connections={connections}
              types={CONNECTION_TYPES[kind] ?? []}
              value={str("connectionId")}
              onChange={(id) => onChange({ connectionId: id })}
            />
          </Labeled>
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginTop: -6,
            }}
          >
            A <code>postgres</code>, <code>mssql</code>, or <code>mysql</code>{" "}
            connection.{" "}
            {kind === "sqlExec"
              ? "Writes run in a transaction (commit on success, rollback on error). At-most-once — never retried."
              : "Read-only — the query runs in a transaction that's always rolled back."}
          </div>

          <div>
            <RowHead
              label="SQL"
              value={kind === "sqlExec" ? "write" : "read-only"}
            />
            <textarea
              value={str("sql")}
              onChange={(e) => onChange({ sql: e.target.value })}
              rows={5}
              style={textareaStyle}
              placeholder={
                kind === "sqlExec"
                  ? "UPDATE users SET seen = true WHERE id = $1"
                  : "SELECT id, email FROM users WHERE id = $1"
              }
            />
          </div>
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginTop: -6,
            }}
          >
            Placeholders are engine-specific: <code>$1, $2…</code> (Postgres),{" "}
            <code>@p1, @p2…</code> (MSSQL), or <code>?</code> (MySQL). Bindings
            fill the values — never build SQL from upstream output.
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
          <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}>
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

      {kind === "text" &&
        (() => {
          const op = str("operation") || "trim";
          return (
            <>
              <Labeled label="Operation">
                <select
                  value={op}
                  onChange={(e) => onChange({ operation: e.target.value })}
                  style={inputStyle}
                >
                  <option value="upper">Uppercase</option>
                  <option value="lower">Lowercase</option>
                  <option value="trim">Trim whitespace</option>
                  <option value="replace">Replace</option>
                  <option value="split">Split → array</option>
                  <option value="join">Join array → string</option>
                  <option value="substring">Substring</option>
                  <option value="length">Length</option>
                  <option value="regexExtract">Regex extract</option>
                </select>
              </Labeled>
              <Labeled label="Source node id">
                <input
                  value={str("from")}
                  onChange={(e) => onChange({ from: e.target.value })}
                  style={inputStyle}
                  placeholder="upstream-node-id"
                />
              </Labeled>
              <Labeled label="Path (optional)">
                <input
                  value={str("path")}
                  onChange={(e) => onChange({ path: e.target.value })}
                  style={inputStyle}
                  placeholder="output"
                />
              </Labeled>
              {op === "replace" && (
                <>
                  <Labeled label="Find">
                    <input
                      value={str("search")}
                      onChange={(e) => onChange({ search: e.target.value })}
                      style={inputStyle}
                      placeholder="text or regex source"
                    />
                  </Labeled>
                  <Labeled label="Replace with">
                    <input
                      value={str("replacement")}
                      onChange={(e) =>
                        onChange({ replacement: e.target.value })
                      }
                      style={inputStyle}
                      placeholder="replacement"
                    />
                  </Labeled>
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
                      checked={Boolean(config.useRegex)}
                      onChange={(e) => onChange({ useRegex: e.target.checked })}
                    />
                    Treat "find" as a regular expression (global)
                  </label>
                </>
              )}
              {(op === "split" || op === "join") && (
                <Labeled label="Separator">
                  <input
                    value={str("separator")}
                    onChange={(e) => onChange({ separator: e.target.value })}
                    style={inputStyle}
                    placeholder=","
                  />
                </Labeled>
              )}
              {op === "substring" && (
                <div style={{ display: "flex", gap: 8 }}>
                  <Labeled label="Start">
                    <input
                      type="number"
                      value={num("start") ?? ""}
                      onChange={(e) =>
                        onChange({
                          start: e.target.value
                            ? Number(e.target.value)
                            : undefined,
                        })
                      }
                      style={inputStyle}
                      placeholder="0"
                    />
                  </Labeled>
                  <Labeled label="End (optional)">
                    <input
                      type="number"
                      value={num("end") ?? ""}
                      onChange={(e) =>
                        onChange({
                          end: e.target.value
                            ? Number(e.target.value)
                            : undefined,
                        })
                      }
                      style={inputStyle}
                      placeholder="end"
                    />
                  </Labeled>
                </div>
              )}
              {op === "regexExtract" && (
                <div style={{ display: "flex", gap: 8 }}>
                  <Labeled label="Pattern">
                    <input
                      value={str("search")}
                      onChange={(e) => onChange({ search: e.target.value })}
                      style={inputStyle}
                      placeholder="(\\d+)"
                    />
                  </Labeled>
                  <Labeled label="Group">
                    <input
                      type="number"
                      value={num("group") ?? ""}
                      onChange={(e) =>
                        onChange({
                          group: e.target.value
                            ? Number(e.target.value)
                            : undefined,
                        })
                      }
                      style={inputStyle}
                      placeholder="0"
                    />
                  </Labeled>
                </div>
              )}
              <div
                style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}
              >
                Result is <code>{node.id}.result</code>.
              </div>
            </>
          );
        })()}

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
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginTop: -6,
            }}
          >
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
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginTop: -6,
            }}
          >
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
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginTop: -6,
            }}
          >
            Outputs the resulting array. sort/dedupe use the field (whole item
            if blank); limit takes the first N.
          </div>
        </>
      )}

      {kind === "compareDatasets" && (
        <>
          <Labeled label="A — source node id">
            <input
              value={(config.a as BindingRow | undefined)?.from ?? ""}
              onChange={(e) =>
                onChange({
                  a: {
                    ...(config.a as BindingRow | undefined),
                    from: e.target.value,
                  },
                })
              }
              style={inputStyle}
              placeholder="baseline-node"
            />
          </Labeled>
          <Labeled label="A — array path (optional)">
            <input
              value={(config.a as BindingRow | undefined)?.path ?? ""}
              onChange={(e) =>
                onChange({
                  a: {
                    ...(config.a as BindingRow | undefined),
                    path: e.target.value || undefined,
                  },
                })
              }
              style={inputStyle}
              placeholder="rows"
            />
          </Labeled>
          <Labeled label="B — source node id">
            <input
              value={(config.b as BindingRow | undefined)?.from ?? ""}
              onChange={(e) =>
                onChange({
                  b: {
                    ...(config.b as BindingRow | undefined),
                    from: e.target.value,
                  },
                })
              }
              style={inputStyle}
              placeholder="comparison-node"
            />
          </Labeled>
          <Labeled label="B — array path (optional)">
            <input
              value={(config.b as BindingRow | undefined)?.path ?? ""}
              onChange={(e) =>
                onChange({
                  b: {
                    ...(config.b as BindingRow | undefined),
                    path: e.target.value || undefined,
                  },
                })
              }
              style={inputStyle}
              placeholder="rows"
            />
          </Labeled>
          <Labeled label="Key field (identifies a row)">
            <input
              value={str("key")}
              onChange={(e) => onChange({ key: e.target.value })}
              style={inputStyle}
              placeholder="id"
            />
          </Labeled>
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginTop: -6,
            }}
          >
            Diffs A vs B by the key → <code>{node.id}.added</code> /{" "}
            <code>.removed</code> / <code>.changed</code> / <code>.same</code>.
          </div>
        </>
      )}

      {kind === "xml" && (
        <>
          <Labeled label="Operation">
            <select
              value={str("operation") || "parse"}
              onChange={(e) => onChange({ operation: e.target.value })}
              style={inputStyle}
            >
              <option value="parse">parse (XML → object)</option>
              <option value="build">build (object → XML)</option>
            </select>
          </Labeled>
          <Labeled label="Source node id">
            <input
              value={str("from")}
              onChange={(e) => onChange({ from: e.target.value })}
              style={inputStyle}
              placeholder="upstream-node-id"
            />
          </Labeled>
          <Labeled label="Path (optional)">
            <input
              value={str("path")}
              onChange={(e) => onChange({ path: e.target.value })}
              style={inputStyle}
              placeholder="body"
            />
          </Labeled>
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginTop: -6,
            }}
          >
            parse → <code>{node.id}</code> is the object; build →{" "}
            <code>{node.id}.xml</code> is the string.
          </div>
        </>
      )}

      {kind === "markdown" && (
        <>
          <Labeled label="Source node id">
            <input
              value={str("from")}
              onChange={(e) => onChange({ from: e.target.value })}
              style={inputStyle}
              placeholder="upstream-node-id"
            />
          </Labeled>
          <Labeled label="Path (optional)">
            <input
              value={str("path")}
              onChange={(e) => onChange({ path: e.target.value })}
              style={inputStyle}
              placeholder="body"
            />
          </Labeled>
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginTop: -6,
            }}
          >
            Converts that HTML string to Markdown →{" "}
            <code>{node.id}.markdown</code>.
          </div>
        </>
      )}

      {(kind === "vectorUpsert" || kind === "vectorQuery") && (
        <>
          <Labeled label="Collection">
            <input
              value={str("collection")}
              onChange={(e) => onChange({ collection: e.target.value })}
              style={inputStyle}
              placeholder="docs"
            />
          </Labeled>
          <Labeled
            label={
              kind === "vectorUpsert"
                ? "Text source node id (string or string[])"
                : "Query source node id"
            }
          >
            <input
              value={str("from")}
              onChange={(e) => onChange({ from: e.target.value })}
              style={inputStyle}
              placeholder="upstream-node-id"
            />
          </Labeled>
          <Labeled label="Path (optional)">
            <input
              value={str("path")}
              onChange={(e) => onChange({ path: e.target.value })}
              style={inputStyle}
              placeholder="message"
            />
          </Labeled>
          {kind === "vectorQuery" && (
            <Labeled label="Top K (default 4)">
              <input
                type="number"
                value={str("topK")}
                onChange={(e) =>
                  onChange({
                    topK: e.target.value ? Number(e.target.value) : undefined,
                  })
                }
                style={inputStyle}
                placeholder="4"
              />
            </Labeled>
          )}
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginTop: -6,
            }}
          >
            {kind === "vectorUpsert" ? (
              <>
                Embeds + stores the chunk(s) → <code>{node.id}.upserted</code>.
                Needs an OpenAI key (Integrations).
              </>
            ) : (
              <>
                Returns the nearest chunks → <code>{node.id}.matches</code>.
                Bind an agent's context to these for RAG.
              </>
            )}
          </div>
        </>
      )}

      {kind === "splitOut" && (
        <>
          <Labeled label="Array source node id">
            <input
              value={str("from")}
              onChange={(e) => onChange({ from: e.target.value })}
              style={inputStyle}
              placeholder="upstream-node-id"
            />
          </Labeled>
          <Labeled label="Path to the array (optional)">
            <input
              value={str("path")}
              onChange={(e) => onChange({ path: e.target.value })}
              style={inputStyle}
              placeholder="items"
            />
          </Labeled>
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginTop: -6,
            }}
          >
            Runs the region up to <strong>Loop End</strong> once per item;
            inside it, <code>{node.id}</code> is the current item. The region
            can hold transforms, activities (Agent / HTTP / MCP), and{" "}
            <strong>IF / Switch / Merge</strong> branching that rejoins before
            Loop End — the shape is validated on save.
          </div>
        </>
      )}

      {kind === "loopEnd" && (
        <>
          <Labeled label="Collect from region node id">
            <input
              value={str("from")}
              onChange={(e) => onChange({ from: e.target.value })}
              style={inputStyle}
              placeholder="region-node-id"
            />
          </Labeled>
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginTop: -6,
            }}
          >
            <code>{node.id}</code> is the ARRAY of that node's per-item outputs.
            After it, the flow is a single value again.
          </div>
        </>
      )}

      {kind === "htmlExtract" &&
        (() => {
          const extractions =
            (config.extractions as
              | Array<{
                  key?: string;
                  selector?: string;
                  return?: string;
                  attribute?: string;
                  all?: boolean;
                }>
              | undefined) ?? [];
          const setEx = (next: typeof extractions) =>
            onChange({ extractions: next });
          return (
            <>
              <Labeled label="HTML source node id">
                <input
                  value={str("from")}
                  onChange={(e) => onChange({ from: e.target.value })}
                  style={inputStyle}
                  placeholder="upstream-http-node"
                />
              </Labeled>
              <Labeled label="Path (optional)">
                <input
                  value={str("path")}
                  onChange={(e) => onChange({ path: e.target.value })}
                  style={inputStyle}
                  placeholder="body"
                />
              </Labeled>
              <div
                style={{
                  fontSize: "var(--text-xs)",
                  color: "var(--ink-3)",
                  marginTop: -6,
                }}
              >
                Each row reads a CSS selector's match into{" "}
                <code>{node.id}.&lt;key&gt;</code>.
              </div>
              {extractions.map((ex, i) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: positional rows
                  key={i}
                  style={{
                    border: "1px solid var(--line)",
                    borderRadius: "var(--radius-md)",
                    padding: 10,
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                  }}
                >
                  <div style={{ display: "flex", gap: 8 }}>
                    <input
                      value={ex.key ?? ""}
                      onChange={(e) =>
                        setEx(
                          extractions.map((x, j) =>
                            j === i ? { ...x, key: e.target.value } : x,
                          ),
                        )
                      }
                      style={inputStyle}
                      placeholder="key (e.g. title)"
                    />
                    <button
                      type="button"
                      aria-label="Remove extraction"
                      onClick={() =>
                        setEx(extractions.filter((_, j) => j !== i))
                      }
                      style={{
                        border: "1px solid var(--line-2)",
                        background: "var(--card)",
                        color: "var(--ink-2)",
                        borderRadius: "var(--radius-sm)",
                        cursor: "pointer",
                        padding: "6px 10px",
                        flex: "none",
                      }}
                    >
                      ×
                    </button>
                  </div>
                  <input
                    value={ex.selector ?? ""}
                    onChange={(e) =>
                      setEx(
                        extractions.map((x, j) =>
                          j === i ? { ...x, selector: e.target.value } : x,
                        ),
                      )
                    }
                    style={inputStyle}
                    placeholder="CSS selector (e.g. h1, .price, a.more)"
                  />
                  <div style={{ display: "flex", gap: 8 }}>
                    <select
                      value={ex.return ?? "text"}
                      onChange={(e) =>
                        setEx(
                          extractions.map((x, j) =>
                            j === i ? { ...x, return: e.target.value } : x,
                          ),
                        )
                      }
                      style={inputStyle}
                    >
                      <option value="text">text</option>
                      <option value="html">inner HTML</option>
                      <option value="attribute">attribute</option>
                    </select>
                    {ex.return === "attribute" && (
                      <input
                        value={ex.attribute ?? ""}
                        onChange={(e) =>
                          setEx(
                            extractions.map((x, j) =>
                              j === i ? { ...x, attribute: e.target.value } : x,
                            ),
                          )
                        }
                        style={inputStyle}
                        placeholder="attribute (e.g. href)"
                      />
                    )}
                  </div>
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
                      checked={Boolean(ex.all)}
                      onChange={(e) =>
                        setEx(
                          extractions.map((x, j) =>
                            j === i ? { ...x, all: e.target.checked } : x,
                          ),
                        )
                      }
                    />
                    Return all matches (array)
                  </label>
                </div>
              ))}
              <button
                type="button"
                onClick={() =>
                  setEx([
                    ...extractions,
                    { key: "", selector: "", return: "text" },
                  ])
                }
                style={{
                  alignSelf: "flex-start",
                  border: "1px solid var(--line-2)",
                  background: "var(--card)",
                  color: "var(--ink-2)",
                  borderRadius: "var(--radius-sm)",
                  cursor: "pointer",
                  padding: "6px 10px",
                  fontSize: "var(--text-sm)",
                }}
              >
                + Add extraction
              </button>
            </>
          );
        })()}

      {kind === "json" && (
        <>
          <Labeled label="Operation">
            <select
              value={str("operation") || "parse"}
              onChange={(e) => onChange({ operation: e.target.value })}
              style={inputStyle}
            >
              <option value="parse">parse (JSON text → data)</option>
              <option value="stringify">stringify (data → JSON text)</option>
            </select>
          </Labeled>
          <Labeled label="Source node id">
            <input
              value={str("from")}
              onChange={(e) => onChange({ from: e.target.value })}
              style={inputStyle}
              placeholder="upstream-node-id"
            />
          </Labeled>
          <Labeled label="Path (optional)">
            <input
              value={str("path")}
              onChange={(e) => onChange({ path: e.target.value })}
              style={inputStyle}
              placeholder="body"
            />
          </Labeled>
          {str("operation") === "stringify" && (
            <Labeled label="Indent (0 = compact)">
              <input
                type="number"
                min={0}
                value={num("indent") ?? ""}
                onChange={(e) =>
                  onChange({
                    indent: e.target.value ? Number(e.target.value) : undefined,
                  })
                }
                style={inputStyle}
                placeholder="0"
              />
            </Labeled>
          )}
          <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}>
            parse → <code>{node.id}</code> is the value; stringify →{" "}
            <code>{node.id}.json</code> is the string.
          </div>
        </>
      )}

      {kind === "encode" && (
        <>
          <Labeled label="Operation">
            <select
              value={str("operation") || "base64Encode"}
              onChange={(e) => onChange({ operation: e.target.value })}
              style={inputStyle}
            >
              <option value="base64Encode">Base64 encode</option>
              <option value="base64Decode">Base64 decode</option>
              <option value="base64urlEncode">Base64url encode</option>
              <option value="base64urlDecode">Base64url decode</option>
              <option value="hexEncode">Hex encode</option>
              <option value="hexDecode">Hex decode</option>
              <option value="urlEncode">URL encode</option>
              <option value="urlDecode">URL decode</option>
            </select>
          </Labeled>
          <Labeled label="Source node id">
            <input
              value={str("from")}
              onChange={(e) => onChange({ from: e.target.value })}
              style={inputStyle}
              placeholder="upstream-node-id"
            />
          </Labeled>
          <Labeled label="Path (optional)">
            <input
              value={str("path")}
              onChange={(e) => onChange({ path: e.target.value })}
              style={inputStyle}
              placeholder="result"
            />
          </Labeled>
          <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}>
            Result is <code>{node.id}.result</code>.
          </div>
        </>
      )}

      {kind === "number" &&
        (() => {
          const op = str("operation") || "add";
          const binary = [
            "add",
            "subtract",
            "multiply",
            "divide",
            "modulo",
            "power",
          ].includes(op);
          const bind = (k: "aBinding" | "bBinding") =>
            (config[k] as { from?: string; path?: string } | undefined) ?? {};
          const setBind = (
            k: "aBinding" | "bBinding",
            patch: { from?: string; path?: string },
          ) => {
            const next = { ...bind(k), ...patch };
            onChange({ [k]: next.from ? next : undefined });
          };
          return (
            <>
              <Labeled label="Operation">
                <select
                  value={op}
                  onChange={(e) => onChange({ operation: e.target.value })}
                  style={inputStyle}
                >
                  <option value="add">Add (a + b)</option>
                  <option value="subtract">Subtract (a − b)</option>
                  <option value="multiply">Multiply (a × b)</option>
                  <option value="divide">Divide (a ÷ b)</option>
                  <option value="modulo">Modulo (a % b)</option>
                  <option value="power">Power (a ^ b)</option>
                  <option value="round">Round (a)</option>
                  <option value="floor">Floor (a)</option>
                  <option value="ceil">Ceil (a)</option>
                  <option value="abs">Absolute (a)</option>
                </select>
              </Labeled>
              <div style={{ display: "flex", gap: 8 }}>
                <Labeled label="a (value)">
                  <input
                    type="number"
                    value={num("a") ?? ""}
                    onChange={(e) =>
                      onChange({
                        a: e.target.value ? Number(e.target.value) : undefined,
                      })
                    }
                    style={inputStyle}
                    placeholder="0"
                  />
                </Labeled>
                <Labeled label="a from node">
                  <input
                    value={bind("aBinding").from ?? ""}
                    onChange={(e) =>
                      setBind("aBinding", { from: e.target.value })
                    }
                    style={inputStyle}
                    placeholder="node id"
                  />
                </Labeled>
                <Labeled label="a path">
                  <input
                    value={bind("aBinding").path ?? ""}
                    onChange={(e) =>
                      setBind("aBinding", { path: e.target.value })
                    }
                    style={inputStyle}
                    placeholder="x"
                  />
                </Labeled>
              </div>
              {binary && (
                <div style={{ display: "flex", gap: 8 }}>
                  <Labeled label="b (value)">
                    <input
                      type="number"
                      value={num("b") ?? ""}
                      onChange={(e) =>
                        onChange({
                          b: e.target.value
                            ? Number(e.target.value)
                            : undefined,
                        })
                      }
                      style={inputStyle}
                      placeholder="0"
                    />
                  </Labeled>
                  <Labeled label="b from node">
                    <input
                      value={bind("bBinding").from ?? ""}
                      onChange={(e) =>
                        setBind("bBinding", { from: e.target.value })
                      }
                      style={inputStyle}
                      placeholder="node id"
                    />
                  </Labeled>
                  <Labeled label="b path">
                    <input
                      value={bind("bBinding").path ?? ""}
                      onChange={(e) =>
                        setBind("bBinding", { path: e.target.value })
                      }
                      style={inputStyle}
                      placeholder="y"
                    />
                  </Labeled>
                </div>
              )}
              {op === "round" && (
                <Labeled label="Decimal places">
                  <input
                    type="number"
                    min={0}
                    value={num("precision") ?? ""}
                    onChange={(e) =>
                      onChange({
                        precision: e.target.value
                          ? Number(e.target.value)
                          : undefined,
                      })
                    }
                    style={inputStyle}
                    placeholder="0"
                  />
                </Labeled>
              )}
              <div
                style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}
              >
                Result is <code>{node.id}.result</code>. A binding (from/path)
                overrides the static value.
              </div>
            </>
          );
        })()}

      {kind === "csv" && (
        <>
          <Labeled label="Operation">
            <select
              value={str("operation") || "parse"}
              onChange={(e) => onChange({ operation: e.target.value })}
              style={inputStyle}
            >
              <option value="parse">parse (CSV text → rows)</option>
              <option value="build">build (rows → CSV text)</option>
            </select>
          </Labeled>
          <Labeled label="Source node id">
            <input
              value={str("from")}
              onChange={(e) => onChange({ from: e.target.value })}
              style={inputStyle}
              placeholder="upstream-node-id"
            />
          </Labeled>
          <Labeled label="Path (optional)">
            <input
              value={str("path")}
              onChange={(e) => onChange({ path: e.target.value })}
              style={inputStyle}
              placeholder="body"
            />
          </Labeled>
          <div style={{ display: "flex", gap: 8 }}>
            <Labeled label="Delimiter">
              <input
                value={str("delimiter") || ""}
                onChange={(e) =>
                  onChange({ delimiter: e.target.value || undefined })
                }
                style={inputStyle}
                placeholder=","
              />
            </Labeled>
          </div>
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
              checked={config.header !== false}
              onChange={(e) => onChange({ header: e.target.checked })}
            />
            First row is the header
          </label>
          <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}>
            parse → <code>{node.id}</code> is the rows array; build →{" "}
            <code>{node.id}.csv</code> is the string.
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
          <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}>
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
          <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}>
            Joins parallel branches: runs once, after <em>all</em> inbound
            branches arrive, and combines their outputs into{" "}
            <code>{node.id}</code>. Inbound edges must be unconditional (no
            branch conditions into a merge).
          </div>
        </>
      )}

      {kind === "if" &&
        (() => {
          const conditions =
            (config.conditions as
              | Array<{ path?: string; op?: string; value?: unknown }>
              | undefined) ?? [];
          const setConds = (next: typeof conditions) =>
            onChange({ conditions: next });
          return (
            <>
              <Labeled label="Combine">
                <select
                  value={str("combine") || "and"}
                  onChange={(e) => onChange({ combine: e.target.value })}
                  style={inputStyle}
                >
                  <option value="and">AND — all must be true</option>
                  <option value="or">OR — any can be true</option>
                </select>
              </Labeled>
              <div
                style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}
              >
                Result is <code>{node.id}.result</code> (boolean). Draw a
                true-edge (<code>result eq true</code>) and a false-edge.
              </div>
              {conditions.map((c, i) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: positional rows
                  key={i}
                  style={{
                    border: "1px solid var(--line)",
                    borderRadius: "var(--radius-md)",
                    padding: 10,
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                  }}
                >
                  <ConditionEditor
                    condition={c}
                    onChange={(next) =>
                      setConds(conditions.map((x, j) => (j === i ? next : x)))
                    }
                  />
                  <button
                    type="button"
                    aria-label="Remove condition"
                    onClick={() =>
                      setConds(conditions.filter((_, j) => j !== i))
                    }
                    style={{
                      alignSelf: "flex-end",
                      border: "1px solid var(--line-2)",
                      background: "var(--card)",
                      color: "var(--ink-2)",
                      borderRadius: "var(--radius-sm)",
                      cursor: "pointer",
                      padding: "4px 10px",
                      fontSize: "var(--text-sm)",
                    }}
                  >
                    Remove
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() =>
                  setConds([...conditions, { path: "", op: "eq", value: "" }])
                }
                style={{
                  alignSelf: "flex-start",
                  border: "1px solid var(--line-2)",
                  background: "var(--card)",
                  color: "var(--ink-2)",
                  borderRadius: "var(--radius-sm)",
                  cursor: "pointer",
                  padding: "6px 10px",
                  fontSize: "var(--text-sm)",
                }}
              >
                + Add condition
              </button>
            </>
          );
        })()}

      {kind === "switch" &&
        (() => {
          const rules =
            (config.rules as
              | Array<{
                  name?: string;
                  condition?: { path?: string; op?: string; value?: unknown };
                }>
              | undefined) ?? [];
          const setRules = (next: typeof rules) => onChange({ rules: next });
          return (
            <>
              <div
                style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}
              >
                Rules run top-to-bottom; the first match sets{" "}
                <code>{node.id}.matched</code> to that rule's name (else the
                fallback). Draw one outgoing edge per branch with{" "}
                <code>matched eq &lt;name&gt;</code>.
              </div>
              {rules.map((rule, i) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: rules are positional
                  key={i}
                  style={{
                    border: "1px solid var(--line)",
                    borderRadius: "var(--radius-md)",
                    padding: 10,
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                  }}
                >
                  <div
                    style={{ display: "flex", gap: 8, alignItems: "center" }}
                  >
                    <input
                      value={rule.name ?? ""}
                      onChange={(e) =>
                        setRules(
                          rules.map((r, j) =>
                            j === i ? { ...r, name: e.target.value } : r,
                          ),
                        )
                      }
                      style={inputStyle}
                      placeholder="branch name (e.g. urgent)"
                    />
                    <button
                      type="button"
                      aria-label="Remove rule"
                      onClick={() => setRules(rules.filter((_, j) => j !== i))}
                      style={{
                        border: "1px solid var(--line-2)",
                        background: "var(--card)",
                        color: "var(--ink-2)",
                        borderRadius: "var(--radius-sm)",
                        cursor: "pointer",
                        padding: "6px 10px",
                        flex: "none",
                      }}
                    >
                      ×
                    </button>
                  </div>
                  <ConditionEditor
                    condition={rule.condition}
                    onChange={(c) =>
                      setRules(
                        rules.map((r, j) =>
                          j === i ? { ...r, condition: c } : r,
                        ),
                      )
                    }
                  />
                </div>
              ))}
              <button
                type="button"
                onClick={() =>
                  setRules([
                    ...rules,
                    { name: "", condition: { path: "", op: "eq", value: "" } },
                  ])
                }
                style={{
                  alignSelf: "flex-start",
                  border: "1px solid var(--line-2)",
                  background: "var(--card)",
                  color: "var(--ink-2)",
                  borderRadius: "var(--radius-sm)",
                  cursor: "pointer",
                  padding: "6px 10px",
                  fontSize: "var(--text-sm)",
                }}
              >
                + Add rule
              </button>
              <Labeled label="Fallback (matched when no rule fits)">
                <input
                  value={str("fallback")}
                  onChange={(e) => onChange({ fallback: e.target.value })}
                  style={inputStyle}
                  placeholder="default"
                />
              </Labeled>
            </>
          );
        })()}

      {kind === "hmac" && (
        <>
          <Labeled label="Signing connection id">
            <ConnectionSelect
              connections={connections}
              types={CONNECTION_TYPES[kind] ?? []}
              value={str("connectionId")}
              onChange={(id) => onChange({ connectionId: id })}
            />
          </Labeled>
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginTop: -6,
            }}
          >
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
            <ConnectionSelect
              connections={connections}
              types={CONNECTION_TYPES[kind] ?? []}
              value={str("connectionId")}
              onChange={(id) => onChange({ connectionId: id })}
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
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginTop: -6,
            }}
          >
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
            <ConnectionSelect
              connections={connections}
              types={CONNECTION_TYPES[kind] ?? []}
              value={str("connectionId")}
              onChange={(id) => onChange({ connectionId: id })}
            />
          </Labeled>
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginTop: -6,
            }}
          >
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

      {kind === "hash" && (
        <>
          <div style={{ display: "flex", gap: 8 }}>
            <Labeled label="Algorithm">
              <select
                value={str("algorithm") || "sha256"}
                onChange={(e) => onChange({ algorithm: e.target.value })}
                style={inputStyle}
              >
                <option value="sha256">SHA-256</option>
                <option value="sha512">SHA-512</option>
                <option value="sha1">SHA-1</option>
                <option value="md5">MD5</option>
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
          </div>
          <Labeled label="Value to hash (static)">
            <input
              value={str("input")}
              onChange={(e) => onChange({ input: e.target.value })}
              style={inputStyle}
              placeholder="text, or bind from a node below"
            />
          </Labeled>
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginTop: -6,
            }}
          >
            Or bind the value from an upstream node (overrides the static
            value).
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Labeled label="From node id">
              <input
                value={
                  (config.inputBinding as { from?: string } | undefined)
                    ?.from ?? ""
                }
                onChange={(e) =>
                  onChange({
                    inputBinding: e.target.value
                      ? {
                          from: e.target.value,
                          path: (
                            config.inputBinding as { path?: string } | undefined
                          )?.path,
                        }
                      : undefined,
                  })
                }
                style={inputStyle}
                placeholder="upstream-node-id"
              />
            </Labeled>
            <Labeled label="Path (optional)">
              <input
                value={
                  (config.inputBinding as { path?: string } | undefined)
                    ?.path ?? ""
                }
                onChange={(e) =>
                  onChange({
                    inputBinding: {
                      from:
                        (config.inputBinding as { from?: string } | undefined)
                          ?.from ?? "",
                      path: e.target.value || undefined,
                    },
                  })
                }
                style={inputStyle}
                placeholder="body"
              />
            </Labeled>
          </div>
          <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}>
            Output is <code>{node.id}.digest</code>.
          </div>
        </>
      )}

      {kind === "random" && (
        <>
          <Labeled label="Generate">
            <select
              value={str("operation") || "uuid"}
              onChange={(e) => onChange({ operation: e.target.value })}
              style={inputStyle}
            >
              <option value="uuid">UUID (v4)</option>
              <option value="hex">Random hex</option>
              <option value="base64">Random base64url</option>
              <option value="alphanumeric">Alphanumeric string</option>
              <option value="int">Integer in a range</option>
            </select>
          </Labeled>
          {(str("operation") === "hex" ||
            str("operation") === "base64" ||
            str("operation") === "alphanumeric") && (
            <Labeled
              label={
                str("operation") === "alphanumeric"
                  ? "Length (characters)"
                  : "Length (bytes)"
              }
            >
              <input
                type="number"
                min={1}
                value={num("length") ?? ""}
                onChange={(e) =>
                  onChange({
                    length: e.target.value ? Number(e.target.value) : undefined,
                  })
                }
                style={inputStyle}
                placeholder="16"
              />
            </Labeled>
          )}
          {str("operation") === "int" && (
            <div style={{ display: "flex", gap: 8 }}>
              <Labeled label="Min">
                <input
                  type="number"
                  value={num("min") ?? ""}
                  onChange={(e) =>
                    onChange({
                      min: e.target.value ? Number(e.target.value) : undefined,
                    })
                  }
                  style={inputStyle}
                  placeholder="0"
                />
              </Labeled>
              <Labeled label="Max">
                <input
                  type="number"
                  value={num("max") ?? ""}
                  onChange={(e) =>
                    onChange({
                      max: e.target.value ? Number(e.target.value) : undefined,
                    })
                  }
                  style={inputStyle}
                  placeholder="100"
                />
              </Labeled>
            </div>
          )}
          <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}>
            Output is <code>{node.id}.value</code>. Generated fresh each run.
          </div>
        </>
      )}

      {kind === "sendEmail" && (
        <>
          <Labeled label="SMTP connection id">
            <ConnectionSelect
              connections={connections}
              types={CONNECTION_TYPES[kind] ?? []}
              value={str("connectionId")}
              onChange={(id) => onChange({ connectionId: id })}
            />
          </Labeled>
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginTop: -6,
            }}
          >
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
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginTop: -6,
            }}
          >
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
          <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}>
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
          <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}>
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
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginTop: -6,
            }}
          >
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
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginTop: -6,
            }}
          >
            Runs that saved workflow once per array item (item = the child's
            input), concurrently. Output is an array of{" "}
            <code>{node.id}.N.status</code> / <code>.output</code>, one per
            item. Capped at 100 items — filter first if larger.
          </div>
        </>
      )}

      {kind === "wait" && (
        <>
          <Labeled label="Wait mode">
            <select
              value={str("mode") || "duration"}
              onChange={(e) => onChange({ mode: e.target.value })}
              style={inputStyle}
            >
              <option value="duration">
                Duration — pause for a fixed time
              </option>
              <option value="webhook">
                Webhook — pause until an external system resumes
              </option>
            </select>
          </Labeled>
          {(str("mode") || "duration") === "webhook" ? (
            <>
              <Labeled label="Timeout (seconds, optional)">
                <input
                  type="number"
                  min={0}
                  value={num("timeoutSeconds") ?? ""}
                  onChange={(e) =>
                    onChange({
                      timeoutSeconds: e.target.value
                        ? Number(e.target.value)
                        : undefined,
                    })
                  }
                  style={inputStyle}
                  placeholder="wait forever"
                />
              </Labeled>
              <div
                style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}
              >
                Pauses until an external system POSTs the run's resume URL
                (shown on the run page). Survives restarts for days. With a
                timeout it auto-continues on elapse; the node output is{" "}
                <code>
                  {"{"}resumed, timedOut, payload{"}"}
                </code>{" "}
                — branch on <code>{node.id}.resumed</code>.
              </div>
            </>
          ) : (
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
              <div
                style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}
              >
                Pauses the run with a durable timer — it survives restarts and
                costs nothing while waiting.
              </div>
            </>
          )}
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
          <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}>
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
          <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}>
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
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginTop: -6,
            }}
          >
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

/** A small copy-to-clipboard button with brief "Copied ✓" feedback. */
/**
 * Data pinning (design SINGLE-NODE-EXECUTION.md slice 1): pin a sample output for this node so you
 * can build downstream nodes against it without re-running upstream. Authoring-only — the
 * interpreter never reads pins. Source in slice 1 is a manual JSON paste (single-node "Test" that
 * fills it is slice 2).
 */
/** Dotted paths to the leaves of a pinned output — powers the reference picker's suggestions.
 *  Capped in depth + count so a big object doesn't explode the chip list. Arrays are leaves
 *  (the user indexes them). */
function leafPaths(
  value: unknown,
  prefix = "",
  depth = 0,
  out: string[] = [],
): string[] {
  if (out.length >= 24 || depth > 3) return out;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (out.length >= 24) break;
      const path = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === "object" && !Array.isArray(v) && depth < 3) {
        leafPaths(v, path, depth + 1, out);
      } else {
        out.push(path);
      }
    }
  }
  return out;
}

function PinSection({
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
    } catch {
      setErr("Enter valid JSON.");
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

function CopyButton({
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
function WebhookInfo({ hookUrls }: { hookUrls: string[] }) {
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

/** Ops whose value is kept as a verbatim string (never numeric-coerced). */
const STRING_OPS = [
  "contains",
  "notContains",
  "startsWith",
  "endsWith",
  "regex",
];

/** Node kinds that call activities / can genuinely fail — the ones "On error" applies to. */
const ERRORABLE_KINDS = new Set<NodeType>([
  "agent",
  "mcpTool",
  "httpRequest",
  "sqlQuery",
  "sqlExec",
  "sendEmail",
  "rssRead",
  "xml",
  "dateTime",
  "code",
  "hmac",
  "jwt",
  "totp",
  "executeSubWorkflow",
  "forEach",
  "pollTrigger",
]);

/** Node kinds whose activity is idempotent-ish enough to safely retry (per-node retry).
 *  Excludes the at-most-once nodes (sqlExec/sendEmail/code) where a retry could double-act. */
const RETRYABLE_KINDS = new Set<NodeType>([
  "agent",
  "mcpTool",
  "httpRequest",
  "sqlQuery",
  "rssRead",
]);

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
    } else if (VALUELESS_OPS.includes(nextOp as EdgeConditionDraft["op"])) {
      // exists / isEmpty / notEmpty carry no value
    } else if (STRING_OPS.includes(nextOp)) {
      c.value = nextVal; // keep verbatim (regex pattern, "42" stays a string)
    } else {
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
      {!VALUELESS_OPS.includes(op) && (
        <Labeled
          label={
            op === "in"
              ? "Values (comma-separated)"
              : op === "regex"
                ? "Pattern (JS regex)"
                : "Value"
          }
        >
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
  allowArray = false,
}: {
  label: string;
  value: unknown;
  placeholder?: string;
  onChange: (v: unknown) => void;
  /** Accept a top-level JSON ARRAY as well as an object (e.g. an integration `json` field
   *  like Notion's block `children`). Default: object-only (mcpTool args, etc.). */
  allowArray?: boolean;
}) {
  const [text, setText] = useState(
    value !== undefined && value !== null ? JSON.stringify(value, null, 2) : "",
  );
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
      const isObject =
        typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
      const isArray = Array.isArray(parsed);
      if (!isObject && !(allowArray && isArray)) {
        setError(
          allowArray
            ? "Must be a JSON object or array"
            : "Must be a JSON object",
        );
        return;
      }
      setError(null);
      onChange(parsed);
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
          fontSize: "var(--text-xs)",
          borderColor: error ? "var(--state-error)" : "var(--line-2)",
        }}
        placeholder={placeholder}
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
          fontSize: "var(--text-xs)",
          borderColor: error ? "var(--state-error)" : "var(--line-2)",
        }}
        placeholder={placeholder}
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
              borderRadius: "var(--radius-md)",
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
                  borderRadius: "var(--radius-sm)",
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
            borderRadius: "var(--radius-md)",
            padding: 8,
            fontSize: "var(--text-xs)",
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
        <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}>
          EDGE
        </div>
        <div style={{ fontWeight: "var(--weight-semibold)" }}>
          Branch condition
        </div>
        <div
          style={{
            fontSize: "var(--text-xs)",
            color: "var(--ink-3)",
            marginTop: 2,
          }}
        >
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

      {!VALUELESS_OPS.includes(c.op) && (
        <Labeled
          label={
            c.op === "in"
              ? "Values (comma-separated)"
              : c.op === "regex"
                ? "Pattern (JS regex)"
                : "Value"
          }
        >
          <input
            value={c.value}
            onChange={(e) => onChange({ value: e.target.value })}
            style={inputStyle}
            placeholder={
              c.op === "in"
                ? "billing, refunds"
                : c.op === "regex"
                  ? "^INV-\\d+$"
                  : "billing"
            }
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
            borderRadius: "var(--radius-sm)",
            border: "1px solid var(--line-2)",
            background: "var(--card)",
            color: "var(--ink-2)",
            cursor: "pointer",
            fontSize: "var(--text-sm)",
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
    <label style={{ display: "block", fontSize: "var(--text-sm)" }}>
      <span style={{ color: "var(--ink-2)" }}>{label}</span>
      <div style={{ marginTop: 4 }}>{children}</div>
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "7px 9px",
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--line-2)",
  background: "var(--card)",
  color: "var(--ink)",
  fontSize: "var(--text-body)",
};
const textareaStyle: React.CSSProperties = {
  ...inputStyle,
  resize: "vertical",
  fontFamily: "var(--font-sans)",
};
const headerInputStyle: React.CSSProperties = {
  padding: "6px 9px",
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--line-2)",
  background: "var(--card)",
  color: "var(--ink)",
  fontSize: "var(--text-body)",
};
