import type { Meta, StoryObj } from "@storybook/react-vite";
import { LockGlyph, panelStyle, RowMenu } from "./shared";

// RowMenu renders its dropdown in a portal so the settings panel's `overflow: hidden` (rounded
// corners) can't clip it — the bug where "Update value…" was cut off inside the row. This story
// reproduces the exact context: the menu sits on the LAST row of an `overflow: hidden` panel, so an
// in-flow menu WOULD be clipped; the portal one overlays past the panel edge. Open the ⋮ to see it.
const meta: Meta<typeof RowMenu> = { title: "Settings/RowMenu" };
export default meta;
type Story = StoryObj<typeof RowMenu>;

function SecretRow({ name, env }: { name: string; env: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "13px 18px",
        borderBottom: "1px solid var(--line)",
      }}
    >
      <LockGlyph style={{ color: "var(--ink-faint)" }} />
      <div
        className="mono"
        style={{ flex: 1, fontSize: 12.5, fontWeight: 600 }}
      >
        {name}
      </div>
      <span
        style={{
          fontSize: 11,
          color: "var(--brand)",
          border: "1px solid var(--brand)",
          borderRadius: 12,
          padding: "1px 8px",
        }}
      >
        {env}
      </span>
      <span
        className="mono"
        style={{ fontSize: 11.5, color: "var(--ink-faint)" }}
      >
        ••••••••
      </span>
      <RowMenu
        label={`Actions for ${name}`}
        items={[
          { label: "Update value…", onClick: () => {} },
          { label: "Delete", danger: true, onClick: () => {} },
        ]}
      />
    </div>
  );
}

/** The panel uses `overflow: hidden` (rounded corners). The menu on the LAST row must still overlay
 *  past the panel's bottom edge — proof the portal escapes the clip. Click the ⋮ on the last row. */
export const InsidePanel: Story = {
  render: () => (
    <div style={{ maxWidth: 640, padding: 24 }}>
      <div style={panelStyle}>
        <SecretRow name="GITHUB_TOKEN" env="Production" />
        <SecretRow name="STRIPE_KEY" env="Production" />
      </div>
    </div>
  ),
};
