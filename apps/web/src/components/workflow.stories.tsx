import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { NodeCard, type NodeType, SegmentedToggle } from "./workflow";

const meta: Meta = { title: "Workflow" };
export default meta;
type Story = StoryObj;

function SegmentedDemo() {
  const [v, setV] = useState("canvas");
  return (
    <SegmentedToggle
      value={v}
      onChange={setV}
      options={[
        { value: "canvas", label: "Canvas" },
        { value: "code", label: "Code" },
        { value: "runs", label: "Runs" },
      ]}
    />
  );
}
export const Segmented: Story = { render: () => <SegmentedDemo /> };

const TYPES: NodeType[] = [
  "trigger",
  "agent",
  "mcp",
  "router",
  "approval",
  "http",
  "end",
];

export const NodeCards: Story = {
  render: () => (
    <div style={{ display: "flex", gap: 18, flexWrap: "wrap", padding: 20 }}>
      {TYPES.map((t) => (
        <div key={t} style={{ width: 200, position: "relative" }}>
          <NodeCard
            type={t}
            title={`${t[0].toUpperCase()}${t.slice(1)} node`}
            ports={false}
          />
        </div>
      ))}
    </div>
  ),
};

export const NodeCardRich: Story = {
  render: () => (
    <div style={{ width: 220, padding: 20, position: "relative" }}>
      <NodeCard
        type="agent"
        title="Classify ticket"
        output="{ category, confidence }"
        tags={[{ label: "sonnet-5", accent: true }, { label: "retry ×3" }]}
        selected
        ports={false}
      />
    </div>
  ),
};
