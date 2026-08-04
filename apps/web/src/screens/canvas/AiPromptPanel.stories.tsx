/**
 * The canvas AI panel, which used to have exactly one behaviour: type a description, press
 * Generate, get a workflow dropped over whatever was on the canvas. Refining meant retyping the
 * whole request, and nothing on screen remembered what had already been asked for.
 *
 * It is now the SAME conversation as the Build with AI screen (#1003) — the identical
 * `ConversationPanel`, in its `drawer` variant, with the canvas-specific parts passed in: the
 * `?fix=` disclosure banner, the edit-vs-create chooser, and a status header. Since #1090 it is a
 * RESIZABLE DRAWER beside the graph rather than a strip above it, which is why every story renders
 * it next to a stand-in canvas: what these are checking is the split, not just the panel.
 *
 * So the states worth looking at come in two groups.
 *
 * THE CONVERSATION: `Empty` → `Building` → `Conversation`. What matters is that a follow-up is a
 * MESSAGE, not a re-description, and that the assistant's summary, its cost and its quick replies
 * all come from the server rather than being invented in the browser.
 *
 * THE `?fix=` ARRIVAL: `FromFailedRun` and the four states around it. The description is a PREFILLED
 * DRAFT in the composer — never an auto-sent message — because sending a tenant's run data to a
 * model is not something to do on a navigation. `FixReadingRun` is the one to check for regressions:
 * the box is read-only, not disabled, while the description is being written into it.
 */
import { buildFixInstruction, type GraphDef, type NodeDef } from "@naary/dsl";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { SAVE_OPTION } from "../../lib/api/builder";
import { BELOW_RAIL_QUERY, useMediaQuery } from "../../lib/useMediaQuery";
import type { BuildPhase, ChatMsg } from "../app/build-ai/ConversationPanel";
import { planFromStream } from "../app/build-ai/model";
import type { ProviderOption } from "../app/build-ai/providers";
import { AiPromptPanel, type FixNotice } from "./AiPromptPanel";
import type { AiMode } from "./useAiBuilder";

/** What a workspace with two configured provider keys offers (see ./build-ai/providers). */
const PROVIDER_OPTIONS: ProviderOption[] = [
  {
    id: "anthropic",
    label: "Claude",
    hint: "Anthropic API · claude-opus-4-8",
    selectable: true,
  },
  {
    id: "claude-code",
    label: "Claude Code",
    hint: "Runs the local claude CLI as an agent",
    selectable: true,
  },
];

/** Stateful wrapper — the mode, the composer draft and the provider are all controlled, so a
 *  story needs an owner for them. */
