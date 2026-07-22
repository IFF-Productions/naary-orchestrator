// Derived render state for the canvas (extracted verbatim from CanvasPage): the live-compiled
// graph, the watched-run overlay, the lint/resource issue lists, and the per-node/per-edge
// display state that feeds React Flow. Pure inputs → derived outputs; no local state.
import { useCallback, useMemo } from "react";
import { type Node } from "@xyflow/react";
import {
  lintBindings,
  lintTemplates,
  validateIntegrationConfig,
  type GraphDef,
} from "@naary/dsl";
import type { ConnectionRow, ExecutionState } from "../../lib/api";
import { compileGraph } from "../../lib/compile-graph";
import { type CanvasNode } from "../../lib/graph-model";
import type { NodeTestRun } from "./canvas-types";
import { CONNECTION_TYPES } from "./fields";
import { type FlowEdge, isEntryKind, type NaaryData } from "./flow";
import { type EdgeRunState } from "./NaaryEdge";
import type { NodeRunState } from "./NodeCard";
import { computeCanvasRunStates } from "./run-watch";

export function useCanvasDerivations({
  nodes,
  edges,
  connections,
  pins,
  nodeRuns,
  generating,
  watching,
  watchState,
}: {
  nodes: Node<NaaryData>[];
  edges: FlowEdge[];
  connections: ConnectionRow[];
  pins: Record<string, unknown>;
  nodeRuns: Record<string, NodeTestRun>;
  generating: boolean;
  watching: boolean;
  watchState: ExecutionState | null;
}) {
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

  // #490 — per-node live run state (done/running/error/waiting/queued/skipped) for the
  // watched run, keyed by node id. Derived PURELY from the compiled graph + polled state
  // via the shared run-view-model logic (RunDetail and the canvas agree exactly). Null
  // when not watching or the graph isn't compilable — the overlay then does nothing.
  const watchRunStates = useMemo(
    () =>
      watching && watchState && graph
        ? computeCanvasRunStates(graph, watchState)
        : null,
    [watching, watchState, graph],
  );

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
        // #490 — while watching a run, the live run state fully OVERRIDES authoring
        // (test-run / no-input) state so the overlay isn't fought by editor logic.
        const runState = watchRunStates
          ? (watchRunStates[n.id] ?? "idle")
          : runStateFor(n);
        const runMs =
          !watchRunStates && run?.status === "done" && run.output !== undefined
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
    [
      nodes,
      pins,
      issuesByNode,
      generating,
      nodeRuns,
      runStateFor,
      watchRunStates,
    ],
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

  return {
    graph,
    error,
    watchRunStates,
    templateWarnings,
    resourceWarnings,
    allIssues,
    issuesByNode,
    runStateFor,
    flowNodes,
    flowEdges,
  };
}
