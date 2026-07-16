import type { Meta, StoryObj } from "@storybook/react-vite";
import { Card, Logo, SectionLabel } from "./layout";

const meta: Meta = { title: "Layout" };
export default meta;
type Story = StoryObj;

export const Cards: Story = {
  render: () => (
    <div style={{ display: "grid", gap: 16, maxWidth: 420 }}>
      <Card>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Padded card</div>
        <div style={{ color: "var(--ink-2)", fontSize: 13 }}>
          Default surface used across the app for grouped content.
        </div>
      </Card>
      <Card pad={false}>
        <div style={{ padding: "12px 16px" }}>
          Unpadded card (manage your own padding)
        </div>
      </Card>
    </div>
  ),
};

export const SectionLabels: Story = {
  render: () => (
    <div style={{ display: "grid", gap: 20 }}>
      <SectionLabel index="01">Triggers</SectionLabel>
      <SectionLabel index="02" note="how the run ends">
        Outputs
      </SectionLabel>
    </div>
  ),
};

export const BrandLogo: Story = {
  render: () => (
    <div
      style={{ display: "flex", gap: 20, alignItems: "center", padding: 20 }}
    >
      <Logo size={30} />
      <Logo size={44} />
      <Logo size={60} glow={false} />
    </div>
  ),
};
