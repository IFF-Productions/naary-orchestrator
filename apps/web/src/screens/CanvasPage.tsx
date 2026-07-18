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
import "./canvas.css";
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  type Connection,
  Controls,
  type Node,
  Panel,
  ReactFlow,
} from "@xyflow/react";
import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  lintBindings,
  lintTemplates,
  validateIntegrationConfig,
  type GraphDef,
  type NodeType,
} from "@naary/dsl";
import { Button, Icon, StatusPill } from "../components";
import { ExpressionField } from "../components/ExpressionField";
import {
  api,
  type ConnectionRow,
  type GraphSummary,
  UnauthorizedError,
  type WebhookRow,
} from "../lib/api";
import { compileGraph } from "../lib/compile-graph";
import { decompileGraph } from "../lib/decompile-graph";
import { canSaveWorkflow } from "../lib/permissions-logic";
import { PHONE_QUERY, useMediaQuery } from "../lib/useMediaQuery";
import { usePermissions } from "../lib/usePermissions";
import {
  type CanvasNode,
  defaultConfigFor,
  type EdgeConditionDraft,
  NODE_GROUPS,
  NODE_KINDS,
} from "../lib/graph-model";
import { ConfigPanel } from "./canvas/ConfigPanel";
import { EdgeConfigPanel } from "./canvas/EdgeConfigPanel";
import { CONNECTION_TYPES, headerInputStyle, PROVIDERS } from "./canvas/fields";
import {
  DEFAULT_KEY,
  type FlowEdge,
  type NaaryData,
  nodeTypes,
  SEED_EDGES,
  SEED_NODES,
  slugify,
  summarize,
  toFlowEdges,
  toFlowNodes,
} from "./canvas/flow";
import { clampW, InspectorPanel, ResizeHandle } from "./canvas/InspectorPanel";

