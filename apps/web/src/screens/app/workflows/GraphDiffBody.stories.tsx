/**
 * The diff rows, extracted from `DiffModal` so a diff computed in the browser (the canvas
 * reviewing an unsaved AI edit) renders exactly like one fetched from the server.
 *
 * `Everything` is the one to look at: it is the only place all row kinds appear together,
 * including the two that change BEHAVIOUR without changing the node/edge set — a reorder (edge
 * order decides branch precedence) and a moved entry node. Those are easy to render as nothing.
 *
 * `OneNodeManyChanges` is the other one to look at, and it is the visual contract for #1020's
 * hard rule: a node edited in six ways is ONE tile with six lines inside it. If a future change
 * makes that story render six tiles, the rule has been broken.
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
  edgesChanged: [],
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
          // BEFORE #1020 this whole tile read `pagerduty · config` and nothing else.
          details: [
            {
              path: "config.body.title",
              kind: "changed",
              before: '"Incident {{ webhook.body.id }}"',
              after: '"🚨 P1 incident {{ webhook.body.id }}"',
            },
            {
              path: "config.body.urgency",
              kind: "changed",
              before: '"low"',
              after: '"high"',
            },
          ],
          detailsOmitted: 0,
        },
      ],
      nodesAdded: [n("hasincidents", "if")],
      edgesAdded: [{ from: "pagerduty", to: "hasincidents" }],
    },
  },
};

/**
 * #1020's hard rule, made visible: SIX changes to one node, ONE tile.
 *
 * Rendering a row per field change would put six near-identical tiles here and bury the node that
 * changed once. The reviewer's unit is "which nodes am I promoting", so the tile count tracks
 * nodes, and the breakdown lives inside.
 */
export const OneNodeManyChanges: Story = {
  args: {
    diff: {
      ...EMPTY,
      nodesChanged: [
        {
          id: "triage",
          before: n("triage", "agent"),
          after: n("triage", "agent"),
          fields: ["name", "config", "retry"],
          details: [
            {
              path: "name",
              kind: "changed",
              before: '"Classify"',
              after: '"Triage the ticket"',
            },
            {
              path: "config.model",
              kind: "changed",
              before: '"claude-sonnet-5"',
              after: '"claude-opus-4-8"',
            },
            {
              path: "config.temperature",
              kind: "added",
              after: "0.2",
            },
            {
              path: "config.maxSteps",
              kind: "removed",
              before: "8",
            },
            {
              path: "config.tools",
              kind: "changed",
              before: '["search"]',
              after: '["search","lookup_customer"]',
              note: "1 items → 2 items",
            },
            {
              path: "retry.maxAttempts",
              kind: "changed",
              before: "3",
              after: "5",
            },
          ],
          detailsOmitted: 0,
        },
      ],
    },
  },
};

/**
 * A prompt is unbounded; a review row is not. The value is clipped AT THE SOURCE and the clipped
 * string says so — the row must never look like the prompt itself got shorter. The last row shows
 * the per-node cap announcing its own overflow for the same reason.
 */
export const TruncatedAndCapped: Story = {
  args: {
    diff: {
      ...EMPTY,
      nodesChanged: [
        {
          id: "triage",
          before: n("triage", "agent"),
          after: n("triage", "agent"),
          fields: ["config"],
          details: [
            {
              path: "config.systemPrompt",
              kind: "changed",
              before: `"You are a support triage assistant. Read the ticket and classify it into one of: billing, technical, account. ${"…".repeat(
                20,
              )}… [truncated, 4183 chars total]`,
              after: `"You are a support triage assistant. Read the ticket, classify it, and ALWAYS quote the order id back. ${"…".repeat(
                20,
              )}… [truncated, 4402 chars total]`,
              truncated: true,
            },
          ],
          detailsOmitted: 12,
        },
      ],
    },
  },
};

/**
 * An edited condition. Before #1020 this rendered as an "edge removed" tile beside an "edge added"
 * one — the same edit shown twice, reading as routing torn out and rebuilt when only a threshold
 * moved. Note the VALUE on both sides: without it both halves read `when … gt`.
 */
export const EdgeConditionEdited: Story = {
  args: {
    diff: {
      ...EMPTY,
      edgesChanged: [
        {
          from: "hasincidents",
          to: "page-oncall",
          before: { path: "hasincidents.count", op: "gt", value: 5 },
          after: { path: "hasincidents.count", op: "gt", value: 10 },
        },
      ],
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
          details: [
            {
              path: "config.action",
              kind: "changed",
              before: '"incident.list"',
              after: '"incident.create"',
            },
            {
              path: "config.fields[key=urgency]",
              kind: "added",
              after: '{"key":"urgency","value":"high"}',
            },
            {
              path: "retry.maxAttempts",
              kind: "changed",
              before: "3",
              after: "5",
            },
          ],
          detailsOmitted: 0,
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
      edgesChanged: [
        {
          from: "pagerduty",
          to: "hasincidents",
          before: { path: "pagerduty.status", op: "eq", value: 200 },
          after: { path: "pagerduty.status", op: "lt", value: 300 },
        },
      ],
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
