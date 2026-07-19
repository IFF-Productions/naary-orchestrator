import type { Meta, StoryObj } from "@storybook/react-vite";
import { OutputInspector } from "./OutputInspector";

/**
 * The floating output inspector drawer (Canvas Authoring Loop): the selected
 * node's REAL output as per-field rows (name · value · type). Rows are
 * draggable — dropping one into an expression input inserts `{{ node.path }}`.
 */
const meta: Meta<typeof OutputInspector> = {
  title: "Canvas/Output inspector",
  component: OutputInspector,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div
        style={{
          position: "relative",
          height: 560,
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
type Story = StoryObj<typeof OutputInspector>;

const OUTPUT = {
  event: "deal.won",
  company: {
    name: "Northwind",
    domain: "northwind.io",
    industry: "Logistics",
    hq: "Austin, TX",
  },
  amount: 48000,
  owner: { email: "sam@acme.io" },
  tags: ["expansion", "q3"],
  approved: true,
  note: null,
};

/** A fresh test-run output with the measured wall-clock in the header. */
export const TestRun: Story = {
  args: {
    nodeId: "enrich",
    title: "Enrich company",
    output: OUTPUT,
    source: "test",
    runMs: 842,
    canPin: true,
    isPinned: false,
    onPin: () => {},
    onClose: () => {},
  },
};

/** The pinned authoring sample of a node (no measured duration — none exists). */
export const PinnedSample: Story = {
  args: {
    nodeId: "webhook",
    title: "Webhook",
    output: OUTPUT,
    source: "pin",
    isPinned: true,
    onClose: () => {},
  },
};

/** Upstream changed after this run — the stale banner asks for a re-run. */
export const Stale: Story = {
  args: {
    nodeId: "summarize",
    title: "Summarize deal",
    output: {
      summary:
        "Northwind (Logistics, Austin) closed a $48k expansion deal; risk low.",
      sentiment: "positive",
      recommend: "approve",
    },
    source: "test",
    runMs: 2570,
    stale: true,
    canPin: true,
    onPin: () => {},
    onClose: () => {},
  },
};
