/**
 * The sub-workflow picker (`executeSubWorkflow` + `forEach`), which replaced a free-text
 * `workflowKey`.
 *
 * `UnknownKey` is the one to look at: a node targeting a key the list doesn't contain — another
 * environment, a deleted workflow, one referenced before it was saved. If that ever renders as an
 * empty chooser, the panel is claiming the node targets nothing while the graph says otherwise,
 * and saving from that state would make the lie true.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";
import { useState } from "react";
import { WorkflowSelect } from "./WorkflowSelect";

const GRAPHS = [
  { workflowKey: "process-one-item", name: "Process one item", version: 3 },
  { workflowKey: "notify-oncall", name: "Notify on-call", version: 1 },
  { workflowKey: "enrich-lead", name: "Enrich lead", version: 7 },
];

const graphsHandler = (body: typeof GRAPHS) => [
  http.get("/api/graphs", () => HttpResponse.json(body)),
];

/** Stateful wrapper — a controlled <select> can't be exercised without an owner for its value. */
function Harness({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  return (
    <div style={{ width: 340, padding: 16 }}>
      <WorkflowSelect value={value} onChange={setValue} />
      <div
        style={{
          marginTop: 12,
          fontSize: 12,
          fontFamily: "ui-monospace, monospace",
          color: "var(--ink-3)",
        }}
      >
        workflowKey: {JSON.stringify(value)}
      </div>
    </div>
  );
}

const meta: Meta<typeof Harness> = {
  title: "Canvas/WorkflowSelect",
  component: Harness,
  parameters: { msw: { handlers: graphsHandler(GRAPHS) } },
};
export default meta;
type Story = StoryObj<typeof Harness>;

/** Nothing chosen yet — the ordinary state of a freshly dropped node. */
export const Unset: Story = { args: { initial: "" } };

/** A normal selection. */
export const Chosen: Story = { args: { initial: "notify-oncall" } };

/**
 * The case that motivated the model: the key is real to the graph but absent from this list.
 * It must remain shown AND remain set.
 */
export const UnknownKey: Story = { args: { initial: "archived-flow" } };

/** No workflows saved yet — say so instead of offering an empty chooser. */
export const NoWorkflows: Story = {
  args: { initial: "" },
  parameters: { msw: { handlers: graphsHandler([]) } },
};

/** The list couldn't load: fall back to typing rather than stranding the author. */
export const ListFailed: Story = {
  args: { initial: "" },
  parameters: {
    msw: {
      handlers: [
        http.get("/api/graphs", () => new HttpResponse(null, { status: 500 })),
      ],
    },
  },
};
