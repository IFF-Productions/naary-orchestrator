import type { Meta, StoryObj } from "@storybook/react-vite";
import { Icon, type IconName } from "./Icon";

const meta: Meta = { title: "Primitives/Icon" };
export default meta;
type Story = StoryObj;

// Keep in sync with the IconName union in Icon.tsx.
const NAMES: IconName[] = [
  "grid",
  "workflow",
  "activity",
  "template",
  "edit",
  "plug",
  "chart",
  "card",
  "users",
  "settings",
  "search",
  "menu",
  "bell",
  "plus",
  "chevron-down",
  "chevron-right",
  "chevron-up-down",
  "expand",
  "external",
  "sun",
  "moon",
  "check",
  "check-circle",
  "x",
  "eye",
  "arrow-right",
  "arrow-left",
  "play",
  "pause",
  "clock",
  "dollar",
  "alert",
  "info",
  "more",
  "trash",
  "archive",
  "copy",
  "filter",
  "flame",
  "bolt",
  "agent",
  "mcp",
  "router",
  "approval",
  "http",
  "end",
  "sidebar-collapse",
  "sidebar-expand",
  "refresh",
  "key",
  "logout",
];

export const Gallery: Story = {
  render: () => (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))",
        gap: 8,
      }}
    >
      {NAMES.map((n) => (
        <div
          key={n}
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 8,
            padding: "14px 6px",
            border: "1px solid var(--line)",
            borderRadius: 8,
            color: "var(--ink)",
          }}
        >
          <Icon name={n} size={20} />
          <span
            className="mono"
            style={{ fontSize: 10, color: "var(--ink-3)" }}
          >
            {n}
          </span>
        </div>
      ))}
    </div>
  ),
};

export const Sizes: Story = {
  render: () => (
    <div
      style={{
        display: "flex",
        gap: 16,
        alignItems: "center",
        color: "var(--ink)",
      }}
    >
      <Icon name="bolt" size={14} />
      <Icon name="bolt" size={20} />
      <Icon name="bolt" size={28} />
      <Icon name="bolt" size={40} strokeWidth={1.4} />
    </div>
  ),
};
