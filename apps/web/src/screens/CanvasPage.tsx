/**
 * The workflow canvas: a drag-and-drop editor (react-flow) that compiles to the
 * platform GraphDef and runs it. Closes the core loop — author visually → save →
 * durable execution.
 *
 * Layout (redesign: Canvas Authoring Loop, three-pane):
 *   56px top bar (flame · name · key/version · env chip · run-cap · actions)
 *   → 60px icon-only category rail · canvas (dot grid + ambient wash + hint pill)
 *   · 492px inspector dock (selected node's header/actions/input-data/parameters/
 *   output-logs; a selected edge overlays it with the Connection inspector).
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
import { Button, Icon } from "../components";
import {
  api,
  type BudgetView,
  type ConnectionRow,
  type Environment,
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
import { useActiveEnvironment } from "../lib/useActiveEnvironment";
import { usePermissions } from "../lib/usePermissions";
import {
  type CanvasNode,
  defaultConfigFor,
  type EdgeConditionDraft,
  NODE_KINDS,
  nodeDisplayLabel,
} from "../lib/graph-model";
import { envAccent } from "../workspace/EnvironmentSwitcher";
import { CATALOG, type CatalogEntry } from "./app/catalog/catalog-data";
import { CategoryRail } from "./canvas/CategoryRail";
import { CatalogModal } from "./canvas/CatalogModal";
import { ConfigPanel } from "./canvas/ConfigPanel";
import { EdgeInspector } from "./canvas/EdgeInspector";
import { CONNECTION_TYPES, PROVIDERS } from "./canvas/fields";
import {
  type DockInputRow,
  type DockRoutingRow,
  InspectorDock,
} from "./canvas/InspectorDock";
import {
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
import { flattenOutput } from "./canvas/output-fields";
import { CanvasTopBar } from "./canvas/TopBar";

/** Client-side record of a single-node test run (the EXISTING test machinery's result
 *  + a measured wall-clock). `stale` marks outputs invalidated by later edits. */
interface NodeTestRun {
  status: "running" | "done" | "error";
  output?: unknown;
  message?: string;
  /** Measured wall-clock of the test call (real, client-side). */
  ms?: number;
  stale?: boolean;
  /** Client timestamp the test started — the dock's live elapsed readout. */
  startedAt?: number;
}

