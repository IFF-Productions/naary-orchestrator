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
 *
 * This screen composes several sibling modules under ./canvas: presentational panels
 * (issues / AI prompt / run input / toasts / the react-flow stage) and hooks that own
 * cohesive slices of logic (toasts, derived render state, dock read-models, the AI
 * builder, workflow persistence). CanvasPage keeps the core graph state + wiring.
 */
import "@xyflow/react/dist/style.css";
import "./canvas.css";
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Node,
  type ReactFlowInstance,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { type GraphDef, type NodeType, renameNode } from "@naary/dsl";
import {
  api,
  type BudgetView,
  type ConnectionRow,
  type Environment,
  type ExecutionState,
  type GraphSummary,
  type TestNodeResult,
  UnauthorizedError,
  type WebhookRow,
} from "../lib/api";
import { nodeTestState } from "../lib/node-test-state";
import { isTerminal } from "../lib/run-status";
import {
  RETURN_PARAM,
  returnLabel,
  safeReturnTo,
  withReturn,
} from "../lib/canvas-return";
import { isEntryType } from "../lib/compile-graph";
import { decompileGraph } from "../lib/decompile-graph";
import { canSaveWorkflow } from "../lib/permissions-logic";
import {
  BELOW_RAIL_QUERY,
  PHONE_QUERY,
  useMediaQuery,
} from "../lib/useMediaQuery";
import { useActiveEnvironment } from "../lib/useActiveEnvironment";
import { usePermissions } from "../lib/usePermissions";
import {
  defaultConfigFor,
  type EdgeConditionDraft,
  NODE_KINDS,
} from "../lib/graph-model";
import { useConfirm } from "../components";
import { envAccent } from "../workspace/EnvironmentSwitcher";
import { CATALOG, type CatalogEntry } from "./app/catalog/catalog-data";
import { AiPromptPanel } from "./canvas/AiPromptPanel";
import { UNTITLED_WORKFLOW } from "./canvas/canvas-dirty";
import { CanvasInspectorDock } from "./canvas/CanvasInspectorDock";
import { CanvasIssuesPanel } from "./canvas/CanvasIssuesPanel";
import { ReviewChangesPanel } from "./canvas/ReviewChangesPanel";
import { type CanvasLoad, useFixFromRun } from "./canvas/useFixFromRun";
import { CanvasStage } from "./canvas/CanvasStage";
import { nextNodePosition } from "./canvas/node-placement";
import { CanvasToasts } from "./canvas/CanvasToasts";
import { NARROW_QUERY, type NodeTestRun } from "./canvas/canvas-types";
import { CategoryRail } from "./canvas/CategoryRail";
import { CatalogModal } from "./canvas/CatalogModal";
import { downstreamOf } from "./canvas/graph-traversal";
import {
  type FlowEdge,
  type NaaryData,
  SEED_EDGES,
  SEED_NODES,
  slugify,
  summarize,
  toFlowEdges,
  toFlowNodes,
} from "./canvas/flow";
import type { NodeRunState } from "./canvas/NodeCard";
import { RunInputPanel } from "./canvas/RunInputPanel";
import { CanvasTopBar } from "./canvas/TopBar";
import { useAiBuilder } from "./canvas/useAiBuilder";
import {
  useCanvasDerivations,
  useCompiledCanvas,
} from "./canvas/useCanvasDerivations";
import { useCanvasToasts } from "./canvas/useCanvasToasts";
import { useDockDerivations } from "./canvas/useDockDerivations";
import { useDryRun } from "./canvas/useDryRun";
import { useUnsavedChanges } from "./canvas/useUnsavedChanges";
import { useWorkflowActions } from "./canvas/useWorkflowActions";

