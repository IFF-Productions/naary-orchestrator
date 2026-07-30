/**
 * The diff rows, extracted from `DiffModal` so a diff computed in the browser (the canvas
 * reviewing an unsaved AI edit) renders exactly like one fetched from the server.
 *
 * `Everything` is the one to look at: it is the only place all five row kinds appear together,
 * including the two that change BEHAVIOUR without changing the node/edge set — a reorder (edge
 * order decides branch precedence) and a moved entry node. Those are easy to render as nothing.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { GraphDiff, NodeDef } from "@naary/dsl";
import { GraphDiffBody, GraphDiffCounts } from "./GraphDiffBody";

const meta: Meta<typeof GraphDiffBody> = {
  title: "Canvas/GraphDiffBody",
  component: GraphDiffBody,
  decorators: [
    (Story) => (
      <div style={{ padding: 22, maxWidth: 720, background: "var(--panel)" }}>
        <Story />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof GraphDiffBody>;

const n = (
  id: string,
  type: string,
  config?: Record<string, unknown>,
): NodeDef => ({ id, type, config }) as NodeDef;

const EMPTY: GraphDiff = {
  nodesAdded: [],
  nodesRemoved: [],
  nodesChanged: [],
  edgesAdded: [],
  edgesRemoved: [],
  edgesReordered: false,
  startNodeChanged: false,
};

/** What an AI fix typically produces: one node's config corrected, one guard added. */
export const TypicalFix: Story = {
  args: {
    diff: {
      ...EMPTY,
      nodesChanged: [
        {
          id: "pagerduty",
          before: n("pagerduty", "integration"),
          after: n("pagerduty", "integration"),
          fields: ["config"],
        },
      ],
      nodesAdded: [n("hasincidents", "if")],
      edgesAdded: [{ from: "pagerduty", to: "hasincidents" }],
    },
  },
};

/** Every row kind at once — the visual contract for the extraction. */
export const Everything: Story = {
  args: {
    diff: {
      nodesAdded: [n("hasincidents", "if"), n("notify", "integration")],
      nodesRemoved: [n("legacyhook", "webhookTrigger")],
      nodesChanged: [
        {
          id: "pagerduty",
          before: n("pagerduty", "integration"),
          after: n("pagerduty", "integration"),
          fields: ["config", "retry"],
        },
      ],
      edgesAdded: [
        {
          from: "hasincidents",
          to: "notify",
          condition: { path: "hasincidents.result", op: "eq", value: true },
        },
      ],
      edgesRemoved: [{ from: "legacyhook", to: "pagerduty" }],
      edgesReordered: true,
      startNodeChanged: true,
    },
  },
};

/** Renders NOTHING — the caller owns the wording for "no changes" in its own context. */
export const NoChanges: Story = { args: { diff: EMPTY } };

/** The summary line, which counts a reorder and a moved entry node as real changes. */
export const Counts: StoryObj<typeof GraphDiffCounts> = {
  render: () => (
    <GraphDiffCounts
      diff={{
        ...EMPTY,
        nodesAdded: [n("a", "set"), n("b", "set")],
        nodesRemoved: [n("c", "set")],
        edgesReordered: true,
        startNodeChanged: true,
      }}
    />
  ),
};