/** Bottom-right toast (offset left of the dock so it never hides under it). */
interface CanvasToast {
  id: number;
  text: string;
  meta?: string;
  tone: "ok" | "warn";
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

/** All node ids upstream of `id` (BFS, nearest first) — the dock's INPUT DATA. */
function upstreamOf(
  id: string,
  edges: { source: string; target: string }[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>([id]);
  const queue = edges.filter((e) => e.target === id).map((e) => e.source);
  while (queue.length) {
    const n = queue.shift();
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
    for (const e of edges) if (e.target === n) queue.push(e.source);
  }
  return out;
}

/** Breakpoint where the docked 492px inspector overlays instead of squeezing the canvas. */
const NARROW_QUERY = "(max-width: 1080px)";

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
  // Saved version of the open workflow (null = unsaved draft) — the top bar meta.
  const [version, setVersion] = useState<number | null>(null);
  // Hidden file input backing the overflow menu's "Import" (a graph JSON → canvas draft).
  const importInputRef = useRef<HTMLInputElement>(null);
  // Phone keeps the full-screen inspector sheet; narrow overlays the dock over the canvas.
  const phone = useMediaQuery(PHONE_QUERY);
  const narrow = useMediaQuery(NARROW_QUERY);
  // Full-screen the graph (rail + dock hidden) for a focused, roomy edit. CSS overlay,
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
  // The saved workflowKey (empty until first save of a NEW workflow → slug(name)).
  const [workflowKey, setWorkflowKey] = useState("");
  const [workflows, setWorkflows] = useState<GraphSummary[]>([]);
  const [webhooks, setWebhooks] = useState<WebhookRow[]>([]);
  // Tenant connections (DBs, MCP servers, SMTP, signing) so a node's config can PICK one
  // by label instead of pasting a raw connectionId.
  const [connections, setConnections] = useState<ConnectionRow[]>([]);
  // Per-workspace environments + budget policy — the top bar's env chip and RUN CAP
  // (both REAL: the active environment and the configured per-execution cap only).
  const [envs, setEnvs] = useState<Environment[]>([]);
  const [budget, setBudget] = useState<BudgetView | null>(null);
  const activeEnvSlug = useActiveEnvironment();
  // Pinned node outputs (authoring samples) for the saved workflow, keyed by nodeId.
  const [pins, setPins] = useState<Record<string, unknown>>({});
  // Single-node test-run state per nodeId — drives node card colours, the edge
  // animation, and the dock's output/logs. Client-side authoring state only.
  const [nodeRuns, setNodeRuns] = useState<Record<string, NodeTestRun>>({});
  // Optional per-run input (JSON) — overrides the Start node's sampleInput for the
  // next run. Blank ⇒ the server falls back to the sample (api.startExecution).
  const [showInput, setShowInput] = useState(false);
  const [runInput, setRunInput] = useState("");
  // Whether the issues panel (lint warnings + missing resources) is expanded.
  const [showIssues, setShowIssues] = useState(false);
  // The full catalog modal (the rail's dashed "+").
  const [catalogOpen, setCatalogOpen] = useState(false);
  // Bottom-right toasts (offset left of the dock).
  const [toasts, setToasts] = useState<CanvasToast[]>([]);
  const toastSeq = useRef(0);
  const toastTimers = useRef<number[]>([]);
  useEffect(() => {
    const pending = toastTimers.current;
    return () => pending.forEach(clearTimeout);
  }, []);
  const pushToast = useCallback(
    (text: string, meta?: string, tone: "ok" | "warn" = "ok") => {
      const id = ++toastSeq.current;
      setToasts((t) => [...t, { id, text, meta, tone }]);
      toastTimers.current.push(
        window.setTimeout(
          () => setToasts((t) => t.filter((x) => x.id !== id)),
          2600,
        ),
      );
    },
    [],
  );
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

  // Registered webhook endpoints, tenant connections, environments and the budget
  // policy (a webhookTrigger node shows its hook URL; connection-based nodes pick a
  // connection by label; the top bar shows the active env + the real run cap).
  useEffect(() => {
    let live = true;
    api
      .getMe()
      .then((me) =>
        Promise.all([
          api.listWebhooks(me.tenantId).catch(() => [] as WebhookRow[]),
          api.listConnections(me.tenantId).catch(() => [] as ConnectionRow[]),
          api.listEnvironments(me.tenantId).catch(() => [] as Environment[]),
          api.getBudget(me.tenantId).catch(() => null),
        ]),
      )
      .then(([ws, conns, es, b]) => {
        if (!live) return;
        setWebhooks(ws);
        setConnections(conns);
        setEnvs(es);
        setBudget(b);
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

  // Single-node test runner — the ONE path the dock's "Test step", the config panel's
  // "Test node" and the per-node ▶ all use, so card state / measured duration / the
  // dock's output stay in sync. Wraps the existing api.testNode machinery; measures
  // wall-clock client-side (the only duration we honestly have).
  const runNodeTest = useCallback(
    async (nodeId: string, autofill?: boolean): Promise<TestNodeResult> => {
      if (!workflowKey) {
        setStatus(
          "Save the workflow first — node tests run against the saved graph.",
        );
        throw new Error("Workflow not saved yet.");
      }
      const t0 = performance.now();
      setNodeRuns((r) => ({
        ...r,
        [nodeId]: { status: "running", startedAt: Date.now() },
      }));
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
  // shows in the dock on completion. Errors surface on the card + status line.
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

  // Mark this node's + all downstream nodes' test outputs stale — their inputs
  // changed, so a green "done" would misrepresent the graph (design: stale state).
  const markStaleFrom = useCallback(
    (id: string, includeSelf: boolean): void => {
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
    },
    [edges],
  );

  // Remove a node + any edges touching it (dock trash + the card's ✕). Removing
  // the node clears the selection, so the dock returns to its empty state.
  const deleteNode = useCallback(
    (id: string): void => {
      markStaleFrom(id, false);
      setNodes((ns) => ns.filter((n) => n.id !== id));
      setEdges((es) => es.filter((e) => e.source !== id && e.target !== id));
      setNodeRuns((r) => {
        if (!(id in r)) return r;
        const next = { ...r };
        delete next[id];
        return next;
      });
    },
    [markStaleFrom],
  );

  const nodeActions = useMemo(
    () => ({ runNode: handleNodeRun, deleteNode }),
    [handleNodeRun, deleteNode],
  );

  // Load the workflow list (for the switcher) + open ?key= if present.
  useEffect(() => {
    let live = true;
    // A different workflow (or a template fork) invalidates all local test-run state.
    setNodeRuns({});
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
          setVersion(null);
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
          setVersion(g.version);
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

  // node id → its issue lines (for the ⚠ tooltip on the node badge + dock banner).
  const issuesByNode = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const it of allIssues) {
      const line = it.field ? `${it.field}: ${it.message}` : it.message;
      m.set(it.nodeId, [...(m.get(it.nodeId) ?? []), line]);
    }
    return m;
  }, [allIssues]);

  // Display run-state of a node (design: card colour = run state). "no-input" (a
  // non-entry node with no inbound edge) wins — it can't run; then live test state.
  const runStateFor = useCallback(
    (n: Node<NaaryData>): NodeRunState | undefined => {
      const run = nodeRuns[n.id];
      const noInput =
        !generating &&
        !isEntryKind(n.data.kind) &&
        !edges.some((e) => e.target === n.id);
      return noInput
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
    },
    [nodeRuns, generating, edges],
  );

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
        const run = nodeRuns[n.id];
        const runState = runStateFor(n);
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
    [nodes, pins, issuesByNode, generating, nodeRuns, runStateFor],
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
  const selectedEdge = edges.find((e) => e.selected);
  const selectedRun = selected ? nodeRuns[selected.id] : undefined;
  const selectedState: NodeRunState = selected
    ? (runStateFor(selected) ?? "idle")
    : "idle";
  const selectedFreshOutput =
    selectedRun?.status === "done" && selectedRun.output !== undefined;

  // Jump to a node from the issues panel: select it (opens the dock) and clear other selection.
  function selectNode(id: string): void {
    setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === id })));
    setEdges((es) =>
      es.map((e) => (e.selected ? { ...e, selected: false } : e)),
    );
    setShowIssues(true);
  }

  // Webhook endpoint URLs registered for THIS workflow (shown in the webhook node).
  // The full, invokable URL: the hooks ingress lives at /hooks/:id on the API, reachable
  // through the same /api proxy the app uses (nginx rewrites /api/hooks/… → /hooks/…).
  const hookUrls = webhooks
    .filter((w) => workflowKey && w.workflowId === workflowKey)
    .map((w) => `${window.location.origin}/api/hooks/${w.id}`);

  // Clear the react-flow selection (dock → empty state; edge overlay closes).
  const closeInspector = useCallback((): void => {
    setNodes((ns) =>
      ns.map((n) => (n.selected ? { ...n, selected: false } : n)),
    );
    setEdges((es) =>
      es.map((e) => (e.selected ? { ...e, selected: false } : e)),
    );
  }, []);

  // Esc clears the selection (the old inspector panel's behavior, kept).
  useEffect(() => {
    if (!selected && !selectedEdge) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeInspector();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, selectedEdge, closeInspector]);

  function deleteEdge(id: string): void {
    const edge = edges.find((e) => e.id === id);
    if (edge) markStaleFrom(edge.target, true);
    setEdges((es) => es.filter((e) => e.id !== id));
  }

  const addNode = useCallback(
    (kind: NodeType, preset?: Record<string, unknown>) => {
      const id = `${kind}-${crypto.randomUUID().slice(0, 8)}`;
      // Drop in with working example config (single source: the node registry), so a
      // non-technical user sees filled-in fields — and a node they never open still runs.
      // A catalog tile may pass its own preset (e.g. GitHub vs Jira, both `integration`).
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
    },
    [],
  );

  // Add a catalog entry (rail popover / catalog modal / ?add= deep link): resolve the
  // palette's working example config for it (provider tiles carry their provider preset).
  const addEntry = useCallback(
    (entry: CatalogEntry) => {
      const kindDef = entry.provider
        ? NODE_KINDS.find(
            (k) =>
              k.type === "integration" &&
              (k.defaultConfig as { provider?: string } | undefined)
                ?.provider === entry.provider,
          )
        : NODE_KINDS.find((k) => k.type === entry.nodeType);
      addNode(entry.nodeType, kindDef?.defaultConfig);
      pushToast(entry.name, "added to canvas");
    },
    [addNode, pushToast],
  );

  // ?add=<type>[&provider=…] deep link (the /app/catalog "Add" flow): drop the node
  // on the canvas, then strip the params so a refresh doesn't add it again.
  const addParam = searchParams.get("add");
  const providerParam = searchParams.get("provider");
  useEffect(() => {
    if (!addParam) return;
    const entry =
      CATALOG.find((e) =>
        providerParam
          ? e.id === `${addParam}:${providerParam}`
          : e.id === addParam,
      ) ?? CATALOG.find((e) => e.nodeType === addParam);
    if (entry) addEntry(entry);
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("add");
        next.delete("provider");
        return next;
      },
      { replace: true },
    );
  }, [addParam, providerParam, addEntry, setSearchParams]);

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
    setVersion(null);
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
      setVersion(null);
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
      setVersion(null);
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
    const saved = await api.saveGraph(
      key,
      name.trim() || "Untitled workflow",
      graph,
    );
    setWorkflowKey(key);
    setVersion(saved.version);
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

