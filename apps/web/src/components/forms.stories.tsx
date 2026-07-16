import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import {
  Checkbox,
  Field,
  Radio,
  SearchInput,
  Select,
  Switch,
  TextInput,
} from "./forms";

const meta: Meta = { title: "Forms/Controls" };
export default meta;
type Story = StoryObj;

export const Inputs: Story = {
  render: () => (
    <div style={{ display: "grid", gap: 12, maxWidth: 320 }}>
      <TextInput placeholder="Workflow name…" />
      <TextInput large placeholder="Large input…" />
      <TextInput defaultValue="refund-triage" />
      <TextInput disabled placeholder="Disabled" />
    </div>
  ),
};

function SearchDemo() {
  const [v, setV] = useState("");
  return <SearchInput value={v} onChange={setV} placeholder="Search runs…" />;
}
export const Search: Story = { render: () => <SearchDemo /> };

function SelectDemo() {
  const [v, setV] = useState<string | undefined>(undefined);
  return (
    <div style={{ display: "flex", gap: 12 }}>
      <Select
        value={v}
        placeholder="Pick a model…"
        onClick={() => setV("claude-sonnet-5")}
      />
      <Select value="claude-opus-4-8" />
    </div>
  );
}
export const SelectDisplay: Story = { render: () => <SelectDemo /> };

function TogglesDemo() {
  const [sw, setSw] = useState(true);
  const [cb, setCb] = useState(true);
  const [radio, setRadio] = useState("a");
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <label style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Switch checked={sw} onChange={setSw} /> Active
      </label>
      <label style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Checkbox checked={cb} onChange={setCb} /> Notify on failure
      </label>
      <div style={{ display: "flex", gap: 16 }}>
        {["a", "b", "c"].map((k) => (
          <label
            key={k}
            style={{ display: "flex", alignItems: "center", gap: 8 }}
          >
            <Radio checked={radio === k} onChange={() => setRadio(k)} /> Option{" "}
            {k}
          </label>
        ))}
      </div>
    </div>
  );
}
export const Toggles: Story = { render: () => <TogglesDemo /> };

export const WithField: Story = {
  render: () => (
    <div style={{ maxWidth: 320 }}>
      <Field
        label="Webhook URL"
        hint={
          <span style={{ fontSize: 11, color: "var(--ink-3)" }}>required</span>
        }
      >
        <TextInput placeholder="https://hooks.slack.com/…" />
      </Field>
    </div>
  ),
};
