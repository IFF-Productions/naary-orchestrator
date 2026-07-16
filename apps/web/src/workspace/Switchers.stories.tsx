import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";
import { userEvent, within } from "storybook/test";
import type { ReactNode } from "react";
import { EnvironmentSwitcher } from "./EnvironmentSwitcher";
import { WorkspaceProvider } from "./WorkspaceProvider";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

const WORKSPACES = [
  { tenantId: "t1", role: "owner", name: "Acme" },
  { tenantId: "t2", role: "member", name: "Globex" },
];

const ENVIRONMENTS = [
  { id: "e-prod", name: "Production", slug: "prod", isDefault: true },
  { id: "e-uat", name: "UAT", slug: "uat", isDefault: false },
  { id: "e-sb", name: "Sandbox", slug: "sandbox", isDefault: false },
];

const handlers = [
  http.get("*/api/me/workspaces", () => HttpResponse.json(WORKSPACES)),
  http.get("*/api/tenants/:t/environments", () =>
    HttpResponse.json(ENVIRONMENTS),
  ),
];

// Both switchers read the active workspace from WorkspaceProvider (which resolves it from the
// mocked /me/workspaces). A topbar-ish frame so the dropdown has room to open.
function Frame({ children }: { children: ReactNode }) {
  return (
    <WorkspaceProvider>
      <div style={{ background: "var(--bg-2)", padding: 16, minHeight: 360 }}>
        {children}
      </div>
    </WorkspaceProvider>
  );
}

const openMenu = async (canvasElement: HTMLElement) => {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole("button"));
};

const meta: Meta = {
  title: "App chrome/Switchers",
  parameters: { layout: "fullscreen", msw: { handlers } },
};
export default meta;
type Story = StoryObj;

export const Workspace: Story = {
  render: () => (
    <Frame>
      <WorkspaceSwitcher />
    </Frame>
  ),
};

/** The workspace list open — the active one checked, plus "＋ New workspace". */
export const WorkspaceOpen: Story = {
  render: () => (
    <Frame>
      <WorkspaceSwitcher />
    </Frame>
  ),
  play: async ({ canvasElement }) => {
    await openMenu(canvasElement);
    await within(canvasElement).findByRole("listbox");
  },
};

export const Environment: Story = {
  render: () => (
    <Frame>
      <EnvironmentSwitcher />
    </Frame>
  ),
};

/** The environment menu open — Production (default) / UAT / Sandbox. */
export const EnvironmentOpen: Story = {
  render: () => (
    <Frame>
      <EnvironmentSwitcher />
    </Frame>
  ),
  play: async ({ canvasElement }) => {
    await openMenu(canvasElement);
    await within(canvasElement).findByRole("menu");
  },
};