  /* ---------------- dock derivations ---------------- */

  const nodeLabelOf = useCallback(
    (id: string): string => {
      const n = nodes.find((x) => x.id === id);
      return n ? nodeDisplayLabel(n.data.kind, n.data.config) : id;
    },
    [nodes],
  );

  // INPUT DATA: the selected node's REAL available inputs — every upstream node's
  // fresh test output, else its pinned sample. Source tag = the node's name; pinned
  // samples are tagged "pinned" (per the design comp).
  const dockInputRows = useMemo((): DockInputRow[] => {
    if (!selected) return [];
    const rows: DockInputRow[] = [];
    for (const uid of upstreamOf(selected.id, edges)) {
      const run = nodeRuns[uid];
      const fresh =
        run?.status === "done" && run.output !== undefined && !run.stale;
      const src = fresh
        ? run.output
        : Object.hasOwn(pins, uid)
          ? pins[uid]
          : undefined;
      if (src === undefined) continue;
      const tag = fresh ? nodeLabelOf(uid) : "pinned";
      for (const f of flattenOutput(src, "", 0, [], 8)) {
        rows.push({
          key: `${uid}.${f.path}`,
          token: `{{ ${uid}.${f.path} }}`,
          path: f.path,
          preview: f.preview,
          tag,
        });
        if (rows.length >= 40) return rows;
      }
    }
    return rows;
  }, [selected, edges, nodeRuns, pins, nodeLabelOf]);

