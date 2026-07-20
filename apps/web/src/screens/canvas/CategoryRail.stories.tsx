import type { Meta, StoryObj } from "@storybook/react-vite";
import { CategoryRail } from "./CategoryRail";

/**
 * The 60px icon-only category rail (Canvas Authoring Loop): one 36px tile per
 * catalog category (type-colored glyphs from the REAL catalog derivation) and
 * the dashed "+" tile that opens the full catalog modal. Clicking a tile opens
 * the category's node popover.
 */
const meta: Meta<typeof CategoryRail> = {
  title: "Canvas/Category rail",
  component: CategoryRail,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div
        style={{
          display: "flex",
          height: 620,
          background:
            "radial-gradient(120% 90% at 20% 0%, var(--grad-a), var(--bg) 60%)",
        }}
      >
        <Story />
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--ink-3)",
            fontSize: 12,
          }}
        >
          canvas area — click a rail tile to open its category popover
        </div>
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof CategoryRail>;

export const Rail: Story = {
  args: {
    onAdd: () => {},
    onOpenCatalog: () => {},
  },
};
