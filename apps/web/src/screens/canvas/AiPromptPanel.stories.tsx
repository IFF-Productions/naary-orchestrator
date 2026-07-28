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
import { AiPromptPanel } from "./AiPromptPanel";
import type { AiMode } from "./useAiBuilder";

/** Stateful wrapper — the mode + prompt are controlled, so a story needs an owner for them. */
function Harness({
  initialMode,
  canEdit,
  generating = false,
}: {
  initialMode: AiMode;
  canEdit: boolean;
  generating?: boolean;
}) {
  const [mode, setMode] = useState<AiMode>(initialMode);
  const [prompt, setPrompt] = useState(
    "Handle the case where there are no open incidents — just end with no issues.",
  );
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
      />
    </div>
  );
}

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
