/**
 * "Review changes" — what a save would persist, as a diff against the last saved version.
 *
 * `AfterAiEdit` is the state this exists for: an AI edit rewrites the whole graph and hands it
 * back, and until now the only report of what it did was the canvas itself. The edit prompt tells
 * the model to keep untouched nodes BYTE-FOR-BYTE; nothing asserted that. This panel is where a
 * violation becomes visible — as extra changed rows nobody asked for.
 *
 * `Uncompilable` is the other one worth looking at: it must NOT read as "no changes". The canvas
 * only got into that state by being edited, so silence there would be the opposite of the truth.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { GraphDef } from "@naary/dsl";
import { ReviewChangesPanel } from "./ReviewChangesPanel";

const BASE: GraphDef = {
  startNodeId: "schedule",
  nodes: [
    {
      id: "schedule",
      type: "scheduleTrigger",
      config: { cron: "*/5 * * * *" },
    },
    {
      id: "pagerduty",
      type: "integration",
      config: { provider: "pagerduty", action: "listIncidents" },
    },
    { id: "agent", type: "agent", config: { model: "claude-sonnet-5" } },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "schedule", to: "pagerduty" },
    { from: "pagerduty", to: "agent" },
    { from: "agent", to: "end" },
  ],
};

const meta: Meta<typeof ReviewChangesPanel> = {
  title: "Canvas/ReviewChangesPanel",
  component: ReviewChangesPanel,
  args: {
    baseline: BASE,
    baselineName: "pagerduty-incident-triage",
    name: "pagerduty-incident-triage",
    onClose: () => {},
  },
  decorators: [
    (Story) => (
      <div style={{ background: "var(--bg)", maxWidth: 900 }}>
        <Story />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof ReviewChangesPanel>;

/** A fix that added a guard and corrected the failing node — exactly what it should show. */
export const AfterAiEdit: Story = {
  args: {
    graph: {
      ...BASE,
      nodes: [
        BASE.nodes[0],
        {
          id: "pagerduty",
          type: "integration",
          config: {
            provider: "pagerduty",
            action: "listIncidents",
            headers: { From: "ops@example.com" },
          },
        },
        { id: "hasincidents", type: "if", config: {} },
        BASE.nodes[2],
        BASE.nodes[3],
      ],
      edges: [
        { from: "schedule", to: "pagerduty" },
        { from: "pagerduty", to: "hasincidents" },
        {
          from: "hasincidents",
          to: "agent",
          condition: { path: "hasincidents.result", op: "eq", value: true },
        },
        { from: "agent", to: "end" },
      ],
    },
  },
};

/** Saved and untouched — says so plainly rather than showing an empty box. */
export const NoChanges: Story = { args: { graph: BASE } };

/** A rename is real unsaved work and is invisible in a STRUCTURAL diff, so it gets its own line. */
export const RenamedOnly: Story = {
  args: { graph: BASE, name: "pagerduty-triage-v2" },
};

/** The canvas doesn't compile. Must not read as "no changes" — it got here by being edited. */
export const Uncompilable: Story = { args: { graph: undefined } };
