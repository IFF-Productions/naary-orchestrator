import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "./forms";

const meta = {
  title: "Primitives/Button",
  component: Button,
  args: { children: "Run now" },
  argTypes: {
    variant: {
      control: "select",
      options: ["primary", "secondary", "ghost", "danger", "positive"],
    },
    size: { control: "inline-radio", options: ["sm", "md", "lg"] },
    icon: { control: "text" },
    loading: { control: "boolean" },
    disabled: { control: "boolean" },
  },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Primary: Story = { args: { variant: "primary" } };
export const Secondary: Story = { args: { variant: "secondary" } };
export const Danger: Story = {
  args: { variant: "danger", children: "Delete" },
};
export const WithIcon: Story = {
  args: { variant: "primary", icon: "play", children: "Start test run" },
};
export const Loading: Story = { args: { variant: "primary", loading: true } };

/** Every variant at a glance — the fastest way to eyeball the design tokens. */
export const AllVariants: Story = {
  render: () => (
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
      <Button variant="primary">Primary</Button>
      <Button variant="secondary">Secondary</Button>
      <Button variant="ghost">Ghost</Button>
      <Button variant="danger">Danger</Button>
      <Button variant="positive">Positive</Button>
    </div>
  ),
};