export function CanvasPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  // Where the back control returns to. UNTRUSTED (it comes off the URL) — safeReturnTo
  // reduces it to an in-app /app path or null, and null means today's behaviour (/app).
  const returnTo = safeReturnTo(searchParams.get(RETURN_PARAM));
  const backLabel = returnLabel(returnTo);
  /** Params for a canvas URL rewrite, with the return target preserved. */
  const keepReturn = (params: Record<string, string> = {}) =>
    withReturn(params, returnTo);
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
  // ≤1024 (phone + tablet): the three-pane row collapses to a stacked column — the
  // category rail is hidden, the graph becomes a capped pan/scroll viewport on top, and
  // the inspector is a full-width panel BELOW it. Desktop (>1024) is untouched.
  const stacked = useMediaQuery(BELOW_RAIL_QUERY);
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
  // How the workflow fetch went. THREE states, not settled/not-settled (#1006): the only consumer
  // (useFixFromRun) has to tell "the canvas hasn't loaded yet" from "this is what the canvas has"
  // from "it couldn't be opened" — and the third is not a spinner, because a failed open leaves
  // the SEED nodes on screen, which compile and would otherwise be described as the workflow.
  const [canvasLoad, setCanvasLoad] = useState<CanvasLoad>("loading");
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
  const { toasts, pushToast } = useCanvasToasts();

  // ReactFlow instance (captured via onInit) — CanvasPage renders <ReactFlow>, so it's
  // OUTSIDE the flow provider and can't use useReactFlow; keep a ref for fitView. Declared
  // before the AI builder + load effects, which drive it (streaming refit, template fit).
  const rfRef = useRef<ReactFlowInstance<Node<NaaryData>, FlowEdge> | null>(
    null,
  );

  const keyParam = searchParams.get("key");
  const templateParam = searchParams.get("template");
  // #490 — live run-watch: with ?runId= present, the canvas becomes a live view of
  // that run, overlaying each node's real execution state (done/running/error/
  // waiting/queued) until the run reaches a terminal status. View-oriented: node
  // drag/connect are disabled while watching so the overlay isn't fought by edits.
  const runId = searchParams.get("runId");
  const watching = Boolean(runId);
  // "Fix with AI" from a failed run: describe that failure into the AI panel (see useFixFromRun).
  // Distinct from `runId`, which puts the canvas in read-only watch mode — this one is here to
  // EDIT, so it must not.
  const fixRunId = searchParams.get("fix");

  // The live-compiled canvas. Compiled HERE, above both consumers: the AI panel sends it as
  // the graph to change, and the derivations layer lints and overlays it.
  const { graph, error } = useCompiledCanvas(nodes, edges);

  // Unsaved-changes guard (#909 follow-up): the canvas never auto-saves, so it owes the user a
  // warning before anything discards their work. `dirty` also gates the "save before I test /
  // check this?" questions further down — the two must agree on what "unsaved" means, so they
  // read it from the same place.
  const { dirty, baseline, markSaved, resetBaseline } = useUnsavedChanges({
    graph,
    name,
  });
  const confirm = useConfirm();

  // "Review changes": the diff of the live canvas against `baseline` (see ReviewChangesPanel).
  // Opened automatically when an AI edit lands, since that is the moment with the most to check
  // and the least visibility into it; openable any time there is something to review.
  const [showReview, setShowReview] = useState(false);

  // AI workflow builder: a CONVERSATION (#1003) — each message streams its result onto the canvas,
  // either changing what's there or replacing it with a new draft.
  const {
    showAi,
    setShowAi,
    aiPrompt,
    setAiPrompt,
    aiMode,
    setAiMode,
    canEdit,
    generating,
    genMessage,
    genNodeCount,
    messages: aiMessages,
    phase: aiPhase,
    typing: aiTyping,
    plan: aiPlan,
    chatError: aiError,
    send: sendAiMessage,
    resetChat: resetAiChat,
    provider: aiProvider,
    chooseProvider: chooseAiProvider,
    providerOptions: aiProviderOptions,
    providerHint: aiProviderHint,
  } = useAiBuilder({
    nodes,
    graph,
    graphError: error,
    rfRef,
    keyParam,
    templateParam,
    // The SAVED key only — "" for an unsaved draft. Binds the session to this workflow so a build
    // resumed later from the Build with AI screen publishes its next version instead of forking it.
    savedKey: workflowKey,
    // Both are what the session is bound to. This screen is a SIBLING of /app, so AppShell's
    // pathname|env key never remounts it — opening another workflow or switching env leaves the
    // conversation running against something it no longer describes. See sessionBindingStale.
    activeEnv: activeEnvSlug,
    setNodes,
    setEdges,
    setName,
    setWorkflowKey,
    setVersion,
    setStatus,
    setSearchParams,
    onGraphPresented: resetBaseline,
    // An AI EDIT just landed. This is the moment with the most to check and the least visibility
    // into it — the graph was rewritten wholesale and the only report of what moved is the canvas
    // — so the review opens itself rather than waiting to be found. A CREATE does not: there is
    // no prior version to compare against, so the panel would have nothing to say.
    onEditApplied: () => setShowReview(true),
  });

  // Turn `?fix=<runId>` into a prefilled first MESSAGE in the AI panel's composer. Prefills only —
  // the user reads what the model will be told about their run and presses Send themselves. That
  // is why it is a draft rather than an auto-sent turn: in a conversation the obvious alternative
  // (make it the first user message) would ship a tenant's run data to a model on a navigation.
  const fixFromRun = useFixFromRun({
    fixRunId,
    // The graph the fix will CHANGE — the live canvas, not the snapshot the run executed.
    currentGraph: graph,
    currentVersion: version,
    canvasLoad,
    setAiPrompt,
    setAiMode,
    setShowAi,
  });

  const [watchState, setWatchState] = useState<ExecutionState | null>(null);

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

  /**
   * RENAME A NODE'S ID (#833) — "can we have the ability to actually rename the node slug".
   *
   * The rewrite itself lives in `@naary/dsl`'s pure `renameNode`, which is tested against every
   * reference kind (expressions, bindings, edge conditions, handoff targets…). This function is
   * only the canvas's half: feed it a GraphDef-shaped view of canvas state, then map the result
   * back onto the React Flow nodes that carry the positions.
   *
   * Mapping back BY INDEX is safe because `renameNode` maps over `nodes`/`edges` and so preserves
   * order — a contract the DSL side documents. Recompiling and decompiling instead would round-trip
   * away every node's position.
   *
   * Returns an error string to show inline, or null on success.
   */
  const renameNodeId = useCallback(
    (oldId: string, newId: string): string | null => {
      const result = renameNode(
        {
          startNodeId: "",
          nodes: nodes.map((n) => ({
            id: n.id,
            type: n.data.kind,
            config: n.data.config,
          })),
          edges: edges.map((e) => ({
            from: e.source,
            to: e.target,
            ...(e.data?.condition?.path ? { condition: e.data.condition } : {}),
          })),
        } as GraphDef,
        oldId,
        newId,
      );
      if (!result.ok) return result.error;
      if (result.rewritten === 0) return null;

      const renamed = result.graph;
      setNodes((ns) =>
        ns.map((n, i) => ({
          ...n,
          id: renamed.nodes[i].id,
          // Keep the rename selected: it is the node the user is working on, and losing the
          // selection would close the dock they just typed in.
          selected: n.id === oldId ? true : n.selected,
          data: { ...n.data, config: renamed.nodes[i].config },
        })),
      );
      setEdges((es) =>
        es.map((e, i) => ({
          ...e,
          source: renamed.edges[i].from,
          target: renamed.edges[i].to,
          ...(e.data?.condition
            ? {
                data: {
                  ...e.data,
                  condition: renamed.edges[i].condition as EdgeConditionDraft,
                },
              }
            : {}),
        })),
      );

      // Canvas-local state keyed by node id follows, or the node loses its pin and its last test
      // result the moment it is renamed.
      const remap = <T,>(m: Record<string, T>): Record<string, T> =>
        oldId in m
          ? Object.fromEntries(
              Object.entries(m).map(([k, v]) => [k === oldId ? newId : k, v]),
            )
          : m;
      setPins(remap);
      setNodeRuns(remap);

      // The SERVER's pin is keyed by node id too. Move it, best-effort: a failure here leaves an
      // orphaned pin, which is recoverable, and must not undo a rename the canvas already applied.
      const pinned = pins[oldId];
      if (workflowKey && pinned !== undefined) {
        void api
          .pinNode(workflowKey, newId, pinned)
          .then(() => api.unpinNode(workflowKey, oldId))
          .catch(() => {
            /* the local remap already stands; the stale pin is cleaned up on next save */
          });
      }
      return null;
    },
    [nodes, edges, pins, workflowKey],
  );

  /** The key to save/run under: an opened workflow's key, else slug(name). */
  const activeKey = workflowKey || slugify(name);

  // Affordance gating (RBAC-GROUPS G2): saving an EXISTING key needs `edit` on it, a NEW
  // key needs `create`. Disabled-not-hidden (with a tooltip) so the state is explainable;
  // the API enforces regardless — a forced request still 403s.
  //
  // Declared UP HERE, above its main consumers, because the "save before I test / check this?"
  // dialogs have to know it: offering "Save and test" to someone whose save can only 403 asks
  // them to authorize something that cannot happen.
  const perms = usePermissions();
  const keyExists = workflows.some((w) => w.workflowKey === activeKey);
  const maySave = canSaveWorkflow(perms, activeKey, keyExists);
  const saveDeniedTitle = keyExists
    ? "You don't have edit permission on this workflow"
    : "You don't have permission to create workflows in this environment";

  // Single-node test runner — the ONE path the dock's "Test step", the config panel's
  // "Test node" and the per-node ▶ all use, so card state / measured duration / the
  // dock's output stay in sync. Wraps the existing api.testNode machinery. Duration:
  // prefer the SERVER's measurement (Slice 2 — interpreter-stamped for activity nodes,
  // server-measured for pure ones); fall back to client wall-clock only when the API
  // predates it. Cost: the run's real metered spend (fail-safe billed) when returned.
  // `save` is created by useWorkflowActions further down, so it can't be closed over here.
  // A ref, filled in below, lets Test reach it without inverting the hook order.
  const saveRef = useRef<(() => Promise<string | null>) | null>(null);

  const runNodeTest = useCallback(
    async (nodeId: string, autofill?: boolean): Promise<TestNodeResult> => {
      // ASK, DON'T AUTO-SAVE. The endpoint takes only (workflowKey, nodeId) and reads the node
      // out of the latest SAVED graph — what's on the canvas never leaves the browser. So an
      // edited-but-unsaved node used to be tested in its PREVIOUS config and reported on a
      // version the user couldn't see: type a value, press Test, get told the field is empty.
      // Saving first fixes that, but saving on the user's behalf takes the decision to write a
      // version away from them, and this canvas does not auto-save. Hence the dialog — and a
      // "no" means the test doesn't run, rather than quietly answering a question about a graph
      // they can't see (which is the confusion the dialog exists to end).
      let key = workflowKey;
      if (!key || dirty) {
        // Don't offer a save this user isn't allowed to make — the same explanation the Save
        // button's tooltip gives, instead of a dialog that leads to a 403.
        if (!maySave) {
          setStatus(saveDeniedTitle);
          throw new Error(saveDeniedTitle);
        }
        const ok = await confirm({
          title: "Test the saved version?",
          body: "Node tests run against the saved workflow, so the unsaved edits on this canvas wouldn't be part of the test. Saving first makes the thing tested the thing on screen.",
          confirmLabel: "Save and test",
          cancelLabel: "Don't test",
        });
        if (!ok) {
          setStatus(
            "Test cancelled — node tests run against the saved workflow.",
          );
          throw new Error("Test cancelled — the canvas has unsaved changes.");
        }
        // The key the save RETURNED, not the state variable: on a first save `setWorkflowKey`
        // won't have re-rendered yet, so reading state here would test under the empty key.
        // A null means the save didn't happen (an uncompilable graph) and said why — testing
        // the previous version anyway is exactly the lie above.
        const savedKey = await saveRef.current?.();
        if (!savedKey) {
          throw new Error("Not saved — a node test needs a saved workflow.");
        }
        key = savedKey;
      }
      const t0 = performance.now();
      setNodeRuns((r) => ({
        ...r,
        [nodeId]: { status: "running", startedAt: Date.now() },
      }));
      try {
        const res = await api.testNode(key, nodeId, undefined, autofill);
        const clientMs = Math.round(performance.now() - t0);
        setNodeRuns((r) => {
          const next = { ...r };
          // The rule lives in `nodeTestState` so it is testable as the real decision — notably
          // that a FAILED test is an error on the node, not the same "back to idle" as a node
          // type that simply can't be tested here.
          const state = nodeTestState(res, clientMs);
          if (state) next[nodeId] = state;
          else delete next[nodeId];
          return next;
        });
        if (!res.pure) setStatus(res.message);
        // Autofill pins upstream nodes server-side — refresh so they show. Under `key`, not the
        // state variable: on a FIRST save the re-render hasn't landed, so `workflowKey` is still
        // empty here and the refresh would list nothing.
        if (autofill) {
          api
            .listPins(key)
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
    [workflowKey, dirty, confirm, maySave, saveDeniedTitle],
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
    /**
     * A blank canvas has nothing to fetch, so it is already as loaded as it will get; the two
     * branches below report their own outcome when their fetch settles.
     *
     * THE ONE PLACE `loaded` DOES NOT MEAN "the workflow is on the canvas". The nodes here are
     * still SEED_NODES, so `/app/canvas?fix=<runId>` with no `?key=` would let useFixFromRun
     * describe the run's failure against the seed. Not reachable from the product — the run
     * detail's "Fix with AI" is gated on the run's workflow key, so every URL it builds carries a
     * non-empty one — and a much weaker version of #1006 even if it were: with no workflow loaded
     * there is no version banner to contradict, and "no longer in the workflow" is TRUE of a blank
     * draft. Written down rather than silently relied on, so a future ungated `?fix=` link has
     * something to trip over.
     */
    setCanvasLoad(!templateParam && !keyParam ? "loaded" : "loading");
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
          // A freshly PRESENTED graph, not an edit of what was here: re-baseline the
          // unsaved-changes guard so the fork doesn't read as work in progress.
          resetBaseline();
          // The initial fitView ran before the graph landed — refit to it.
          setTimeout(
            () => rfRef.current?.fitView({ duration: 250, padding: 0.2 }),
            80,
          );
          setCanvasLoad("loaded");
        })
        // Same shape as the `?key=` branch below, and for the same reason: a fork that failed
        // leaves the SEED nodes on the canvas, so it is `failed`, not `loaded`.
        .catch(() => {
          if (!live) return;
          setStatus(`Couldn't load template '${templateParam}'.`);
          setCanvasLoad("failed");
        });
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
          // Same as the template branch: this graph is what's saved, so it is the new baseline.
          resetBaseline();
          // The initial fitView ran before the graph landed — refit to it.
          setTimeout(
            () => rfRef.current?.fitView({ duration: 250, padding: 0.2 }),
            80,
          );
          // LAST, and inside the `then` — not in a `finally`. `finally` runs after `catch`, so a
          // single "settled" flag there would overwrite the failure below with `loaded` and hand
          // useFixFromRun the seed canvas as though it were this workflow (#1006). Set at the end
          // of the success body, a throw anywhere above it (decompile, toFlowNodes) also lands in
          // the catch — which agrees with the status line that catch already writes.
          setCanvasLoad("loaded");
        })
        // Terminal, not a wait: a workflow that failed to open is an ANSWER for `fixStage`, which
        // would otherwise report "loading" forever on the one path that most needs to say what
        // went wrong. It is `failed` rather than `loaded` because the nodes were never replaced —
        // the canvas still shows SEED_NODES, which compile, and describing a run's failure
        // against those is the falsehood this whole feature exists to prevent.
        .catch(() => {
          if (!live) return;
          setStatus(`Couldn't open workflow '${keyParam}'.`);
          setCanvasLoad("failed");
        });
    }
    return () => {
      live = false;
    };
  }, [keyParam, templateParam, resetBaseline]);

  // #490 — poll the watched run's real state every 1.5s (same cadence + api call
  // as RunDetail), stopping the moment it's terminal and on unmount. Reuses the
  // interpreter's authoritative state; the overlay derives from it purely.
  useEffect(() => {
    if (!runId) {
      setWatchState(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      let next: ExecutionState | null = null;
      try {
        next = await api.getState(runId);
      } catch {
        /* transient — retry on the next tick */
      }
      if (cancelled) return;
      if (next) setWatchState(next);
      // Closed runs don't change — stop polling once terminal.
      if (!next || !isTerminal(next.status)) {
        timer = setTimeout(tick, 1500);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [runId]);

  // Leave watch mode: drop ?runId= (keeps ?key=), restoring the editable canvas.
  const stopWatching = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("runId");
        return next;
      },
      { replace: true },
    );
  }, [setSearchParams]);

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

  // Live-compiled graph, watched-run overlay, lint/resource issues, and the per-node/
  // per-edge display state that feeds React Flow.
  const {
    resourceWarnings,
    allIssues,
    issuesByNode,
    runStateFor,
    flowNodes,
    flowEdges,
  } = useCanvasDerivations({
    nodes,
    edges,
    graph,
    connections,
    pins,
    nodeRuns,
    generating,
    watching,
    watchState,
  });

  const selected = nodes.find((n) => n.selected);
  const selectedEdge = edges.find((e) => e.selected);
  const selectedRun = selected ? nodeRuns[selected.id] : undefined;
  const selectedState: NodeRunState = selected
    ? (runStateFor(selected) ?? "idle")
    : "idle";
  const selectedFreshOutput =
    selectedRun?.status === "done" && selectedRun.output !== undefined;

  /**
   * When a GENERATE finishes, surface what still needs the author — don't make them find it by
   * test-running.
   *
   * Reported as: "I have to test the flow like 100 times to debug what's going on … I don't think
   * I created a working flow from the first try." The canvas ALREADY knows: `allIssues` carries
   * missing/unknown connections, invalid integration config (unknown action, missing required
   * fields) and `{{ … }}` references nothing produces — the exact things that make a generated
   * flow fail at run time. It just sat behind a toolbar toggle that starts CLOSED, so a freshly
   * generated graph looked finished.
   *
   * Opens on the transition out of `generating` only, so it never re-opens a panel the author
   * deliberately closed while editing.
   */
  const wasGenerating = useRef(false);
  useEffect(() => {
    const finished = wasGenerating.current && !generating;
    wasGenerating.current = generating;
    if (!finished || allIssues.length === 0) return;
    setShowIssues(true);
    const nodeCount = new Set(allIssues.map((i) => i.nodeId)).size;
    // "Issue" is what the panel this opens calls them — matching copy so the toast and the panel
    // read as one thing rather than two different warnings (raised in review).
    pushToast(
      `${allIssues.length} issue${allIssues.length === 1 ? "" : "s"} to fix`,
      `in ${nodeCount} node${nodeCount === 1 ? "" : "s"} — resolve these before running`,
    );
  }, [generating, allIssues, pushToast]);

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
          // A collision-checked free slot (#756). The previous `ns.length % 5 / % 3` offsets gave only
          // 15 positions across a 160x60 area for cards up to 244px wide, so every added node
          // overlapped the last, the 16th landed exactly on the 1st, and deleting-then-adding dropped
          // a node straight onto an existing card. Position now depends on where cards ARE, not how
          // many there are.
          // A TRIGGER is placed upstream of the flow rather than in its first gap — see
          // nextNodePosition's `entry` option (node-placement.ts). Uses compile-graph's
          // isEntryType — the same list the compiler uses to pick startNodeId, so the canvas and
          // the compiler can't disagree about what a trigger is.
          position: nextNodePosition(
            ns.map((n) => n.position),
            {
              entry: isEntryType(kind),
              entries: ns
                .filter((n) => isEntryType(n.data.kind))
                .map((n) => n.position),
            },
          ),
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

  // "New" replaces the canvas HERE, in state, and only then rewrites the URL — so the route
  // blocker can't cover it (by the time the navigation is blocked the work is already gone).
  // It asks for itself, before touching anything.
  async function newWorkflow() {
    if (dirty) {
      const ok = await confirm({
        title: "Start a new workflow?",
        body: "This canvas has changes that haven't been saved. Starting a new one discards them.",
        confirmLabel: "Discard and start new",
        cancelLabel: "Keep editing",
        danger: true,
      });
      if (!ok) return;
    }
    setNodes(SEED_NODES);
    setEdges(SEED_EDGES);
    setName(UNTITLED_WORKFLOW);
    setWorkflowKey("");
    setVersion(null);
    setStatus(null);
    // Before the param rewrite below, so the blocker doesn't ask a second time about work the
    // user just agreed to discard.
    resetBaseline();
    if (keyParam) setSearchParams(keepReturn(), { replace: true });
  }

  function openWorkflow(key: string) {
    // Opening a DIFFERENT workflow re-loads the canvas from the server, but it does so through a
    // ?key= navigation — which the blocker sees and asks about, so there's no second prompt here.
    if (key) setSearchParams(keepReturn({ key }), { replace: true });
    else void newWorkflow();
  }

  // Workflow persistence + file IO (export / import / save / run / save-only). Plain
  // handlers closing over the state above — no hooks, so call position is free.
  const { exportGraph, importFromFile, run, save, saveOnly } =
    useWorkflowActions({
      graph,
      error,
      name,
      activeKey,
      showInput,
      runInput,
      keyParam,
      templateParam,
      returnTo,
      setNodes,
      setEdges,
      setName,
      setWorkflowKey,
      setVersion,
      setStatus,
      setBusy,
      setWorkflows,
      setSearchParams,
      navigate,
      onSaved: markSaved,
      onGraphReplaced: resetBaseline,
    });
  // Hand `save` back to runNodeTest, which is declared above it (it feeds callbacks defined
  // earlier) and so can't close over it. Assigned every render, so the ref never holds a
  // handler closed over stale state.
  saveRef.current = save;

  // DRY RUN (#832) — "Check flow": answer "will this run?" without running it.
  //
  // The endpoint checks the SAVED graph, the same seam a single-node Test sits on, so a check
  // with unsaved edits on the canvas would describe a version that isn't the one on screen. It
  // used to save first to close that gap; it now ASKS, because the canvas doesn't save on the
  // user's behalf. A "no" means no check at all rather than a verdict about a hidden version.
  // Nothing to save (clean canvas, already saved) ⇒ no question and no needless new version:
  // the saved graph IS what's on screen.
  const {
    checking,
    summary: dryRun,
    check: checkFlow,
    clear: clearDryRun,
  } = useDryRun({
    save: async () => {
      // Nothing to save — the saved workflow already IS what's on screen. Check it as it
      // stands, with no question and no gratuitous new version.
      if (workflowKey && !dirty) return workflowKey;
      // As in a node test: don't offer a save this user can't make.
      if (!maySave) {
        setStatus(saveDeniedTitle);
        return null;
      }
      // Asked BEFORE `busy`, so the top bar isn't stuck showing work in progress behind a
      // modal that hasn't been answered yet.
      const ok = await confirm({
        title: "Check the saved version?",
        body: "Check flow inspects the saved workflow, so the unsaved edits on this canvas wouldn't be part of the check. Saving first makes the checked flow the one on screen.",
        confirmLabel: "Save and check",
        cancelLabel: "Don't check",
      });
      if (!ok) {
        setStatus("Check cancelled — Check flow inspects the saved workflow.");
        return null;
      }
      setBusy(true);
      setStatus(null);
      try {
        return await save();
      } catch (e) {
        if (e instanceof UnauthorizedError) {
          navigate("/auth");
          return null;
        }
        setStatus(e instanceof Error ? e.message : "Save failed.");
        return null;
      } finally {
        setBusy(false);
      }
    },
    onOpenIssues: () => setShowIssues(true),
  });

  // A verdict describes the graph it was computed on. Once the graph changes it is no longer an
  // answer about what's on screen, so it is dropped rather than left to look current.
  //
  // Keyed on the COMPILED graph's content, not on `graph`'s identity: selecting a node rebuilds
  // that object without changing the flow, and discarding a good verdict because someone clicked
  // a node would be its own small annoyance.
  const graphSignature = useMemo(
    () => (graph ? JSON.stringify(graph) : ""),
    [graph],
  );
  useEffect(() => {
    clearDryRun();
  }, [graphSignature, clearDryRun]);

  // Dry-run failures join the lint/resource rows in ONE list. They are the same kind of thing to
  // the user — "something here is wrong, click to go fix it" — and a second panel would make them
  // hunt in two places.
  const panelIssues = useMemo(
    () => (dryRun ? [...allIssues, ...dryRun.issues] : allIssues),
    [allIssues, dryRun],
  );

  /* ---------------- dock derivations ---------------- */

  // The selected node's label, INPUT DATA rows, and switch/if ROUTING RULES view.
  const { nodeLabelOf, dockInputRows, dockRouting } = useDockDerivations({
    nodes,
    edges,
    nodeRuns,
    pins,
    selected,
  });

  // Dock presentation by breakpoint:
  //  · ≤1024 (stacked): full-width panel BELOW the graph (not overlaid).
  //  · 1025–1080 (narrow, desktop): floats over the canvas from the right.
  //  · >1080 (desktop): the persistent 492px right column.
  // On both stacked and floating the dock is only mounted when something is selected
  // (so the graph keeps the full viewport otherwise); the desktop column is always shown.
  const dockFloating = (phone || narrow) && !stacked;
  const dockOnDemand = stacked || dockFloating;
  const showDock = dockOnDemand ? Boolean(selected || selectedEdge) : true;

  const dock = showDock ? (
    <CanvasInspectorDock
      selected={selected}
      selectedEdge={selectedEdge}
      selectedState={selectedState}
      selectedRun={selectedRun}
      selectedFreshOutput={selectedFreshOutput}
      nodes={nodes}
      edges={edges}
      nodeKinds={nodeKinds}
      hookUrls={hookUrls}
      connections={connections}
      pins={pins}
      workflowKey={workflowKey}
      generating={generating}
      issuesByNode={issuesByNode}
      dockRouting={dockRouting}
      dockInputRows={dockInputRows}
      nodeLabelOf={nodeLabelOf}
      pinNode={pinNode}
      unpinNode={unpinNode}
      runNodeTest={runNodeTest}
      updateConfig={updateConfig}
      deleteNode={deleteNode}
      renameNodeId={renameNodeId}
      updateEdgeCondition={updateEdgeCondition}
      clearEdgeCondition={clearEdgeCondition}
      deleteEdge={deleteEdge}
      pushToast={pushToast}
      closeInspector={closeInspector}
      floating={dockFloating}
      stacked={stacked}
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
        // dvh, NOT vh: on iOS/iPadOS Safari `100vh` counts the area behind the browser toolbar,
        // so a 100vh root is TALLER than the visible viewport and the whole page scrolls past the
        // screen. `100dvh` (dynamic viewport height) is the actually-visible height — no page scroll.
        height: "100dvh",
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
        backTo={returnTo ?? undefined}
        backLabel={backLabel}
        activeKey={activeKey}
        version={version}
        generating={generating}
        graphValid={!!graph}
        graphError={error}
        issuesCount={generating ? 0 : panelIssues.length}
        issuesSevere={
          resourceWarnings.length > 0 || (dryRun?.issues.length ?? 0) > 0
        }
        hasVerdict={!!dryRun}
        verdictOk={dryRun?.ok}
        showIssues={showIssues}
        onToggleIssues={() => setShowIssues((s) => !s)}
        // Only offered when there is something to review: a baseline to compare against AND
        // unsaved work. A control that opens a panel reading "no changes" is noise.
        canReview={dirty && !!baseline}
        showReview={showReview}
        onToggleReview={() => setShowReview((s) => !s)}
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
        onNewWorkflow={() => void newWorkflow()}
        onSave={() => void saveOnly()}
        onCheck={() => void checkFlow()}
        checking={checking}
        onRun={() => void run()}
        onRunDebug={() => void run({ debug: true })}
      />

      {/* hidden file input backing the overflow menu's Import */}
      <input
        ref={importInputRef}
        type="file"
        accept="application/json,.json"
        style={{ display: "none" }}
        onChange={importFromFile}
      />

      {/* Rendered when there is EITHER a row or a dry-run summary: a clean check still owes the
          user an answer, and "nothing appeared" is the failure mode #831 already fixed once. */}
      {showIssues && (panelIssues.length > 0 || dryRun) && (
        <CanvasIssuesPanel
          issues={panelIssues}
          note={dryRun?.message}
          onSelectNode={selectNode}
        />
      )}

      {/* Needs a baseline to compare against; there is none until the canvas has presented a
          compilable graph (a brand-new draft has nothing to diff and says so via the button). */}
      {showReview && baseline && (
        <ReviewChangesPanel
          baseline={baseline.graph}
          baselineName={baseline.name}
          graph={graph}
          name={name}
          onClose={() => setShowReview(false)}
        />
      )}

      {showAi && (
        <AiPromptPanel
          aiPrompt={aiPrompt}
          onPromptChange={setAiPrompt}
          aiMode={aiMode}
          onModeChange={setAiMode}
          canEdit={canEdit}
          workflowName={name}
          messages={aiMessages}
          phase={aiPhase}
          typing={aiTyping}
          plan={aiPlan}
          error={aiError}
          onSend={(text) => void sendAiMessage(text)}
          onReset={resetAiChat}
          // The accept quick reply ("Looks good — save it") runs the canvas's OWN save, so the chip
          // does exactly what the top bar's Save does — one save path, not a second one.
          onAccept={() => void saveOnly()}
          provider={aiProvider}
          onProvider={chooseAiProvider}
          providerOptions={aiProviderOptions}
          providerHint={aiProviderHint}
          // Present only when the user arrived from a failed run (?fix=). Says which run this
          // describes, whose outputs are about to be sent, and — when the run executed an older
          // version — that the fix is being applied to a graph that has since moved on.
          fixNotice={
            fixRunId
              ? {
                  runId: fixRunId,
                  drift: fixFromRun.drift,
                  includedNodeIds: fixFromRun.includedNodeIds,
                  error: fixFromRun.error,
                  // Reading the run takes a moment and the canvas load takes another — the panel
                  // reports both rather than sitting empty until they finish.
                  stage: fixFromRun.stage,
                  // Both are only read when the stage is `blocked`, and they are what tells its
                  // three situations apart: the workflow couldn't be OPENED, a workflow is here
                  // and doesn't COMPILE, or there is nothing on the canvas at all. Different
                  // problems, and each of the other two sentences is plainly false about this one.
                  canvasLoadFailed: canvasLoad === "failed",
                  canvasError: error ?? null,
                }
              : null
          }
        />
      )}

      {showInput && (
        <RunInputPanel runInput={runInput} onChange={setRunInput} />
      )}

      {/* BODY: desktop = 60px icon rail · canvas · 492px inspector dock (a flex ROW).
          ≤1024 (stacked) = a flex COLUMN: the rail is hidden, the graph is a capped
          pan/scroll viewport on top, and the dock is a full-width panel below it. */}
      <div
        style={{
          display: "flex",
          flexDirection: stacked ? "column" : "row",
          flex: 1,
          minHeight: 0,
          position: "relative",
        }}
      >
        {/* The category rail is hidden ≤1024 — node-add moves to the "+" FAB / catalog modal. */}
        {!stacked && (
          <CategoryRail
            onAdd={addEntry}
            onOpenCatalog={() => setCatalogOpen(true)}
          />
        )}

        {/* canvas — ambient warm wash + dotted grid, status pills, full-screen + "+" FAB */}
        <CanvasStage
          canvasFullscreen={canvasFullscreen}
          stacked={stacked}
          showDock={showDock}
          nodeActions={nodeActions}
          flowNodes={flowNodes}
          flowEdges={flowEdges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          watching={watching}
          onInit={(inst) => {
            rfRef.current = inst;
          }}
          watchState={watchState}
          onStopWatching={stopWatching}
          generating={generating}
          genMessage={genMessage}
          genNodeCount={genNodeCount}
          onToggleFullscreen={() => setCanvasFullscreen((v) => !v)}
          onOpenCatalog={() => setCatalogOpen(true)}
        />

        {/* inspector dock — desktop right column · ≤1024 stacked full-width below · 1025–1080 overlay */}
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
      <CanvasToasts
        toasts={toasts}
        offsetRight={showDock && !dockOnDemand ? 508 : 16}
      />
    </div>
  );
}