export function CanvasPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [nodes, setNodes] = useState<Node<NaaryData>[]>(SEED_NODES);
  const [edges, setEdges] = useState<FlowEdge[]>(SEED_EDGES);
  // Stable node-id → kind map for the ExpressionField autocomplete fallback. Memoized so it
  // doesn't get a new identity every render (which would bust the field's `refs` memo).
  const nodeKinds = useMemo(
    () => Object.fromEntries(nodes.map((n) => [n.id, n.data.kind])),
    [nodes],
  );
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [name, setName] = useState("Canvas draft");
  const [paletteQuery, setPaletteQuery] = useState("");
  // Hidden file input backing the "Import" button (a graph JSON → canvas draft).
  const importInputRef = useRef<HTMLInputElement>(null);
  // Drag-resizable side panels (palette + node inspector). Widths persist per browser.
  const panelsRowRef = useRef<HTMLDivElement>(null);
  const [paletteWidth, setPaletteWidth] = useState(
    () => Number(localStorage.getItem("naary.paletteW")) || 180,
  );
  const [inspectorWidth, setInspectorWidth] = useState(
    () => Number(localStorage.getItem("naary.inspectorW")) || 440,
  );
  // On phone the palette + a 440px inspector don't fit a ~375px viewport — clamp the palette and
  // let the inspector take the full width (an overlay over the canvas) so node editing is usable.
  const phone = useMediaQuery(PHONE_QUERY);
  const effPaletteWidth = phone ? Math.min(paletteWidth, 132) : paletteWidth;
  // Full-screen the graph (palette + inspector hidden) for a focused, roomy edit. CSS overlay,
  // Esc to exit — same approach as RunDiagram.
  const [canvasFullscreen, setCanvasFullscreen] = useState(false);
  useEffect(() => {
    if (!canvasFullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCanvasFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canvasFullscreen]);
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

  // Affordance gating (RBAC-GROUPS G2): saving an EXISTING key needs `edit` on it, a NEW
  // key needs `create`. Disabled-not-hidden (with a tooltip) so the state is explainable;
  // the API enforces regardless — a forced request still 403s.
  const perms = usePermissions();
  const keyExists = workflows.some((w) => w.workflowKey === activeKey);
  const maySave = canSaveWorkflow(perms, activeKey, keyExists);
  const saveDeniedTitle = keyExists
    ? "You don't have edit permission on this workflow"
    : "You don't have permission to create workflows in this environment";

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
      const { name: genName, graph: gen } = await api.generateGraphStream(
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

  // Export the current (valid) graph as a portable JSON file — the same GraphDef the API
  // stores, wrapped with the display name so an import round-trips. Invalid graphs can't be
  // exported (nothing runnable to serialize) — the reason is surfaced instead.
  function exportGraph() {
    if (!graph) {
      setStatus(error ?? "Fix the graph's issues before exporting.");
      return;
    }
    // One resolved name drives the payload name AND the status message (they always match).
    // The FILENAME is its slug — a filesystem-safe form that can differ from the display name
    // (e.g. "My Flow" → my-flow.json, or "---" → the DEFAULT_KEY fallback), which is expected.
    const exportName = name.trim() || "workflow";
    const exportSlug = slugify(exportName);
    const payload = { naaryFlow: 1, name: exportName, graph };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${exportSlug}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Defer revocation — revoking synchronously can cancel the download in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 0);
    setStatus(`Exported "${exportName}".`);
  }

  // Import a graph JSON (raw GraphDef or a { name, graph } export) as a NEW unsaved draft —
  // mirrors the generate/template path (decompile → editable flow), so Save persists a new
  // workflow rather than overwriting whatever was open.
  function importFromFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // let the same file be re-picked later
    if (!file) return;
    const reader = new FileReader();
    reader.onerror = () =>
      setStatus("Import failed — the file couldn't be read.");
    reader.onload = () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(reader.result));
      } catch {
        setStatus("Import failed — the file isn't valid JSON.");
        return;
      }
      const wrapper =
        parsed && typeof parsed === "object"
          ? (parsed as Record<string, unknown>)
          : {};
      const gd = ("graph" in wrapper ? wrapper.graph : parsed) as {
        nodes?: unknown;
        edges?: unknown;
        startNodeId?: unknown;
      };
      // decompileGraph maps graph.nodes AND graph.edges → both must be arrays, plus a start id.
      if (
        !gd ||
        typeof gd !== "object" ||
        !Array.isArray(gd.nodes) ||
        !Array.isArray(gd.edges) ||
        typeof gd.startNodeId !== "string"
      ) {
        setStatus(
          "Import failed — not a Naary graph (needs nodes[], edges[], startNodeId).",
        );
        return;
      }
      try {
        const { nodes: cn, edges: ce } = decompileGraph(gd as GraphDef);
        setNodes(toFlowNodes(cn));
        setEdges(toFlowEdges(ce));
      } catch {
        setStatus(
          "Import failed — the graph couldn't be loaded onto the canvas.",
        );
        return;
      }
      // Resolve the applied name ONCE (wrapper name → filename → fallback) so the name set on
      // state and the name shown in the status message can't diverge on an empty edge case.
      const fromWrapper =
        typeof wrapper.name === "string" && wrapper.name.trim()
          ? wrapper.name
          : file.name.replace(/\.json$/i, "");
      const appliedName = fromWrapper.trim() || "Imported workflow";
      setName(appliedName);
      setWorkflowKey("");
      if (keyParam || templateParam) setSearchParams({}, { replace: true });
      setStatus(`Imported "${appliedName}" — review, then Save to keep it.`);
    };
    reader.readAsText(file);
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
          // Wrap on narrow screens so the toolbar can't force the page wider than the viewport
          // (a non-wrapping row of buttons was overflowing horizontally on phone/tablet).
          flexWrap: "wrap",
          gap: 10,
          rowGap: 8,
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

        <StatusPill
          state={graph ? "done" : "error"}
          label={graph ? "valid" : (error ?? "invalid")}
        />
        {allIssues.length > 0 && (
          <button
            type="button"
            onClick={() => setShowIssues((s) => !s)}
            title="Show details of every issue"
            className={`pill ${resourceWarnings.length > 0 ? "pill-error" : "pill-paused"}`}
            style={{ border: "none", cursor: "pointer" }}
          >
            ⚠ {allIssues.length} issue{allIssues.length > 1 ? "s" : ""}{" "}
            {showIssues ? "▲" : "▼"}
          </button>
        )}
        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            flexWrap: "wrap",
            gap: 10,
          }}
        >
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
          {/* Import a graph JSON as a new draft; export the current valid graph to a file. */}
          <input
            ref={importInputRef}
            type="file"
            accept="application/json,.json"
            style={{ display: "none" }}
            onChange={importFromFile}
          />
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => importInputRef.current?.click()}
            title="Load a graph JSON as a new draft"
          >
            Import
          </Button>
          <Button
            variant="secondary"
            disabled={busy || !graph}
            onClick={exportGraph}
            title="Download this graph as JSON"
          >
            Export
          </Button>
          <Button
            variant="secondary"
            disabled={busy || !graph || !maySave}
            title={maySave ? undefined : saveDeniedTitle}
            onClick={() => void saveOnly()}
          >
            Save
          </Button>
          <Button
            variant="primary"
            disabled={busy || !graph || !maySave}
            title={maySave ? undefined : saveDeniedTitle}
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
            width: effPaletteWidth,
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
        <div
          style={
            canvasFullscreen
              ? {
                  position: "fixed",
                  inset: 0,
                  zIndex: 1000,
                  background: "var(--bg)",
                }
              : { flex: 1, minWidth: 0 }
          }
        >
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
            <Panel position="top-right">
              <button
                type="button"
                className="rf-fs-btn"
                onClick={() => setCanvasFullscreen((v) => !v)}
                aria-label={
                  canvasFullscreen ? "Exit full screen" : "Full screen"
                }
                title={
                  canvasFullscreen ? "Exit full screen (Esc)" : "Full screen"
                }
              >
                <Icon name={canvasFullscreen ? "x" : "expand"} size={15} />
              </button>
            </Panel>
          </ReactFlow>
        </div>

        {/* node / edge editor — a docked, drag-resizable side panel (right) */}
        {(selected || selectedEdge) && (
          <>
            {!phone && (
              <ResizeHandle
                onResize={(clientX) => {
                  const r = panelsRowRef.current?.getBoundingClientRect();
                  if (r) setInspectorWidth(clampW(r.right - clientX, 320, 760));
                }}
              />
            )}
            <InspectorPanel
              title={selected ? "Edit node" : "Edit branch condition"}
              width={inspectorWidth}
              phone={phone}
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
                  edges={edges}
                  nodeKinds={nodeKinds}
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
