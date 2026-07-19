import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";
import type { EdgeDef, NodeDef } from "@naary/dsl";
import { ModeProvider } from "../../mode";
import {
  type BuildWithAiState,
  BuildWithAiView,
} from "./build-ai/BuildWithAiView";
import { BuildWithAi } from "./BuildWithAi";

/**
 * Two flavors:
 *  - the REAL screen (`BuildWithAi`) against msw for the intro / resume states;
 *  - the presentational `BuildWithAiView` with injected mid-stream state for the
 *    Building / Draft-ready moments (a static story can't hold an SSE mid-frame).
 */

const SESSIONS = [
  {
    id: "bs-1",
    status: "open",
    workflowKey: null,
    title: "Refund approval flow",
    updatedAt: new Date("2026-07-16T09:05:00Z").toISOString(),
  },
];

// A refund flow mid-build — the shapes the turn SSE actually streams (NodeDef/EdgeDef).
const NODES: NodeDef[] = [
  { id: "form", type: "formTrigger", config: { title: "Refund request" } },
  {
    id: "policy",
    type: "switch",
    config: { path: "form.amount" },
  },
  {
    id: "approve",
    type: "humanApproval",
    config: { instructions: "Approve refunds over $500" },
  },
  {
    id: "issue",
    type: "httpRequest",
    config: { method: "POST", url: "https://api.stripe.com/v1/refunds" },
  },
  {
    id: "notify",
    type: "sendEmail",
    config: { to: "customer@example.com" },
  },
];
const EDGES: EdgeDef[] = [
  { from: "form", to: "policy" },
  {
    from: "policy",
    to: "approve",
    condition: { path: "form.amount", op: "gt", value: 500 },
  },
  { from: "approve", to: "issue" },
  {
    from: "policy",
    to: "issue",
    condition: { path: "form.amount", op: "lte", value: 500 },
  },
  { from: "issue", to: "notify" },
];

const BUILDING: BuildWithAiState = {
  phase: "streaming",
  messages: [
    {
      id: "u1",
      role: "user",
      text: "When a refund request arrives, ask me to approve big ones, then issue it via Stripe",
    },
  ],
  typing: false,
  name: "Refund approval flow",
  streamNodes: NODES.slice(0, 3),
  streamEdges: EDGES.slice(0, 2),
  gotFrame: true,
  error: null,
  resumables: [],
  opening: false,
};

const READY: BuildWithAiState = {
  ...BUILDING,
  phase: "ready",
  messages: [
    ...BUILDING.messages,
    {
      id: "a1",
      role: "assistant",
      text: "Built “Refund approval flow” — 5 nodes, 5 connections.",
      costUsd: 0.0123,
    },
  ],
  streamNodes: NODES,
  streamEdges: EDGES,
};

const TYPING: BuildWithAiState = {
  ...BUILDING,
  name: null,
  streamNodes: [],
  streamEdges: [],
  gotFrame: false,
  typing: true,
};

const noop = () => {};
const viewHandlers = {
  onSend: noop,
  onResume: noop,
  onOpenInCanvas: noop,
  onReset: noop,
};

const meta: Meta = {
  title: "Screens/Build with AI",
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <ModeProvider>
        <div style={{ background: "var(--bg)", minHeight: "100vh" }}>
          <Story />
        </div>
      </ModeProvider>
    ),
  ],
};
export default meta;
type Story = StoryObj;

/** The intro empty state: example-idea chips + a real resumable session (msw). */
export const Intro: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/api/builder/sessions", () => HttpResponse.json(SESSIONS)),
      ],
    },
  },
  render: () => <BuildWithAi />,
};

/** Turn accepted, first frame not in yet — typing dots, pill = Building. */
export const Thinking: Story = {
  render: () => <BuildWithAiView state={TYPING} {...viewHandlers} />,
};

/** Mid-stream: plan card checking off real frames, nodes gliding onto the stage. */
export const Building: Story = {
  render: () => <BuildWithAiView state={BUILDING} {...viewHandlers} />,
};

/** Terminal result frame landed: Draft ready, assistant change-summary (with its
 *  real metered turn cost), Open in canvas CTA. */
export const DraftReady: Story = {
  render: () => <BuildWithAiView state={READY} {...viewHandlers} />,
};