  // ROUTING RULES read-view (switch/if) — derived from the REAL config + edges.
  // Switch: rules run top-to-bottom (first match wins) and set `<id>.matched`;
  // MATCHED/SKIPPED badges appear only when a real test output states which rule
  // matched. If: each outgoing edge is its own branch (every matching edge fires).
  const dockRouting = useMemo((): {
    rows: DockRoutingRow[];
    title: string;
    note: string;
  } | null => {
    if (!selected) return null;
    const kind = selected.data.kind;
    if (kind !== "switch" && kind !== "if") return null;
    const outs = edges.filter((e) => e.source === selected.id);
    const fmt = (c?: {
      path?: string;
      op?: string;
      value?: unknown;
    }): string => {
      if (!c?.path?.trim()) return "always";
      if (c.op === "exists") return `${c.path} exists`;
      const v = typeof c.value === "string" ? c.value : JSON.stringify(c.value);
      return `${c.path} ${c.op ?? "eq"} ${v ?? ""}`.trim();
    };
    if (kind === "if") {
      if (outs.length === 0) return null;
      return {
        rows: outs.map((e, i) => ({
          n: i + 1,
          cond: fmt(e.data?.condition),
          target: nodeLabelOf(e.target),
        })),
        title: "Branches · every matching edge fires",
        note: "Each outgoing edge is taken when its condition holds; unconditional edges always fire.",
      };
    }
    // switch — rules from the node's real config; targets from real edges that
    // branch on `matched eq <name>`.
    const cfg = selected.data.config ?? {};
    const rules =
      (cfg.rules as
        | {
            name?: string;
            condition?: { path?: string; op?: string; value?: unknown };
          }[]
        | undefined) ?? [];
    if (rules.length === 0) return null;
    const fallback =
      typeof cfg.fallback === "string" ? cfg.fallback : "default";
    const run = nodeRuns[selected.id];
    const out =
      run?.status === "done" && !run.stale && run.output
        ? (run.output as Record<string, unknown>)
        : undefined;
    const matched =
      out && typeof out.matched === "string" ? out.matched : undefined;
    const targetFor = (ruleName?: string): string | undefined => {
      if (!ruleName) return undefined;
      const e = outs.find((x) => {
        const c = x.data?.condition;
        return (
          c &&
          /(^|\.)matched$/.test(c.path ?? "") &&
          c.op === "eq" &&
          String(c.value) === ruleName
        );
      });
      return e ? nodeLabelOf(e.target) : undefined;
    };
    const badge = (ruleName: string): "matched" | "skipped" | undefined =>
      matched === undefined
        ? undefined
        : matched === ruleName
          ? "matched"
          : "skipped";
    const rows: DockRoutingRow[] = rules.map((r, i) => ({
      n: i + 1,
      cond: fmt(r.condition),
      target: targetFor(r.name),
      badge: r.name ? badge(r.name) : undefined,
    }));
    rows.push({
      n: rules.length + 1,
      cond: `else (${fallback})`,
      target: targetFor(fallback),
      badge: badge(fallback),
    });
    return {
      rows,
      title: "Routing rules · first match wins",
      note: `The first matching rule sets ${selected.id}.matched to its name; outgoing edges branch on it (matched eq <name>).`,
    };
  }, [selected, edges, nodeRuns, nodeLabelOf]);

