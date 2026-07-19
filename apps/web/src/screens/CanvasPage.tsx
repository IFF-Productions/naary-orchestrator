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
  type ReactFlowInstance,
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
  type TestNodeResult,
  UnauthorizedError,
  type WebhookRow,
} from "../lib/api";
import { compileGraph } from "../lib/compile-graph";
import { decompileGraph } from "../lib/decompile-graph";
import { canSaveWorkflow } from "../lib/permissions-logic";
import {
  nextProgressMessage,
  PROGRESS_MESSAGES,
} from "../lib/progress-messages";
import { PHONE_QUERY, useMediaQuery } from "../lib/useMediaQuery";
import { usePermissions } from "../lib/usePermissions";
import {
  type CanvasNode,
  defaultConfigFor,
  type EdgeConditionDraft,
  NODE_GROUPS,
  NODE_KINDS,
  nodeDisplayLabel,
} from "../lib/graph-model";
import { ConfigPanel } from "./canvas/ConfigPanel";
import { EdgeConfigPanel } from "./canvas/EdgeConfigPanel";
import { CONNECTION_TYPES, headerInputStyle, PROVIDERS } from "./canvas/fields";
import {
  DEFAULT_KEY,
  type FlowEdge,
  isEntryKind,
  type NaaryData,
  NodeActionsContext,
  nodeTypes,
  SEED_EDGES,
  SEED_NODES,
  slugify,
  summarize,
  toFlowEdges,
  toFlowNodes,
} from "./canvas/flow";
import { edgeTypes, type EdgeRunState } from "./canvas/NaaryEdge";
import type { NodeRunState } from "./canvas/NodeCard";
import { OutputInspector } from "./canvas/OutputInspector";
import { clampW, InspectorPanel, ResizeHandle } from "./canvas/InspectorPanel";

/** Client-side record of a single-node test run (the EXISTING test machinery's result
 *  + a measured wall-clock). `stale` marks outputs invalidated by later edits. */
interface NodeTestRun {
  status: "running" | "done" | "error";
  output?: unknown;
  message?: string;
  /** Measured wall-clock of the test call (real, client-side). */
  ms?: number;
  stale?: boolean;
}

