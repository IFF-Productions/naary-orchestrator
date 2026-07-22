// The inspector dock composition (extracted verbatim from CanvasPage): the selected node's
// InspectorDock (header/actions/input-data/parameters/output-logs via ConfigPanel) plus the
// Connection inspector that overlays it when an edge is selected. Thin props-in wrapper.
import { type Node } from "@xyflow/react";
import type { ConnectionRow, TestNodeResult } from "../../lib/api";
import { nodeDisplayLabel } from "../../lib/graph-model";
import type { EdgeConditionDraft } from "../../lib/graph-model";
import type { NodeTestRun } from "./canvas-types";
import { ConfigPanel } from "./ConfigPanel";
import { EdgeInspector } from "./EdgeInspector";
import { type FlowEdge, type NaaryData } from "./flow";
import {
  type DockInputRow,
  type DockRoutingRow,
  InspectorDock,
} from "./InspectorDock";
import type { NodeRunState } from "./NodeCard";

export function CanvasInspectorDock({
  selected,
  selectedEdge,
  selectedState,
  selectedRun,
  selectedFreshOutput,
  nodes,
  edges,
  nodeKinds,
  hookUrls,
  connections,
  pins,
  workflowKey,
  generating,
  issuesByNode,
  dockRouting,
  dockInputRows,
  nodeLabelOf,
  pinNode,
  unpinNode,
  runNodeTest,
  updateConfig,
  deleteNode,
  updateEdgeCondition,
  clearEdgeCondition,
  deleteEdge,
  pushToast,
  closeInspector,
  floating,
  stacked,
}: {
  selected: Node<NaaryData> | undefined;
  selectedEdge: FlowEdge | undefined;
  selectedState: NodeRunState;
  selectedRun: NodeTestRun | undefined;
  selectedFreshOutput: boolean;
  nodes: Node<NaaryData>[];
  edges: FlowEdge[];
  nodeKinds: Record<string, string>;
  hookUrls: string[];
  connections: ConnectionRow[];
  pins: Record<string, unknown>;
  workflowKey: string;
  generating: boolean;
  issuesByNode: Map<string, string[]>;
  dockRouting: { rows: DockRoutingRow[]; title: string; note: string } | null;
  dockInputRows: DockInputRow[];
  nodeLabelOf: (id: string) => string;
  pinNode: (nodeId: string, output: unknown) => Promise<void>;
  unpinNode: (nodeId: string) => Promise<void>;
  runNodeTest: (nodeId: string, autofill?: boolean) => Promise<TestNodeResult>;
  updateConfig: (nodeId: string, patch: Record<string, unknown>) => void;
  deleteNode: (id: string) => void;
  updateEdgeCondition: (
    edgeId: string,
    patch: Partial<EdgeConditionDraft>,
  ) => void;
  clearEdgeCondition: (edgeId: string) => void;
  deleteEdge: (id: string) => void;
  pushToast: (text: string, meta?: string, tone?: "ok" | "warn") => void;
  closeInspector: () => void;
  floating: boolean;
  stacked: boolean;
}) {
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

  return (
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
      floating={floating}
      stacked={stacked}
      onClose={closeInspector}
    />
  );
}
