import type { Meta, StoryObj } from "@storybook/react-vite";
import { LoadingBlock, Spinner } from "./Spinner";

const meta: Meta = { title: "Feedback/Spinner" };
export default meta;
type Story = StoryObj;

export const Sizes: Story = {
  render: () => (
    <div style={{ display: "flex", gap: 20, alignItems: "center" }}>
      <Spinner size={14} />
      <Spinner size={20} />
      <Spinner size={28} />
    </div>
  ),
};

export const Loading: Story = {
  render: () => <LoadingBlock label="Loading runs…" />,
};
