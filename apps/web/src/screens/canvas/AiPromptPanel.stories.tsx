/**
 * The canvas AI panel, which used to have exactly one behaviour: generate a workflow from
 * scratch and drop it over whatever was on the canvas. Asking it to *change* the workflow
 * you were looking at got you a different workflow — the panel had no way to say otherwise
 * and no way to tell you so.
 *
 * `Edit` is the state to look at. What matters is that the mode is VISIBLE and switchable:
 * if the user can't see which of the two things is about to happen, the destructive one is
 * a surprise. `NewCanvas` is the empty-canvas case — nothing to change, so no chooser.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { AiPromptPanel, type FixNotice } from "./AiPromptPanel";
import type { AiMode } from "./useAiBuilder";

/** Stateful wrapper — the mode + prompt are controlled, so a story needs an owner for them. */
function Harness({
  initialMode,
  canEdit,
  generating = false,
  fixNotice = null,
  initialPrompt = "Handle the case where there are no open incidents — just end with no issues.",
}: {
  initialMode: AiMode;
  canEdit: boolean;
  generating?: boolean;
  fixNotice?: FixNotice | null;
  initialPrompt?: string;
}) {
  const [mode, setMode] = useState<AiMode>(initialMode);
  const [prompt, setPrompt] = useState(initialPrompt);
  const [provider, setProvider] = useState("");
  return (
    <div style={{ width: 720 }}>
      <AiPromptPanel
        aiPrompt={prompt}
        onPromptChange={setPrompt}
        genProvider={provider}
        onProviderChange={setProvider}
        aiMode={mode}
        onModeChange={setMode}
        canEdit={canEdit}
        generating={generating}
        onGenerate={() => {}}
        fixNotice={fixNotice}
      />
    </div>
  );
}

/** What arriving from a failed run puts in the box (see buildFixInstruction). */
const FIX_INSTRUCTION = `A run of this workflow FAILED. Change the workflow so this failure does not happen again.

Failed at node: "pagerduty" (type: integration)
Failure kind: provider_error
Error: Missing required header 'From'

That node's current configuration:
{"provider":"pagerduty","action":"createIncident","title":"{{ lookup.body.titel }}","auth":"{{ $secrets.PD_TOKEN }}"}

The same configuration AS IT RAN, with this run's values filled in (\`{{ $secrets… }}\` and \`{{ $vars… }}\` are deliberately left unresolved):
{"provider":"pagerduty","action":"createIncident","title":"","auth":"{{ $secrets.PD_TOKEN }}"}

The input that started this run:
  {"source":"cron"}

The call that node made (secrets already redacted at capture):
  request: POST https://api.pagerduty.com/incidents
  response: 400 Bad Request

Every step that ran in this run, the ones this node reads from first:
  lookup: {"status":200,"body":{"title":"Disk full on web-03"}}
  schedule: {"firedAt":"2026-07-31T14:22:03.000Z"}
  crm_fetch: {"account":"acme","tier":"enterprise"}`;

const meta: Meta<typeof Harness> = {
  title: "Canvas/AiPromptPanel",
  component: Harness,
};
export default meta;
type Story = StoryObj<typeof Harness>;

/** A canvas holding a workflow: default to changing it, and say so on the button. */
export const Edit: Story = { args: { initialMode: "edit", canEdit: true } };

/** The same canvas with "Start a new one" chosen — the destructive path, explicitly picked. */
export const Replace: Story = {
  args: { initialMode: "create", canEdit: true },
};

/** Empty (or uncompilable) canvas: nothing to change, so the chooser doesn't appear at all. */
export const NewCanvas: Story = {
  args: { initialMode: "create", canEdit: false },
};

/** Mid-run wording — "Applying…", not "Generating…", because it isn't generating. */
export const Applying: Story = {
  args: { initialMode: "edit", canEdit: true, generating: true },
};

/**
 * Arrived from a FAILED run (`?fix=<runId>`): the failure is already written up, and the header
 * NAMES the steps whose output goes with it. A count ("output from 3 steps") is not something a
 * user can check; a list is, and the prompt itself is right there to read in full.
 *
 * The prompt is worth reading here rather than skimming — it is the whole disclosure. Note the
 * AS-IT-RAN block: the authored title is `{{ lookup.body.titel }}` (a typo) and what actually went
 * out was `""`. That is the bug this feature exists to make visible, and it is invisible in the
 * template alone. Note also that the secret stays a token in both.
 */
export const FromFailedRun: Story = {
  args: {
    initialMode: "edit",
    canEdit: true,
    initialPrompt: FIX_INSTRUCTION,
    fixNotice: {
      runId: "exec-t-demo-ce20c38b",
      drift: null,
      includedNodeIds: ["lookup", "schedule", "crm_fetch"],
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
 * is already full height here, so the description lands without the panel jumping.
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

/** The canvas is up; the run's error, failing step and inputs are being read (three fetches). */
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
