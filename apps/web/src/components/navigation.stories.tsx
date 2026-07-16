import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { Breadcrumb, Pagination, Tabs } from "./navigation";

const meta: Meta = { title: "Navigation" };
export default meta;
type Story = StoryObj;

function TabsDemo() {
  const [t, setT] = useState("overview");
  return (
    <Tabs
      active={t}
      onChange={setT}
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "runs", label: "Runs" },
        { value: "settings", label: "Settings" },
      ]}
    />
  );
}
export const TabStrip: Story = { render: () => <TabsDemo /> };

export const Breadcrumbs: Story = {
  render: () => <Breadcrumb items={["Workspaces", "Acme", "refund-triage"]} />,
};

function PaginationDemo() {
  const [p, setP] = useState(2);
  return <Pagination page={p} pages={7} onPage={setP} />;
}
export const Paginate: Story = { render: () => <PaginationDemo /> };
