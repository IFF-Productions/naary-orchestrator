/**
 * The bindings editor's argument-NAME control, which used to be a free-text box even where the
 * integration catalog knew exactly which arguments the action takes.
 *
 * `UnlistedName` is the one to look at. An integration's `fieldBindings` survive a change of
 * action, so a row can hold a name the current action never had. A `<select>` whose value matches
 * no `<option>` renders its FIRST option — so if that row ever displays "Incident id", the panel
 * is claiming a binding the graph doesn't have, and the next edit would make it true.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { BindingsEditor, type BindingRow } from "./fields";
import { integrationBindingOptions } from "./binding-name-model";

/** PagerDuty `acknowledge_incident`, as the catalog declares it (const fields included, so the
 *  story also proves they're filtered out — `type`/`status` must never be offered). */
const ACK_FIELDS = [
  { key: "From", label: "From (user email)", required: false },
  { key: "id", label: "Incident id", required: true },
  { key: "type", label: "Type", required: true, const: "incident_reference" },
  { key: "status", label: "Status", required: true, const: "acknowledged" },
];

function Harness({
  initial,
  options,
}: {
  initial: Record<string, BindingRow>;
  options: {
    key: string;
    label: string;
    required?: boolean;
    const?: unknown;
  }[];
}) {
  const [bindings, setBindings] = useState<
    Record<string, BindingRow> | undefined
  >(initial);
  return (
    <div style={{ width: 380, padding: 16 }}>
      <BindingsEditor
        bindings={bindings}
        upstreamIds={["listincidents", "analyze"]}
        onChange={setBindings}
        options={integrationBindingOptions(options)}
      />
      <div
        style={{
          marginTop: 12,
          fontSize: 12,
          fontFamily: "ui-monospace, monospace",
          color: "var(--ink-3)",
        }}
      >
        {JSON.stringify(bindings ?? null)}
      </div>
    </div>
  );
}

const meta: Meta<typeof Harness> = {
  title: "Canvas/BindingsEditor",
  component: Harness,
};
export default meta;
type Story = StoryObj<typeof Harness>;

/** A row bound to a real argument of this action. */
export const Chosen: Story = {
  args: {
    initial: { id: { from: "listincidents", path: "body.incidents.0.id" } },
    options: ACK_FIELDS,
  },
};

/** A fresh row — nothing chosen yet. */
export const Unset: Story = {
  args: { initial: { "": { from: "listincidents" } }, options: ACK_FIELDS },
};

/**
 * The case that motivated the model: a name this action doesn't have (left over from another
 * action, or deliberately custom). It must stay visible AND stay set.
 */
export const UnlistedName: Story = {
  args: {
    initial: { resolution: { from: "analyze", path: "output.summary" } },
    options: ACK_FIELDS,
  },
};

/** No catalog knowledge (an arbitrary MCP tool) — free text, exactly as before. */
export const NoOptions: Story = {
  args: { initial: { owner: { from: "analyze" } }, options: [] },
};