  // Edge (Connection) inspector — overlays the dock when an edge is selected.
  const edgeOverlay = selectedEdge ? (
    <EdgeInspector
      key={selectedEdge.id}
      sourceLabel={nodeLabelOf(selectedEdge.source)}
      targetLabel={nodeLabelOf(selectedEdge.target)}
      condition={selectedEdge.data?.condition}
      onChange={(patch) => updateEdgeCondition(selectedEdge.id, patch)}
      onClear={() => clearEdgeCondition(selectedEdge.id)}
      onDelete={() => {
        deleteEdge(selectedEdge.id);
        pushToast(
          "Edge removed",
          `${nodeLabelOf(selectedEdge.target)} may need a new input`,
          "warn",
        );
      }}
      onClose={closeInspector}
    />
  ) : undefined;

  // On narrow viewports the dock overlays the canvas — render it only when there's
  // a selection; desktop keeps the persistent 492px column (empty state otherwise).
  const dockFloating = phone || narrow;
  const showDock = dockFloating ? Boolean(selected || selectedEdge) : true;

  const dock = showDock ? (
    <InspectorDock
      key={selected?.id ?? "empty"}
      nodeId={selected?.id}
      kind={selected?.data.kind}
      title={
        selected
          ? nodeDisplayLabel(selected.data.kind, selected.data.config)
          : undefined
      }
      state={selectedState}
      run={selectedRun}
      isPinned={selected ? Object.hasOwn(pins, selected.id) : false}
      pinnedOutput={selected ? pins[selected.id] : undefined}
      canPin={!!workflowKey}
      warnings={
        selected && !generating ? issuesByNode.get(selected.id) : undefined
      }
      routing={dockRouting?.rows}
      routingTitle={dockRouting?.title}
      routingNote={dockRouting?.note}
      inputRows={dockInputRows}
      parameters={
        selected ? (
          <ConfigPanel
            key={selected.id}
            node={selected}
            hideHeader
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
            // The shared single-node test runner — also drives the node card
            // state + the dock's output tab.
            onTest={(autofill) => runNodeTest(selected.id, autofill)}
            onChange={(patch) => updateConfig(selected.id, patch)}
          />
        ) : undefined
      }
      onTest={
        selected
          ? () => runNodeTest(selected.id, false).catch(() => undefined)
          : undefined
      }
      onPin={
        selected && selectedFreshOutput
          ? () => {
              void pinNode(selected.id, selectedRun?.output).then(() =>
                pushToast("Pinned as sample data", selected.id),
              );
            }
          : undefined
      }
      onUnpin={selected ? () => void unpinNode(selected.id) : undefined}
      onDelete={selected ? () => deleteNode(selected.id) : undefined}
      overlay={edgeOverlay}
      floating={dockFloating}
      onClose={closeInspector}
    />
  ) : null;