function Harness({
  initialMode,
  canEdit,
  phase = "idle",
  typing = false,
  messages = [],
  plan = null,
  error = null,
  fixNotice = null,
  initialPrompt = "",
  width,
}: {
  initialMode: AiMode;
  canEdit: boolean;
  phase?: BuildPhase;
  typing?: boolean;
  messages?: ChatMsg[];
  plan?: ReturnType<typeof planFromStream> | null;
  error?: string | null;
  fixNotice?: FixNotice | null;
  initialPrompt?: string;
  width?: number;
}) {
  const [mode, setMode] = useState<AiMode>(initialMode);
  const [prompt, setPrompt] = useState(initialPrompt);
  const [provider, setProvider] = useState<ProviderOption["id"] | null>(null);
  // The same query CanvasPage uses for `stacked` — the harness has to switch axis where the real
  // body does, or the compact stories are decorative rather than representative.
  const compact = useMediaQuery(BELOW_RAIL_QUERY);
  return (
    // The canvas BODY, in miniature: a flex container of a fixed height, with something standing
    // in for the graph. The panel is a drawer now (#1090) — it sizes itself and the canvas takes
    // what is left — so a story that gave it the full width would show precisely the layout the
    // drawer exists to replace.
    //
    // The DIRECTION has to match the real body, not just look similar. Below 1024px CanvasPage
    // switches to a column and the panel gives itself `order: 1` to land below the stage; in a row
    // that same order would put it to the RIGHT of the canvas, and the compact stories would show
    // a layout that does not exist.
    <div
      style={{
        display: "flex",
        flexDirection: compact ? "column" : "row",
        position: "relative",
        width: width ?? 940,
        height: 620,
        background: "var(--bg)",
      }}
    >
      <AiPromptPanel
        aiPrompt={prompt}
        onPromptChange={setPrompt}
        aiMode={mode}
        onModeChange={setMode}
        canEdit={canEdit}
        workflowName="On-call escalation"
        messages={messages}
        phase={phase}
        typing={typing}
        plan={plan}
        error={error}
        onSend={() => {}}
        onReset={() => {}}
        onAccept={() => {}}
        provider={provider}
        onProvider={setProvider}
        providerOptions={PROVIDER_OPTIONS}
        providerHint={null}
        fixNotice={fixNotice}
        onClose={() => {}}
      />
      {/* Stands in for the graph. Its visibility IS the feature: the drawer replaced a strip that
          pushed the canvas off-screen exactly while nodes were streaming onto it. */}
      <div
        style={{
          flex: 1,
          display: "grid",
          placeItems: "center",
          fontSize: "var(--text-xs)",
          color: "var(--ink-3)",
        }}
      >
        the canvas stays visible, and keeps its full height
      </div>
    </div>
  );
}

/**
 * What arriving from a failed run puts in the box — GENERATED by the real `buildFixInstruction`,
 * not transcribed from it.
 *
 * A hand-written copy of this text drifted within a day of the function changing, and a story that
 * shows a prompt users never see is worse than no story: this one exists so the DISCLOSURE can be
 * reviewed, and a stale sample means reviewing something that isn't being sent. Generating it also
 * keeps the banner's step list below honest, since both come from the same call.
 *
 * The fixture is a realistic failure: `title` references `lookup.body.titel` — a typo — so the
 * AS-IT-RAN block shows it as `<unresolved>` while the authored config shows the reference. That
 * contrast is the whole point of the feature, so the story leads with it.
 */
const FIX_GRAPH = {
  startNodeId: "schedule",
  nodes: [
    {
      id: "schedule",
      type: "scheduleTrigger",
      config: { cron: "*/5 * * * *" },
    },
    {
      id: "crm_fetch",
      type: "httpRequest",
      config: { url: "https://crm/acct" },
    },
    {
      id: "lookup",
      type: "httpRequest",
      config: { url: "https://api/incidents/{{ __input.ticketId }}" },
    },
    {
      id: "pagerduty",
      type: "integration",
      config: {
        provider: "pagerduty",
        action: "createIncident",
        title: "{{ lookup.body.titel }}",
        region: "{{ $vars.REGION }}",
        auth: "{{ $secrets.PD_TOKEN }}",
      },
    },
  ],
  edges: [
    { from: "schedule", to: "crm_fetch" },
    { from: "crm_fetch", to: "lookup" },
    { from: "lookup", to: "pagerduty" },
  ],
} as unknown as GraphDef;

const FIX = buildFixInstruction({
  graph: FIX_GRAPH,
  failedNodeId: "pagerduty",
  error: "Missing required header 'From'",
  failureKind: "provider_error",
  http: {
    request: { method: "POST", url: "https://api.pagerduty.com/incidents" },
    response: { status: 400, statusText: "Bad Request" },
  },
  ctx: {
    __input: { ticketId: "NAARY-42", source: "cron" },
    __costUsd: 0.0231,
    $vars: { REGION: "eu-west-1" },
    schedule: { firedAt: "2026-07-31T14:22:03.000Z" },
    crm_fetch: { account: "acme", tier: "enterprise" },
    lookup: { status: 200, body: { title: "Disk full on web-03" } },
  },
});
const FIX_INSTRUCTION = FIX.instruction;

