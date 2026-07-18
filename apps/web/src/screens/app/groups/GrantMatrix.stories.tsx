import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import {
  type GrantDraft,
  emptyGrantDraft,
} from "../../../lib/permissions-logic";
import { GrantMatrix } from "./GrantEditor";

const meta: Meta = { title: "Groups/GrantMatrix" };
export default meta;
type Story = StoryObj;

function MatrixDemo({ initial }: { initial: GrantDraft }) {
  const [draft, setDraft] = useState(initial);
  return (
    <div style={{ maxWidth: 480 }}>
      <GrantMatrix draft={draft} onChange={setDraft} />
    </div>
  );
}

export const AllWorkflowsScope: Story = {
  render: () => (
    <MatrixDemo
      initial={{ ...emptyGrantDraft(), canView: true, canRun: true }}
    />
  ),
};

/** Selected scope: `create` is disabled with the §8.3 explanation tooltip. */
export const SelectedScopeCreateDisabled: Story = {
  render: () => (
    <MatrixDemo
      initial={{
        ...emptyGrantDraft(),
        scope: "selected",
        workflowKeys: ["support-triage"],
        canView: true,
        canEdit: true,
      }}
    />
  ),
};
