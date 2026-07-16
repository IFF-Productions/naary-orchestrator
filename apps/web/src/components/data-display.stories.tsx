import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Avatar,
  CodeBlock,
  type Column,
  ProgressBar,
  StatCard,
  StatusPill,
  type RunState,
  Table,
  Tag,
} from "./data-display";

const meta: Meta = { title: "Data display" };
export default meta;
type Story = StoryObj;

const STATES: RunState[] = [
  "idle",
  "running",
  "paused",
  "done",
  "error",
  "info",
];

export const StatusPills: Story = {
  render: () => (
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
      {STATES.map((s) => (
        <StatusPill key={s} state={s} />
      ))}
    </div>
  ),
};

export const Avatars: Story = {
  render: () => (
    <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
      <Avatar initials="HA" size={24} />
      <Avatar initials="NA" size={30} />
      <Avatar initials="ZR" size={40} />
    </div>
  ),
};

export const Tags: Story = {
  render: () => (
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
      <Tag>default</Tag>
      <Tag color="var(--state-done)">prod</Tag>
      <Tag color="var(--state-running)">sandbox</Tag>
      <Tag color="var(--state-error)">failing</Tag>
    </div>
  ),
};

export const Progress: Story = {
  render: () => (
    <div style={{ display: "grid", gap: 12, maxWidth: 320 }}>
      <ProgressBar value={25} />
      <ProgressBar value={70} color="var(--state-done)" />
      <ProgressBar value={100} color="var(--state-error)" />
    </div>
  ),
};

export const StatCards: Story = {
  render: () => (
    <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
      <StatCard label="Runs today" value="1,284" delta="12%" deltaDir="up" />
      <StatCard label="Spend (MTD)" value="$42.18" delta="4%" deltaDir="down" />
      <StatCard label="Active flows" value="17" />
    </div>
  ),
};

export const Code: Story = {
  render: () => (
    <CodeBlock>
      {JSON.stringify(
        { category: "billing_dispute", confidence: 0.94 },
        null,
        2,
      )}
    </CodeBlock>
  ),
};

type Row = { id: string; flow: string; status: RunState; cost: string };
const ROWS: Row[] = [
  { id: "wh-a1b2c3", flow: "refund-triage", status: "done", cost: "$0.014" },
  { id: "wh-d4e5f6", flow: "github-review", status: "running", cost: "—" },
  { id: "wh-9a8b7c", flow: "lead-router", status: "error", cost: "$0.002" },
];
const COLUMNS: Column<Row>[] = [
  {
    key: "id",
    header: "Run",
    render: (r) => <span className="mono">{r.id}</span>,
  },
  { key: "flow", header: "Workflow", render: (r) => r.flow },
  {
    key: "status",
    header: "Status",
    render: (r) => <StatusPill state={r.status} />,
  },
  { key: "cost", header: "Cost", render: (r) => r.cost },
];
export const DataTable: Story = {
  render: () => <Table columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} />,
};
