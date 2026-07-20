import type { Meta, StoryObj } from "@storybook/react-vite";
import type { Node } from "@xyflow/react";
import { ConfigPanel } from "./ConfigPanel";
import { EdgeInspector } from "./EdgeInspector";
import type { NaaryData } from "./flow";
import { InspectorDock } from "./InspectorDock";

/**
 * The inspector dock (Canvas Authoring Loop): the persistent 492px right column.
 * Selected node → sticky header (type-accent tile · name · state pill · trash) +
 * Test step / Pin action row, INPUT DATA (draggable rows from upstream outputs),
 * PARAMETERS (the real ConfigPanel — expression fields are drop targets) and the
 * OUTPUT / LOGS tabs. A selected edge overlays it with the Connection inspector.
 */
const meta: Meta<typeof InspectorDock> = {
  title: "Canvas/Inspector dock",
  component: InspectorDock,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          height: 720,
          background:
            "radial-gradient(120% 90% at 20% 0%, var(--grad-a), var(--bg) 60%)",
        }}
      >
        <Story />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof InspectorDock>;

const AGENT_NODE: Node<NaaryData> = {
  id: "summarize",
  type: "naary",
  position: { x: 0, y: 0 },
  data: {
    kind: "agent",
    config: {
      provider: "anthropic",
      model: "claude-opus-4-8",
      systemPrompt:
        "Summarize this deal for the approver, flag risk, and recommend approve or reject.",
    },
  },
};

const EDGES = [
  { source: "webhook", target: "enrich" },
  { source: "enrich", target: "summarize" },
];

const INPUT_ROWS = [
  {
    key: "webhook.company.name",
    token: "{{ webhook.company.name }}",
    path: "company.name",
    preview: '"Northwind"',
    tag: "pinned",
  },
  {
    key: "webhook.amount",
    token: "{{ webhook.amount }}",
    path: "amount",
    preview: "48000",
    tag: "pinned",
  },
  {
    key: "enrich.industry",
    token: "{{ enrich.industry }}",
    path: "industry",
    preview: '"Logistics"',
    tag: "Enrich company",
  },
  {
    key: "enrich.risk",
    token: "{{ enrich.risk }}",
    path: "risk",
    preview: '"low"',
    tag: "Enrich company",
  },
];

const parameters = (
  <ConfigPanel
    node={AGENT_NODE}
    hideHeader
    upstreamIds={["webhook", "enrich"]}
    edges={EDGES}
    nodeKinds={{ webhook: "webhookTrigger", enrich: "httpRequest" }}
    hookUrls={[]}
    connections={[]}
    pins={{ webhook: { company: { name: "Northwind" }, amount: 48000 } }}
    canPin
    pinnedOutput={undefined}
    isPinned={false}
    onPin={async () => {}}
    onUnpin={async () => {}}
    onTest={async () => ({
      pure: true,
      output: {},
      // Slice 2: the server returns the run's own measured duration + metered cost.
      durationMs: 640,
      costUsd: 0.0012,
    })}
    onChange={() => {}}
  />
);

/** A selected agent node with real parameters, upstream INPUT DATA rows and a
 *  finished test output (draggable green rows + measured wall-clock). */
export const SelectedWithOutput: Story = {
  args: {
    nodeId: "summarize",
    kind: "agent",
    title: "Summarize deal",
    state: "done",
    run: {
      status: "done",
      ms: 2570,
      output: {
        summary:
          "Northwind (Logistics, Austin) closed a $48k expansion deal; risk low.",
        sentiment: "positive",
        recommend: "approve",
      },
    },
    canPin: true,
    inputRows: INPUT_ROWS,
    parameters,
    onTest: () => {},
    onPin: () => {},
    onUnpin: () => {},
    onDelete: () => {},
  },
};

/** No test run yet — the dashed "No output yet — press Test step" empty card. */
export const SelectedNoOutput: Story = {
  args: {
    nodeId: "summarize",
    kind: "agent",
    title: "Summarize deal",
    state: "idle",
    canPin: true,
    inputRows: INPUT_ROWS,
    parameters,
    onTest: () => {},
    onDelete: () => {},
  },
};

/** While the single-node test runs: spinner pill + live elapsed + sheen bar. */
export const Running: Story = {
  args: {
    nodeId: "summarize",
    kind: "agent",
    title: "Summarize deal",
    state: "running",
    run: { status: "running", startedAt: Date.now() - 1400 },
    canPin: true,
    inputRows: INPUT_ROWS,
    parameters,
    onTest: () => {},
    onDelete: () => {},
  },
};

/** A switch node: the routing-rules read-view derived from real config + edges,
 *  with MATCHED/SKIPPED badges from a real test output's `matched` field. */
export const SwitchRouting: Story = {
  args: {
    nodeId: "route",
    kind: "switch",
    title: "Route by value",
    state: "done",
    run: {
      status: "done",
      ms: 8,
      output: { matched: "high", amount: 48000 },
    },
    canPin: true,
    routing: [
      {
        n: 1,
        cond: "amount gte 25000",
        target: "Human approval",
        badge: "matched",
      },
      {
        n: 2,
        cond: "else (default)",
        target: "Auto-log deal",
        badge: "skipped",
      },
    ],
    routingTitle: "Routing rules · first match wins",
    routingNote:
      "The first matching rule sets route.matched to its name; outgoing edges branch on it (matched eq <name>).",
    inputRows: INPUT_ROWS,
    onTest: () => {},
    onDelete: () => {},
  },
};

/** Nothing selected — the calm empty state. */
export const Empty: Story = { args: {} };

/** A selected edge overlays the dock with the Connection inspector (real
 *  condition editor + the red delete-edge confirm card). */
export const EdgeConnection: Story = {
  args: {
    overlay: (
      <EdgeInspector
        sourceLabel="Route by value"
        targetLabel="Human approval"
        condition={{ path: "route.matched", op: "eq", value: "high" }}
        onChange={() => {}}
        onClear={() => {}}
        onDelete={() => {}}
        onClose={() => {}}
      />
    ),
  },
};