/**
 * The "Building" card, built by the REAL `planFromStream` from the same node shapes the turn SSE
 * emits — so what a story shows is what a stream produces, not a hand-drawn approximation of it.
 */
const STREAMED: NodeDef[] = FIX_GRAPH.nodes.slice(0, 3);
const PLAN = planFromStream("On-call escalation", STREAMED, 2, false);
const PLAN_DONE = planFromStream(
  "On-call escalation",
  FIX_GRAPH.nodes,
  3,
  true,
);

/** A thread as the server returns it: the user's own words, the assistant's change-summary, its
 *  metered BYOK cost and its quick replies. Nothing here is composed client-side. */
const THREAD: ChatMsg[] = [
  {
    id: "t1",
    role: "user",
    text: "Page the on-call engineer when a disk alert comes in",
  },
  {
    id: "t2",
    role: "assistant",
    text: "Built “On-call escalation” — 4 steps, starting from a schedule trigger.",
    costUsd: 0.0231,
    options: [],
  },
  {
    id: "t3",
    role: "user",
    text: "Ask me to approve it before it pages anyone",
  },
  {
    id: "t4",
    role: "assistant",
    text: "Added an approval before the PagerDuty step — 5 steps now.",
    costUsd: 0.0164,
    options: [
      "Notify the requester when it's approved",
      "Retry PagerDuty twice before giving up",
      SAVE_OPTION,
    ],
  },
];

const meta: Meta<typeof Harness> = {
  title: "Canvas/AiPromptPanel",
  component: Harness,
};
export default meta;
type Story = StoryObj<typeof Harness>;

/* ---------------- the conversation ---------------- */

/**
 * A canvas holding a workflow, before the first message. The intro says which workflow every
 * message will change — the mistake this panel used to make was letting "change it" and "replace
 * it" look identical — and offers openers that are CHANGES rather than whole workflows.
 */
export const Empty: Story = { args: { initialMode: "edit", canEdit: true } };

/** The same canvas with "Start a new one" chosen: the destructive path, explicitly picked. The
 *  chooser is what stands between a follow-up message and a silently replaced workflow. */
export const Replace: Story = {
  args: { initialMode: "create", canEdit: true },
};

/** Empty (or uncompilable) canvas: nothing to change, so the chooser doesn't appear at all. */
export const NewCanvas: Story = {
  args: { initialMode: "create", canEdit: false },
};

/**
 * Mid-turn. The typing dots covered the gap before the first frame; now the plan card mirrors the
 * real `node`/`edge` frames as the workflow draws itself on the canvas below.
 */
export const Building: Story = {
  args: {
    initialMode: "edit",
    canEdit: true,
    phase: "streaming",
    messages: THREAD.slice(0, 3),
    plan: PLAN,
  },
};

/**
 * The turn is accepted and nothing has arrived yet — dots, not a frozen panel.
 *
 * Deliberately NOT the rotating status copy the Build with AI page shows in this same window (see
 * Screens/Build with AI → Thinking). This strip sits above a live canvas, and on that canvas the
 * `.naary-gen-pill` is ALREADY rotating those exact lines top-center for the whole of `phase ===
 * "streaming"` — which contains this moment. Two rotating strings on one screen read as two
 * different things happening. The panel stays quiet and lets the pill do it.
 */
export const Typing: Story = {
  args: {
    initialMode: "edit",
    canEdit: true,
    phase: "streaming",
    typing: true,
    messages: THREAD.slice(0, 3),
  },
};

/**
 * The state the whole change exists for: a real multi-turn thread. The second ask is a SENTENCE,
 * not a re-description of the workflow, and the newest assistant turn carries the quick replies —
 * including "Looks good — save it", which runs the canvas's own Save.
 */
export const Conversation: Story = {
  args: {
    initialMode: "edit",
    canEdit: true,
    phase: "ready",
    messages: THREAD,
    plan: PLAN_DONE,
  },
};

