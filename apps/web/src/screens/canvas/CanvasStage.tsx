// The canvas viewport: the react-flow graph surface (dot grid + ambient wash) with its
// watch/generation status pills, full-screen toggle, hint pill, and the ≤1024 "+" FAB
// (extracted verbatim from CanvasPage). Presentational — all state/handlers arrive as props.
import {
  Background,
  Controls,
  type Node,
  Panel,
  ReactFlow,
  type ReactFlowInstance,
} from "@xyflow/react";
import { type ComponentProps } from "react";
import { Icon } from "../../components";
import type { ExecutionState } from "../../lib/api";
import { isTerminal, runStatusUi } from "../../lib/run-status";
import {
  type FlowEdge,
  type NaaryData,
  NodeActionsContext,
  nodeTypes,
} from "./flow";
import { edgeTypes } from "./NaaryEdge";

export function CanvasStage({
  canvasFullscreen,
  stacked,
  showDock,
  nodeActions,
  flowNodes,
  flowEdges,
  onNodesChange,
  onEdgesChange,
  onConnect,
  watching,
  onInit,
  watchState,
  onStopWatching,
  generating,
  genMessage,
  genNodeCount,
  onToggleFullscreen,
  onOpenCatalog,
}: {
  canvasFullscreen: boolean;
  stacked: boolean;
  showDock: boolean;
  nodeActions: ComponentProps<typeof NodeActionsContext.Provider>["value"];
  flowNodes: Node<NaaryData>[];
  flowEdges: FlowEdge[];
  onNodesChange: ComponentProps<typeof ReactFlow>["onNodesChange"];
  onEdgesChange: ComponentProps<typeof ReactFlow>["onEdgesChange"];
  onConnect: ComponentProps<typeof ReactFlow>["onConnect"];
  watching: boolean;
  onInit: (inst: ReactFlowInstance<Node<NaaryData>, FlowEdge>) => void;
  watchState: ExecutionState | null;
  onStopWatching: () => void;
  generating: boolean;
  genMessage: string;
  genNodeCount: number;
  onToggleFullscreen: () => void;
  onOpenCatalog: () => void;
}) {
  return (
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
          : stacked
            ? {
                // Capped viewport when the inspector shares the column; full height otherwise.
                flex: showDock ? "none" : 1,
                height: showDock ? "min(52dvh, 460px)" : undefined,
                minHeight: 0,
                width: "100%",
                position: "relative",
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
          // #490 — watch mode is a live VIEW: disable node drag/connect so the
          // run overlay isn't fought by edits (restored when watching stops).
          nodesDraggable={!watching}
          nodesConnectable={!watching}
          onInit={onInit}
          fitView
        >
          <Background gap={26} size={1.1} />
          <Controls />
          {watching && (
            <Panel position="top-center">
              <div
                className="naary-watch-pill"
                role="status"
                aria-live="polite"
              >
                <span className="naary-watch-dot" aria-hidden="true" />
                <span>
                  Watching run ·{" "}
                  {watchState
                    ? runStatusUi(watchState.status).label
                    : "connecting…"}
                </span>
                {watchState && !isTerminal(watchState.status) && (
                  <span className="naary-watch-live">live · 1.5s</span>
                )}
                <button
                  type="button"
                  className="naary-watch-stop"
                  onClick={onStopWatching}
                >
                  Stop watching
                </button>
              </div>
            </Panel>
          )}
          {generating && (
            <Panel position="top-center">
              <div className="naary-gen-pill" role="status" aria-live="polite">
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
              onClick={onToggleFullscreen}
              aria-label={canvasFullscreen ? "Exit full screen" : "Full screen"}
              title={
                canvasFullscreen ? "Exit full screen (Esc)" : "Full screen"
              }
            >
              <Icon name={canvasFullscreen ? "x" : "expand"} size={15} />
            </button>
          </Panel>
        </ReactFlow>
      </NodeActionsContext.Provider>

      {/* hint pill (design comp copy, verbatim) — hidden ≤1024 where the graph
          viewport is capped and the drag-to-map loop lives in the stacked dock.

          It CLEARS THE ZOOM CONTROLS rather than sitting on them. <Controls /> is a
          react-flow bottom-LEFT panel: 15px panel margin + a 26px button + its 1px
          borders = 43px, so the pill starts at 55. `pointerEvents: none` meant the
          buttons still worked, but they were hidden underneath — which is worse than
          being unclickable, because nothing suggests they're there. */}
      {!stacked && (
        <div
          style={{
            position: "absolute",
            left: 55,
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
            // Tracks the left offset above, so a long hint wraps instead of running under the
            // full-screen toggle on a narrow canvas.
            maxWidth: "calc(100% - 75px)",
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
          Card colour = run state · icon colour = node type. Test a step with ▷,
          then drag its output into the next node.
        </div>
      )}

      {/* ≤1024: the category rail is hidden, so a floating "+" opens the full
          catalog modal (the node-add affordance). ≥44px touch target. */}
      {stacked && (
        <button
          type="button"
          aria-label="Add node"
          title="Add node"
          onClick={onOpenCatalog}
          style={{
            position: "absolute",
            right: 16,
            bottom: 16,
            width: 52,
            height: 52,
            borderRadius: "50%",
            border: "none",
            background:
              "radial-gradient(120% 120% at 50% 120%, #ffb347, #f2622e 55%, #c8331f)",
            boxShadow: "0 8px 24px -6px rgba(242, 98, 46, 0.6)",
            color: "#fff3ec",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            zIndex: 6,
          }}
        >
          <Icon name="plus" size={22} />
        </button>
      )}
    </div>
  );
}
