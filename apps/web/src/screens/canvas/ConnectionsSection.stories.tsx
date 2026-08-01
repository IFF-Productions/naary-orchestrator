import type { Meta, StoryObj } from "@storybook/react-vite";
import type { Node } from "@xyflow/react";
import { useState } from "react";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { ConfigPanel } from "./ConfigPanel";
import type { ConnectEdge, ConnectNode } from "./connect-model";
import {
  appendConnection,
  moveConnection,
  outgoingConnections,
} from "./connect-model";
import { ConnectionsSection } from "./ConnectionsSection";
import type { NaaryData } from "./flow";
import { InspectorDock } from "./InspectorDock";

/**
 * "Connects to" (#1026) — connecting nodes from the config panel instead of dragging between two
 * handles on the canvas. Dragging is not keyboard-operable at all and is close to impossible on a
 * phone; this is the same edit made from a list.
 *
 * The rows are the node's outgoing edges IN EXECUTION ORDER and the ↑ ↓ controls edit that order.
 * The interpreter takes every outgoing edge whose condition passes, in this order — so the
 * sequence sets fan-out order and decides which branch's terminal status the run reports. Nothing
 * in this panel sorts; a tidier-looking alphabetical list would show one precedence and run
 * another.
 */
const meta: Meta<typeof ConnectionsSection> = {
  title: "Canvas/Connect from panel",
  component: ConnectionsSection,
  parameters: { layout: "centered" },
};
export default meta;
type Story = StoryObj<typeof ConnectionsSection>;

const NODES: ConnectNode[] = [
  { id: "webhook", kind: "webhookTrigger", label: "Deal webhook" },
  { id: "route", kind: "switch", label: "Route by value" },
  { id: "approve", kind: "humanApproval", label: "Human approval" },
  { id: "notify", kind: "sendEmail", label: "Email the team" },
  { id: "log", kind: "httpRequest", label: "Auto-log deal" },
  { id: "end", kind: "end", label: "End" },
];

/** Three branches off `route`, in the order the run takes them — NOT alphabetical, on purpose. */
const EDGES: ConnectEdge[] = [
  { id: "e-in", source: "webhook", target: "route" },
  {
    id: "e-approve",
    source: "route",
    target: "approve",
    data: { condition: { path: "route.matched", op: "eq", value: "high" } },
  },
  { id: "e-notify", source: "route", target: "notify" },
  {
    id: "e-log",
    source: "route",
    target: "log",
    data: { condition: { path: "route.matched", op: "eq", value: "low" } },
  },
  { id: "e-approve-end", source: "approve", target: "end" },
];

/** A live section: adding and reordering really edit the edge list, so the story shows the
 *  behaviour rather than three screenshots of it. */
function LiveSection({
  nodeId = "route",
  initial = EDGES,
  readOnly,
}: {
  nodeId?: string;
  initial?: ConnectEdge[];
  readOnly?: boolean;
}) {
  const [edges, setEdges] = useState<ConnectEdge[]>(initial);
  const node = NODES.find((n) => n.id === nodeId);
  return (
    <div style={{ width: 460 }}>
      <ConnectionsSection
        nodeId={nodeId}
        kind={node?.kind ?? "agent"}
        connect={{
          edges,
          nodes: NODES,
          readOnly,
          onAdd: (target) =>
            setEdges((es) =>
              appendConnection(es, {
                id: `e-${target}-${es.length}`,
                source: nodeId,
                target,
              }),
            ),
          onMove: (edgeId, dir) =>
            setEdges((es) => moveConnection(es, edgeId, dir)),
          onRemove: (edgeId) =>
            setEdges((es) => es.filter((e) => e.id !== edgeId)),
          // In the app this selects the edge, raising the existing Connection inspector.
          onEditCondition: () => {},
        }}
      />
    </div>
  );
}

/**
 * A switch node with THREE outgoing connections, listed in run order with their real conditions.
 * Add one from the picker and reorder one with ↑ ↓ — both edit the same list the canvas saves.
 */
export const RoutingBranches: Story = {
  render: () => <LiveSection />,
};

/**
 * The same edits driven with the KEYBOARD ONLY — no pointer anywhere in this play function. Tab to
 * the picker, choose a target, Enter to add; then Tab to a row's ↑ and press it. This is the half
 * of #1026 that dragging can never satisfy, so it is asserted rather than asserted-about.
 */