/** All node ids reachable downstream of `id` (for stale-marking after an edit). */
function downstreamOf(
  id: string,
  edges: { source: string; target: string }[],
): Set<string> {
  const out = new Set<string>();
  const queue = edges.filter((e) => e.source === id).map((e) => e.target);
  while (queue.length) {
    const n = queue.shift();
    if (!n || out.has(n)) continue;
    out.add(n);
    for (const e of edges) if (e.source === n) queue.push(e.target);
  }
  return out;
}

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
  // Single-node test-run state per nodeId — drives node card colours, the edge
  // animation, and the output inspector. Client-side authoring state only.
  const [nodeRuns, setNodeRuns] = useState<Record<string, NodeTestRun>>({});
  // The most recent successful single-node test — the output drawer keeps showing it
  // while a node WITHOUT output is selected (the drag-to-map flow).
  const [lastTestedId, setLastTestedId] = useState<string | null>(null);
  // The output inspector can be dismissed per selection; reopens on re-select/re-run.
  const [outputClosed, setOutputClosed] = useState(false);
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
  // Playful rotating status while streaming, + how many nodes have landed on the canvas.
  const [genMessage, setGenMessage] = useState<string>(PROGRESS_MESSAGES[0]);
  const [genNodeCount, setGenNodeCount] = useState(0);

  // Rotate the playful message on a ~2.5s timer while generating (no immediate repeat).
  useEffect(() => {
    if (!generating) return;
    setGenMessage((prev) => nextProgressMessage(prev));
    const id = setInterval(
      () => setGenMessage((prev) => nextProgressMessage(prev)),
      2500,
    );
    return () => clearInterval(id);
  }, [generating]);

  // ReactFlow instance (captured via onInit) — CanvasPage renders <ReactFlow>, so it's
  // OUTSIDE the flow provider and can't use useReactFlow; keep a ref for fitView.
  const rfRef = useRef<ReactFlowInstance<Node<NaaryData>, FlowEdge> | null>(
    null,
  );

  // `fitView` (the prop) only fits ONCE at init. While streaming, refit as nodes land so
  // the growing graph stays in frame instead of marching off-screen. Debounced a beat so
  // the just-added node is measured first.
  useEffect(() => {
    if (!generating) return;
    const id = setTimeout(
      () => rfRef.current?.fitView({ duration: 250, padding: 0.25 }),
      70,
    );
    return () => clearTimeout(id);
  }, [nodes, generating]);

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

  // Single-node test runner — the ONE path both the config panel's "Test node" and the
  // per-node ▶ use, so card state / measured duration / output inspector stay in sync.
  // Wraps the existing api.testNode machinery; measures wall-clock client-side (the
  // only duration we honestly have — testNode returns no usage/cost).
  const runNodeTest = useCallback(
    async (nodeId: string, autofill?: boolean): Promise<TestNodeResult> => {
      if (!workflowKey) {
        setStatus(
          "Save the workflow first — node tests run against the saved graph.",
        );
        throw new Error("Workflow not saved yet.");
      }
      const t0 = performance.now();
      setNodeRuns((r) => ({ ...r, [nodeId]: { status: "running" } }));
      setOutputClosed(false);
      try {
        const res = await api.testNode(
          workflowKey,
          nodeId,
          undefined,
          autofill,
        );
        const ms = Math.round(performance.now() - t0);
        setNodeRuns((r) => {
          const next = { ...r };
          if (res.pure) {
            next[nodeId] = { status: "done", output: res.output, ms };
          } else {
            // Not actually executed (activity/control node) — back to idle; the
            // message shows in the config panel, a green "done" would be a lie.
            delete next[nodeId];
          }
          return next;
        });
        if (res.pure) setLastTestedId(nodeId);
        if (!res.pure) setStatus(res.message);
        // Autofill pins upstream nodes server-side — refresh so they show.
        if (autofill) {
          api
            .listPins(workflowKey)
            .then(setPins)
            .catch(() => undefined);
        }
        return res;
      } catch (e) {
        setNodeRuns((r) => ({
          ...r,
          [nodeId]: {
            status: "error",
            message: e instanceof Error ? e.message : "Test failed.",
            ms: Math.round(performance.now() - t0),
          },
        }));
        throw e;
      }
    },
    [workflowKey],
  );

  // The per-node ▶ (node card): run the test and select the node so its output
  // drawer opens on completion. Errors surface on the card + status line.
  const handleNodeRun = useCallback(
    (id: string) => {
      setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === id })));
      setEdges((es) =>
        es.map((e) => (e.selected ? { ...e, selected: false } : e)),
      );
      runNodeTest(id, false).catch(() => undefined);
    },
    [runNodeTest],
  );
  const nodeActions = useMemo(
    () => ({ runNode: handleNodeRun }),
    [handleNodeRun],
  );

  // Load the workflow list (for the selector) + open ?key= if present.
  useEffect(() => {
    let live = true;
    // A different workflow (or a template fork) invalidates all local test-run state.
    setNodeRuns({});
    setLastTestedId(null);
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
          // The initial fitView ran before the graph landed — refit to it.
          setTimeout(
            () => rfRef.current?.fitView({ duration: 250, padding: 0.2 }),
            80,
          );
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
          // The initial fitView ran before the graph landed — refit to it.
          setTimeout(
            () => rfRef.current?.fitView({ duration: 250, padding: 0.2 }),
            80,
          );
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
        // While streaming, the graph is incomplete — dangling-edge / no-reachable-end
        // lint would flash ⚠ badges that read as "broken". Suppress warnings until the
        // authoritative graph lands (they re-appear the moment generation finishes).
        const warning = generating
          ? undefined
          : issuesByNode.get(n.id)?.join("\n");
        // Display run-state (design: card colour = run state). "no-input" (a non-entry
        // node with no inbound edge) wins — it can't run; then live test-run state.
        const run = nodeRuns[n.id];
        const noInput =
          !generating &&
          !isEntryKind(n.data.kind) &&
          !edges.some((e) => e.target === n.id);
        const runState: NodeRunState | undefined = noInput
          ? "no-input"
          : run?.status === "running"
            ? "running"
            : run?.status === "error"
              ? "error"
              : run?.status === "done" && run.output !== undefined
                ? run.stale
                  ? "stale"
                  : "done"
                : undefined;
        const runMs =
          run?.status === "done" && run.output !== undefined
            ? run.ms
            : undefined;
        if (
          (n.data.pinned ?? false) === pinned &&
          n.data.warning === warning &&
          n.data.runState === runState &&
          n.data.runMs === runMs
        ) {
          return n;
        }
        return { ...n, data: { ...n.data, pinned, warning, runState, runMs } };
      }),
    [nodes, pins, issuesByNode, generating, nodeRuns, edges],
  );

  // Edge display state derives from the endpoint nodes' test-run state: a running
  // target animates the ember dashed march; two fresh outputs = a done (green) hop.
  const flowEdges = useMemo(
    () =>
      edges.map((e) => {
        const src = nodeRuns[e.source];
        const tgt = nodeRuns[e.target];
        const fresh = (r?: NodeTestRun) =>
          r?.status === "done" && r.output !== undefined && !r.stale;
        const runState: EdgeRunState =
          tgt?.status === "running"
            ? "active"
            : fresh(src) && fresh(tgt)
              ? "done"
              : "idle";
        if (e.type === "naary" && e.data?.runState === runState) return e;
        return { ...e, type: "naary", data: { ...e.data, runState } };
      }),
    [edges, nodeRuns],
  );

  const selected = nodes.find((n) => n.selected);

  // Output inspector (floating drawer over the canvas): the selected node's REAL
  // output — its last test result, else its pinned sample. When the newly selected
  // node has neither, the LAST test output stays up — that's the drag-to-map loop
  // (test step A with ▷, select step B, drag A's fields into B's parameters).
  const selectedId = selected?.id;
  useEffect(() => {
    setOutputClosed(false);
  }, [selectedId]);
  const freshOutput = (r?: NodeTestRun) =>
    r?.status === "done" && r.output !== undefined;
  let drawerId: string | undefined;
  let drawerSource: "test" | "pin" | undefined;
  if (selectedId && freshOutput(nodeRuns[selectedId])) {
    drawerId = selectedId;
    drawerSource = "test";
  } else if (selectedId && Object.hasOwn(pins, selectedId)) {
    drawerId = selectedId;
    drawerSource = "pin";
  } else if (
    selectedId &&
    lastTestedId &&
    freshOutput(nodeRuns[lastTestedId])
  ) {
    drawerId = lastTestedId;
    drawerSource = "test";
  }
  const drawerNode = drawerId
    ? nodes.find((n) => n.id === drawerId)
    : undefined;
  const drawerRun = drawerId ? nodeRuns[drawerId] : undefined;
  const showOutput = !!drawerNode && !!drawerSource && !outputClosed;

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

  // Mark this node's + all downstream nodes' test outputs stale — their inputs
  // changed, so a green "done" would misrepresent the graph (design: stale state).
  function markStaleFrom(id: string, includeSelf: boolean): void {
    const affected = downstreamOf(id, edges);
    if (includeSelf) affected.add(id);
    setNodeRuns((r) => {
      let changed = false;
      const next = { ...r };
      for (const nid of affected) {
        const run = next[nid];
        if (run && run.status === "done" && !run.stale) {
          next[nid] = { ...run, stale: true };
          changed = true;
        }
      }
      return changed ? next : r;
    });
  }

  // Remove a node + any edges touching it (the modal's Delete button). Removing the
  // node clears the selection, so the inspector modal closes on its own.
  function deleteNode(id: string): void {
    markStaleFrom(id, false);
    setNodes((ns) => ns.filter((n) => n.id !== id));
    setEdges((es) => es.filter((e) => e.source !== id && e.target !== id));
    setNodeRuns((r) => {
      if (!(id in r)) return r;
      const next = { ...r };
      delete next[id];
      return next;
    });
  }
  function deleteEdge(id: string): void {
    const edge = edges.find((e) => e.id === id);
    if (edge) markStaleFrom(edge.target, true);
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
        // Appear animation: scale(.85)+translateY(6px)→1 + a brief ember glow
        // (canvas.css). Mount-once — React Flow keys nodes by id.
        className: "naary-node-enter",
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
    // Editing config invalidates this node's + downstream test outputs.
    markStaleFrom(nodeId, true);
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
  // NEW unsaved draft (same as forking a template — Save persists it). The API-model
  // path STREAMS: each node/edge is drawn live as it's generated (with a fade/scale-in),
  // then the whole canvas is reconciled to the authoritative validated graph on `result`.
  async function generateFromPrompt() {
    const prompt = aiPrompt.trim();
    if (!prompt || generating) return;
    setGenerating(true);
    setGenNodeCount(0);
    setStatus(null);
    setShowAi(false); // reveal the canvas so the workflow appears live as it's built
    // NOTE: we do NOT clear the canvas here — the first streamed node replaces it
    // wholesale (relayout rebuilds from the streamed nodes alone), so an error BEFORE
    // any node arrives leaves the user's current work intact (a transient 429 mustn't
    // wipe the canvas). The prior graph + the pill show during the pre-first-token gap.

    // Live accumulation of the streamed graph (raw GraphDef-shaped nodes/edges).
    type RawNode = GraphDef["nodes"][number];
    type RawEdge = GraphDef["edges"][number];
    const rawNodes: RawNode[] = [];
    const rawEdges: RawEdge[] = [];
    // Keep already-placed node positions STABLE so siblings don't jump as new nodes
    // arrive (the authoritative re-layout happens once, on `result`).
    const placed = new Map<string, { x: number; y: number }>();
    let startId: string | undefined;

    const relayout = () => {
      const known = new Set(rawNodes.map((n) => n.id));
      const partial: GraphDef = {
        startNodeId: startId ?? rawNodes[0]?.id ?? "",
        nodes: rawNodes,
        // Only wire edges whose BOTH endpoints have arrived (React Flow drops dangling ones).
        edges: rawEdges.filter((e) => known.has(e.from) && known.has(e.to)),
      };
      const { nodes: cn, edges: ce } = decompileGraph(partial);
      const stable = cn.map((n) => {
        const pos = placed.get(n.id) ?? n.position;
        placed.set(n.id, pos);
        return { ...n, position: pos };
      });
      // `naary-node-enter` animates each node once on mount (React Flow keys by id, so
      // already-mounted nodes don't replay).
      setNodes(
        toFlowNodes(stable).map((fn) => ({
          ...fn,
          className: "naary-node-enter",
        })),
      );
      setEdges(toFlowEdges(ce));
    };

    try {
      const { name: genName, graph: gen } = await api.generateGraphStream(
        prompt,
        genProvider || undefined,
        {
          onMeta: (nm) => setName(nm),
          onNode: (node) => {
            const n = node as Partial<RawNode> | null;
            if (!n || typeof n.id !== "string" || typeof n.type !== "string")
              return;
            if (rawNodes.some((x) => x.id === n.id)) return; // dedup by id
            if (rawNodes.length === 0) startId = n.id; // provisional entry = first node
            rawNodes.push(n as RawNode);
            setGenNodeCount(rawNodes.length);
            relayout();
          },
          onEdge: (edge) => {
            const e = edge as Partial<RawEdge> | null;
            if (!e || typeof e.from !== "string" || typeof e.to !== "string")
              return;
            const dup = rawEdges.some(
              (x) =>
                x.from === e.from &&
                x.to === e.to &&
                JSON.stringify(x.condition) === JSON.stringify(e.condition),
            );
            if (dup) return;
            rawEdges.push(e as RawEdge);
            relayout();
          },
        },
      );
      // Reconcile to the authoritative validated graph — final positions + wiring, no
      // enter-animation className (the nodes are already mounted).
      const { nodes: cn, edges: ce } = decompileGraph(gen);
      setNodes(toFlowNodes(cn));
      setEdges(toFlowEdges(ce));
      setName(genName);
      setWorkflowKey(""); // now a NEW unsaved draft (only after a successful generation)
      if (keyParam || templateParam) setSearchParams({}, { replace: true });
      setStatus("Generated — review, edit, and Save to keep it.");
      // The generating effect stops refitting once `generating` flips false (same render
      // as this reconcile), so fit to the final graph explicitly.
      setTimeout(
        () => rfRef.current?.fitView({ duration: 300, padding: 0.2 }),
        80,
      );
    } catch (e) {
      setStatus(
        e instanceof Error ? e.message : "Couldn't generate a workflow.",
      );
    } finally {
      setGenerating(false);
      setGenNodeCount(0);
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
          padding: "10px 16px",
          borderBottom: "1px solid var(--line)",
          background: "var(--panel)",
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
        <span
          style={{
            display: "inline-flex",
            alignItems: "baseline",
            gap: 6,
            minWidth: 0,
          }}
        >
          <span
            className="mono"
            style={{
              fontSize: "var(--text-2xs)",
              fontWeight: "var(--weight-semibold)",
              letterSpacing: "var(--tracking-label)",
              textTransform: "uppercase",
              color: "var(--ink-3)",
            }}
          >
            key
          </span>
          <span
            className="mono"
            style={{ fontSize: "var(--text-xs)", color: "var(--ink-2)" }}
          >
            {activeKey}
          </span>
        </span>

        {/* While streaming the graph is incomplete — showing "invalid/disconnected" (and
            the issue count) would read as broken. Show a neutral "building…" pill instead;
            real validity returns the instant generation finishes. */}
        <StatusPill
          state={generating ? "running" : graph ? "done" : "error"}
          label={
            generating ? "building…" : graph ? "valid" : (error ?? "invalid")
          }
        />
        {!generating && allIssues.length > 0 && (
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
            background: "var(--panel)",
            borderRight: "1px solid var(--line)",
            display: "flex",
            flexDirection: "column",
            gap: 8,
            minHeight: 0,
          }}
        >
          <div
            className="mono"
            style={{
              fontSize: "var(--text-2xs)",
              fontWeight: "var(--weight-semibold)",
              letterSpacing: "var(--tracking-label)",
              textTransform: "uppercase",
              color: "var(--ink-3)",
              marginBottom: 2,
            }}
          >
            Add node
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
                    className="mono"
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

        {/* canvas — ambient warm wash + dotted grid; the output drawer floats over it */}
        <div
          style={
            canvasFullscreen
              ? {
                  position: "fixed",
                  inset: 0,
                  zIndex: 1000,
                  background:
                    "radial-gradient(120% 90% at 20% 0%, var(--grad-a), var(--bg) 60%)",
                }
              : {
                  flex: 1,
                  minWidth: 0,
                  position: "relative",
                  background:
                    "radial-gradient(120% 90% at 20% 0%, var(--grad-a), var(--bg) 60%)",
                }
          }
        >
          <NodeActionsContext.Provider value={nodeActions}>
            <ReactFlow
              nodes={flowNodes}
              edges={flowEdges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onInit={(inst) => {
                rfRef.current = inst;
              }}
              fitView
            >
              <Background gap={26} size={1.1} />
              <Controls />
              {generating && (
                <Panel position="top-center">
                  <div
                    className="naary-gen-pill"
                    role="status"
                    aria-live="polite"
                  >
                    <span className="naary-gen-spinner" aria-hidden="true" />
                    <span key={genMessage} className="naary-gen-msg">
                      {genMessage}
                    </span>
                    {genNodeCount > 0 && (
                      <span className="naary-gen-count">
                        {genNodeCount} node{genNodeCount === 1 ? "" : "s"}
                      </span>
                    )}
                  </div>
                </Panel>
              )}
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
          </NodeActionsContext.Provider>

          {/* floating output inspector — an absolute overlay, never pushes the canvas */}
          {showOutput && drawerNode && drawerSource && (
            <OutputInspector
              key={drawerNode.id}
              nodeId={drawerNode.id}
              title={nodeDisplayLabel(
                drawerNode.data.kind,
                drawerNode.data.config,
              )}
              output={
                drawerSource === "test"
                  ? drawerRun?.output
                  : pins[drawerNode.id]
              }
              source={drawerSource}
              runMs={drawerSource === "test" ? drawerRun?.ms : undefined}
              stale={drawerSource === "test" ? drawerRun?.stale : undefined}
              canPin={!!workflowKey}
              isPinned={Object.hasOwn(pins, drawerNode.id)}
              onPin={() => {
                if (drawerRun?.output !== undefined)
                  void pinNode(drawerNode.id, drawerRun.output);
              }}
              onClose={() => setOutputClosed(true)}
            />
          )}
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
                /* naary-drop-scope: while a field row is dragged from the output
                   inspector, the expression inputs inside highlight (canvas.css). */
                <div className="naary-drop-scope">
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
                    // The shared single-node test runner — also drives the node
                    // card state + the floating output inspector.
                    onTest={(autofill) => runNodeTest(selected.id, autofill)}
                    onChange={(patch) => updateConfig(selected.id, patch)}
                  />
                </div>
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