/**
 * A turn that failed. The thread survives it — the error sits in the conversation and the previous
 * draft is still on the canvas, because a transient 429 must not cost the user their work.
 */
export const TurnFailed: Story = {
  args: {
    initialMode: "edit",
    canEdit: true,
    phase: "ready",
    messages: THREAD,
    error: "Your anthropic API key was rejected. Update it in Integrations.",
  },
};

/* ---------------- arriving from a failed run (`?fix=`) ---------------- */

/**
 * Arrived from a FAILED run (`?fix=<runId>`): the failure is already written up in the composer,
 * and the banner NAMES the steps whose output goes with it. A count ("output from 3 steps") is not
 * something a user can check; a list is, and the message itself is right there to read in full.
 *
 * It is a DRAFT, not a sent message. The user reads it, edits anything, and presses Send — the one
 * decision this screen must not make on their behalf.
 *
 * The text is worth reading rather than skimming, since it is the whole disclosure. Note the
 * AS-IT-RAN block: the authored title is `{{ lookup.body.titel }}` (a typo) and what actually went
 * out is marked `<unresolved>`. That is the bug this feature exists to make visible, and it is
 * invisible in the template alone. Note also that the secret and `$vars` stay tokens in both.
 */
export const FromFailedRun: Story = {
  args: {
    initialMode: "edit",
    canEdit: true,
    initialPrompt: FIX_INSTRUCTION,
    fixNotice: {
      runId: "exec-t-demo-ce20c38b",
      drift: null,
      // From the same call that produced the prompt — the banner and the text cannot disagree.
      includedNodeIds: FIX.includedNodeIds,
      error: null,
      stage: "done",
    },
  },
};

/**
 * The same arrival on a PHONE — a viewport this panel is genuinely reachable at.
 *
 * The canvas top bar hides its "Build with AI" button below the rail breakpoint, so it looked like
 * a state that could not happen. It can: `useFixFromRun` calls `setShowAi(true)` unconditionally,
 * and `/app/canvas?key=…&fix=…` is one tap from the run detail's "Fix with AI".
 *
 * So the panel has to leave some canvas visible on a ~390px screen while still showing the whole
 * disclosure. Two things give it the room: the intro block is dropped (the banner already names
 * the run and what happens next), and the composer's cap tightens. The banner itself is never
 * trimmed — it is the disclosure, and a phone is not a reason to say less about what leaves the
 * tenant.
 */
export const FromFailedRunPhone: Story = {
  args: {
    initialMode: "edit",
    canEdit: true,
    width: 390,
    initialPrompt: FIX_INSTRUCTION,
    fixNotice: {
      runId: "exec-t-demo-ce20c38b",
      drift: null,
      includedNodeIds: FIX.includedNodeIds,
      error: null,
      stage: "done",
    },
  },
};

/** The run executed an OLDER version than the canvas now holds — said plainly, not hidden. */
export const VersionDrift: Story = {
  args: {
    initialMode: "edit",
    canEdit: true,
    initialPrompt: FIX_INSTRUCTION,
    fixNotice: {
      runId: "exec-t-demo-ce20c38b",
      drift: { runVersion: 3, currentVersion: 7 },
      includedNodeIds: ["schedule"],
      error: null,
      stage: "done",
    },
  },
};

/**
 * The first moment after pressing "Fix with AI" — the workflow is still opening.
 *
 * This is the state that was MISSING: the canvas appeared, the panel didn't, and nothing said the
 * description was on its way, so the honest reading was that the button had done nothing. The box
 * is already full height here, so the description lands without the panel jumping — now via
 * `composerMinHeight` rather than a `rows` count, since the composer is the shared one (#1003).
 *
 * It was also, for a while, a story for a state the app could not reach: `fixStage` asked
 * `hasGraph` first, and the canvas's SEED nodes compile, so it went straight to `reading-run`
 * (#998). Kept rather than deleted because the wait is real and worth naming — it is the whole
 * window between the click and the workflow arriving — and the stage now reports it, having been
 * made the gate on building the description at all.
 */