  // The active environment (real env store; falls back to the workspace default).
  const activeEnv =
    envs.find((e) => e.slug === activeEnvSlug || e.id === activeEnvSlug) ??
    envs.find((e) => e.isDefault) ??
    null;
  const envChip = activeEnv
    ? {
        name: activeEnv.name,
        accent: envAccent(activeEnv),
        isProd: envAccent(activeEnv) === "var(--env-prod)",
      }
    : null;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        background: "var(--bg)",
        color: "var(--ink)",
        position: "relative",
        overflow: "hidden",
      }}
    >
      {/* top bar (56px) */}
      <CanvasTopBar
        name={name}
        onNameChange={setName}
        activeKey={activeKey}
        version={version}
        generating={generating}
        graphValid={!!graph}
        graphError={error}
        issuesCount={generating ? 0 : allIssues.length}
        issuesSevere={resourceWarnings.length > 0}
        showIssues={showIssues}
        onToggleIssues={() => setShowIssues((s) => !s)}
        env={envChip}
        runCapUsd={budget?.perExecutionCapUsd ?? null}
        status={status}
        busy={busy}
        maySave={maySave}
        saveDeniedTitle={saveDeniedTitle}
        showAi={showAi}
        onToggleAi={() => setShowAi((s) => !s)}
        showInput={showInput}
        onToggleInput={() => setShowInput((s) => !s)}
        onImport={() => importInputRef.current?.click()}
        onExport={exportGraph}
        workflows={workflows}
        currentKeyParam={keyParam}
        onOpenWorkflow={openWorkflow}
        onNewWorkflow={newWorkflow}
        onSave={() => void saveOnly()}
        onRun={() => void run()}
      />

      {/* hidden file input backing the overflow menu's Import */}
      <input
        ref={importInputRef}
        type="file"
        accept="application/json,.json"
        style={{ display: "none" }}
        onChange={importFromFile}
      />

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

      {/* BODY: 60px icon rail · canvas · 492px inspector dock */}
      <div
        style={{ display: "flex", flex: 1, minHeight: 0, position: "relative" }}
      >
        <CategoryRail
          onAdd={addEntry}
          onOpenCatalog={() => setCatalogOpen(true)}
        />

        {/* canvas — ambient warm wash + dotted grid */}
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

          {/* hint pill (design comp copy, verbatim) */}
          {!phone && (
            <div
              style={{
                position: "absolute",
                left: 20,
                bottom: 18,
                display: "flex",
                alignItems: "center",
                gap: 9,
                fontSize: "var(--text-xs)",
                color: "var(--ink-faint)",
                border: "1px solid var(--line-mid)",
                background: "color-mix(in srgb, var(--panel) 82%, transparent)",
                backdropFilter: "blur(6px)",
                borderRadius: 9,
                padding: "8px 13px",
                pointerEvents: "none",
                zIndex: 5,
                maxWidth: "calc(100% - 40px)",
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: "var(--brand)",
                  boxShadow: "0 0 8px var(--brand)",
                  flex: "none",
                }}
              />
              Card colour = run state · icon colour = node type. Test a step
              with ▷, then drag its output into the next node.
            </div>
          )}
        </div>

        {/* inspector dock (persistent right column; overlay on narrow/phone) */}
        {dock}
      </div>

      {/* full catalog modal (the rail's dashed "+") */}
      <CatalogModal
        open={catalogOpen}
        onClose={() => setCatalogOpen(false)}
        onAdd={(entry) => {
          addEntry(entry);
          setCatalogOpen(false);
        }}
      />

      {/* toasts — bottom-right, offset LEFT of the dock so they never hide under it */}
      <div
        style={{
          position: "absolute",
          right: showDock && !dockFloating ? 508 : 16,
          bottom: 20,
          display: "flex",
          flexDirection: "column",
          gap: 9,
          zIndex: 60,
          alignItems: "flex-end",
          pointerEvents: "none",
        }}
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              border: `1px solid ${
                t.tone === "warn"
                  ? "color-mix(in srgb, var(--state-paused) 45%, transparent)"
                  : "color-mix(in srgb, var(--state-done) 40%, transparent)"
              }`,
              background: "var(--card-2)",
              borderRadius: 11,
              padding: "11px 15px",
              minWidth: 230,
              boxShadow: "0 18px 40px -18px rgba(0, 0, 0, 0.5)",
              animation: "naaryToastIn .28s cubic-bezier(.2,.9,.3,1.2)",
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                flex: "none",
                background:
                  t.tone === "warn"
                    ? "var(--state-paused)"
                    : "var(--state-done)",
                boxShadow: `0 0 9px ${
                  t.tone === "warn"
                    ? "var(--state-paused)"
                    : "var(--state-done)"
                }`,
              }}
            />
            <span
              style={{
                fontSize: "var(--text-sm)",
                color: "var(--ink)",
                fontWeight: "var(--weight-medium)",
              }}
            >
              {t.text}
            </span>
            {t.meta && (
              <span
                className="mono"
                style={{
                  marginLeft: "auto",
                  fontSize: "var(--text-2xs)",
                  color: "var(--ink-faint)",
                  paddingLeft: 8,
                }}
              >
                {t.meta}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
