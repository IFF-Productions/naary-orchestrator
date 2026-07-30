import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";
import type { EdgeDef, NodeDef } from "@naary/dsl";
import { ModeProvider } from "../../mode";
import {
  type BuildWithAiState,
  BuildWithAiView,
  INITIAL_BUILD_STATE,
} from "./build-ai/BuildWithAiView";
import { BuildWithAi } from "./BuildWithAi";
import { providerOptions } from "./build-ai/providers";

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
  // A session BOUND to a workflow — the resume list has to say so, because resuming this one
  // means picking up an edit of a live workflow rather than a scratch draft.
  {
    id: "bs-2",
    status: "open",
    workflowKey: "nightly-report",
    title: "Nightly report",
    updatedAt: new Date("2026-07-15T18:20:00Z").toISOString(),
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
  editing: null,
  seeding: false,
  editProblem: null,
  staleWarning: null,
};

/** The workflow an edit chat is bound to (`?key=nightly-report`). */
const EDITING = {
  workflowKey: "nightly-report",
  name: "Nightly report",
  baseVersion: 3,
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
      // Tappable quick replies on the newest assistant turn (#487) — the last chip
      // ("Looks good — save it") maps to Open in canvas; the rest become the next turn.
      options: ["Add error handling", "Add a retry", "Looks good — save it"],
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
// A typical workspace: an Anthropic key plus a Claude Code credential. Shared by the view stories so
// the "Generate with" picker under the composer renders in each of them.
const PROVIDER_OPTIONS = providerOptions([
  { provider: "anthropic", isValid: true },
  { provider: "claude-code", isValid: true },
]);
const viewHandlers = {
  onSend: noop,
  onResume: noop,
  onOpenInCanvas: noop,
  onConfirmStale: noop,
  onDismissStale: noop,
  onReset: noop,
  providerOptions: PROVIDER_OPTIONS,
  provider: null,
  onProvider: noop,
  providerHint: null,
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

/**
 * EDIT mode, real screen: `/app/build-ai?key=nightly-report`.
 *
 * `openBuilderSession({ workflowKey })` has always seeded a session's working draft from a
 * workflow's latest saved graph — no UI ever passed a key, so it was unreachable. Arriving with
 * `?key=` binds the chat: the saved graph is already on the stage, the banner names the workflow
 * and the version a Save will publish, and the column asks what to CHANGE rather than what to build.
 */
export const EditIntro: Story = {
  parameters: {
    router: { initialEntries: ["/app/build-ai?key=nightly-report"] },
    msw: {
      handlers: [
        http.get("*/api/builder/sessions", () => HttpResponse.json(SESSIONS)),
        http.get("*/api/graphs/nightly-report", () =>
          HttpResponse.json({
            workflowKey: "nightly-report",
            name: "Nightly report",
            version: 3,
            graph: {
              startNodeId: NODES[0].id,
              nodes: NODES,
              edges: EDGES,
            },
          }),
        ),
      ],
    },
  },
  render: () => <BuildWithAi />,
};

/** An edit turn landed: the CTA publishes the workflow's NEXT VERSION, not a forked copy (#874). */
export const EditDraftReady: Story = {
  render: () => (
    <BuildWithAiView
      state={{ ...READY, editing: EDITING, name: "Nightly report" }}
      {...viewHandlers}
    />
  ),
};

/**
 * The draft renamed the workflow. The edit prompt tells the model to preserve the name, but the
 * save path is what would actually apply a drifted one — so the banner says it before Save does it.
 */
export const EditRenames: Story = {
  render: () => (
    <BuildWithAiView
      state={{ ...READY, editing: EDITING, name: "Nightly digest" }}
      {...viewHandlers}
    />
  ),
};

/**
 * Someone saved the workflow while this chat was open. Publishing the draft would drop their
 * change, so the Save is refused and named — the only confirm on this path.
 */
export const EditStaleDraft: Story = {
  render: () => (
    <BuildWithAiView
      state={{
        ...READY,
        editing: EDITING,
        name: "Nightly report",
        staleWarning:
          "“Nightly report” has been saved since this chat started (v3 → v5). Saving publishes this draft as v6, dropping those changes.",
      }}
      {...viewHandlers}
    />
  ),
};

/** `?key=` pointed at a workflow we couldn't read — say so, rather than imply an edit is bound. */
export const EditWorkflowUnavailable: Story = {
  render: () => (
    <BuildWithAiView
      state={{
        ...INITIAL_BUILD_STATE,
        editing: { ...EDITING, baseVersion: null },
        editProblem:
          "Couldn't load “nightly-report” — it may have been deleted, or belong to a different environment. Check before you save.",
      }}
      {...viewHandlers}
    />
  ),
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

/**
 * The "Generate with" picker under the composer. It was always possible to choose — the builder-turn
 * DTO, the controller and `sendBuilderTurn` all accepted a provider — but the UI passed `undefined`,
 * so every generation silently used whatever the server auto-picked.
 *
 * Auto stays the default and sends no provider, leaving the server's precedence (first VALID
 * credential, API models before claude-code) untouched.
 */
export const ProviderAuto: Story = {
  render: () => (
    <BuildWithAiView state={READY} {...viewHandlers} provider={null} />
  ),
};

/** An explicit choice — the hint names the model that will actually run. */
export const ProviderClaudeCode: Story = {
  render: () => (
    <BuildWithAiView state={READY} {...viewHandlers} provider="claude-code" />
  ),
};

/**
 * A configured key that FAILED validation stays visible and disabled, rather than vanishing from the
 * list — "why isn't my OpenAI key here?" deserves an answer the user can act on.
 */
export const ProviderInvalidKey: Story = {
  render: () => (
    <BuildWithAiView
      state={READY}
      {...viewHandlers}
      providerOptions={providerOptions([
        { provider: "anthropic", isValid: true },
        { provider: "openai", isValid: false },
      ])}
      provider={null}
    />
  ),
};

/** Nothing configured at all: the picker is disabled and says where to go, BEFORE a prompt is typed. */
export const ProviderNoneConfigured: Story = {
  render: () => (
    <BuildWithAiView
      state={READY}
      {...viewHandlers}
      providerOptions={[]}
      provider={null}
      providerHint="Add an AI provider key (Anthropic, OpenAI or Google) or a Claude Code credential in Integrations to generate workflows."
    />
  ),
};