export const KeyboardOnly: Story = {
  render: () => <LiveSection />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    /** The OUTGOING targets, top to bottom — i.e. the order the run takes them in. (Scoped to
     *  that list by its accessible name; the section also renders a read-only incoming one.) */
    const targets = () =>
      within(canvas.getByRole("list", { name: /^Outgoing connections/ }))
        .getAllByRole("listitem")
        .map((li) => li.querySelector("span > span")?.textContent ?? "");

    await expect(targets()).toEqual([
      "Human approval",
      "Email the team",
      "Auto-log deal",
    ]);

    // ADD, from the keyboard: TAB to the picker (no click), choose a target, Enter to submit.
    const select = canvas.getByLabelText("Connect to");
    for (let i = 0; i < 20 && document.activeElement !== select; i++) {
      await userEvent.tab();
    }
    await expect(document.activeElement).toBe(select);
    // Choosing the option itself is the browser's own select behaviour (Alt+↓, arrows, type-ahead)
    // — not something this component implements, and not something automation can drive natively.
    // What matters here is that REACHING it and SUBMITTING need no pointer.
    await userEvent.selectOptions(select, "end");
    await userEvent.tab(); // → the Add button
    await userEvent.keyboard("{Enter}");
    // Appended LAST — where dragging would have put it, so the two paths agree.
    await expect(targets()[3]).toBe("End");

    // REORDER, from the keyboard: TAB to a row's ↑ and press Enter twice. Twice matters — the
    // rows are keyed by edge id, so focus follows the row it belongs to instead of landing on
    // whatever now occupies that position.
    const up = canvas.getByRole("button", {
      name: "Move the connection to Auto-log deal earlier",
    });
    for (let i = 0; i < 20 && document.activeElement !== up; i++) {
      await userEvent.tab();
    }
    await expect(document.activeElement).toBe(up);
    await userEvent.keyboard("{Enter}");
    await expect(targets()[1]).toBe("Auto-log deal");
    await userEvent.keyboard("{Enter}");
    await expect(targets()[0]).toBe("Auto-log deal");
    // At the top its ↑ is disabled, so focus is handed to the ↓ beside it rather than dropped.
    // (Handed over on the next frame — hence waitFor rather than a bare assertion.)
    await waitFor(() =>
      expect(document.activeElement).toBe(
        canvas.getByRole("button", {
          name: "Move the connection to Auto-log deal later",
        }),
      ),
    );
  },
};

/** A node nothing leaves yet — the run stops there until something is connected. */
export const NoOutgoing: Story = {
  render: () => <LiveSection nodeId="notify" />,
};

/** The terminal node: no outgoing connections exist and none are offered. */
export const TerminalNode: Story = {
  render: () => <LiveSection nodeId="end" />,
};

/** Watching a live run: the canvas disables drag/connect, so the list is read-only here too. */
export const WhileWatchingARun: Story = {
  render: () => <LiveSection readOnly />,
};

const ROUTE_NODE: Node<NaaryData> = {
  id: "route",
  type: "naary",
  position: { x: 0, y: 0 },
  data: { kind: "switch", config: { rules: [], fallback: "default" } },
};

/** In context: the section as it appears inside the real config panel, in the inspector dock. */
export const InTheInspectorDock: Story = {
  render: () => {
    const [edges, setEdges] = useState<ConnectEdge[]>(EDGES);
    return (
      <div style={{ display: "flex", justifyContent: "flex-end", height: 720 }}>
        <InspectorDock
          nodeId="route"
          kind="switch"
          title="Route by value"
          state="idle"
          routing={outgoingConnections("route", edges).map((o, i) => ({
            n: i + 1,
            cond: o.edge.data?.condition
              ? `${o.edge.data.condition.path} ${o.edge.data.condition.op} ${o.edge.data.condition.value}`
              : "always",
            target: NODES.find((n) => n.id === o.edge.target)?.label,
          }))}
          routingTitle="Branches · every matching edge fires"
          routingNote="Each outgoing edge is taken when its condition holds; unconditional edges always fire."
          parameters={
            <ConfigPanel
              node={ROUTE_NODE}
              hideHeader
              upstreamIds={["webhook"]}
              edges={edges}
              nodeKinds={{ webhook: "webhookTrigger", route: "switch" }}
              hookUrls={[]}
              connections={[]}
              pins={{}}
              canPin={false}
              pinnedOutput={undefined}
              isPinned={false}
              onPin={async () => {}}
              onUnpin={async () => {}}
              onTest={async () => ({ pure: true, output: {} })}
              onChange={() => {}}
              connect={{
                edges,
                nodes: NODES,
                onAdd: (target) =>
                  setEdges((es) =>
                    appendConnection(es, {
                      id: `e-${target}-${es.length}`,
                      source: "route",
                      target,
                    }),
                  ),
                onMove: (edgeId, dir) =>
                  setEdges((es) => moveConnection(es, edgeId, dir)),
                onRemove: (edgeId) =>
                  setEdges((es) => es.filter((e) => e.id !== edgeId)),
                onEditCondition: () => {},
              }}
            />
          }
          onDelete={() => {}}
        />
      </div>
    );
  },
};