export const FixOpeningWorkflow: Story = {
  args: {
    initialMode: "edit",
    canEdit: true,
    initialPrompt: "",
    fixNotice: {
      runId: "exec-t-demo-ce20c38b",
      drift: null,
      includedNodeIds: [],
      error: null,
      stage: "loading-canvas",
    },
  },
};

/**
 * The canvas is up; the run's error, failing step and inputs are being read (three fetches).
 *
 * The composer is READ-ONLY here, not disabled — anything typed would be replaced the instant the
 * description landed, but `disabled` would take the box out of the tab order and out of reach of a
 * screen reader. `apps/web/e2e/fix-with-ai.spec.ts` asserts both halves of that.
 */
export const FixReadingRun: Story = {
  args: {
    initialMode: "edit",
    canEdit: true,
    initialPrompt: "",
    fixNotice: {
      runId: "exec-t-demo-ce20c38b",
      drift: null,
      includedNodeIds: [],
      error: null,
      stage: "reading-run",
    },
  },
};

/**
 * The workflow IS on the canvas but doesn't compile, so there is nothing valid to describe the
 * failure against. Naming the compile error makes it fixable — and this is the case that showed
 * up twice while building the feature, each time reading as "there's no workflow here", which was
 * visibly false.
 */
export const FixCanvasDoesNotCompile: Story = {
  args: {
    initialMode: "edit",
    canEdit: false,
    initialPrompt: "",
    fixNotice: {
      runId: "exec-t-demo-ce20c38b",
      drift: null,
      includedNodeIds: [],
      error: null,
      stage: "blocked",
      canvasError:
        "node 'pagerduty': unknown action 'listIncidents' for provider 'pagerduty'",
    },
  },
};

/**
 * The workflow could not be OPENED at all (#1006) — the third way into `blocked`, and the one
 * where the other two sentences are both false.
 *
 * `/graphs/<key>` rejected, so `CanvasPage` set a status line and stopped: the nodes were never
 * replaced and the canvas still holds the SEED graph (start → approval → end). That graph COMPILES
 * — which is why `canEdit` is true here, unlike the two blocked stories above, and why the mode
 * chooser renders. It is also precisely the trap: read as "the canvas has loaded", the seed becomes
 * the thing the failure is described against, and the prompt comes out naming a step "no longer in
 * the workflow" under a banner claiming the fix applies to the workflow the user came from.
 *
 * So the sentence has to say the one true thing: what is on screen is not that workflow.
 */
export const FixWorkflowFailedToOpen: Story = {
  args: {
    initialMode: "edit",
    // The SEED graph compiles, so the panel really is editable — a failed open does not disable
    // the canvas, it just means the canvas isn't the user's workflow.
    canEdit: true,
    initialPrompt: "",
    fixNotice: {
      runId: "exec-t-demo-ce20c38b",
      drift: null,
      includedNodeIds: [],
      error: null,
      stage: "blocked",
      canvasLoadFailed: true,
    },
  },
};

/**
 * Terminal, not a wait: the canvas finished loading with nothing on it to change, so no
 * description is coming. A spinner here would promise one forever.
 */
export const FixNoWorkflowToChange: Story = {
  args: {
    initialMode: "edit",
    canEdit: false,
    initialPrompt: "",
    fixNotice: {
      runId: "exec-t-demo-ce20c38b",
      drift: null,
      includedNodeIds: [],
      error: null,
      stage: "blocked",
    },
  },
};

/** The run couldn't be read: the panel still works, it just has nothing to describe. */
export const FixCouldNotRead: Story = {
  args: {
    initialMode: "edit",
    canEdit: true,
    initialPrompt: "",
    fixNotice: {
      runId: "exec-t-demo-ce20c38b",
      drift: null,
      includedNodeIds: [],
      error:
        "Couldn't read that run, so the failure isn't described below — say what you'd like changed.",
      stage: "done",
    },
  },
};
