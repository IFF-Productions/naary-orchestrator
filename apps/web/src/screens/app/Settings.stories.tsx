import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";
import { ModeProvider } from "../../mode";
import { WorkspaceProvider } from "../../workspace/WorkspaceProvider";
import { Settings } from "./Settings";

const handlers = [
  http.get("*/api/me", () => HttpResponse.json({ tenantId: "t1" })),
  http.get("*/api/me/workspaces", () =>
    HttpResponse.json([{ tenantId: "t1", role: "owner", name: "Acme" }]),
  ),
  http.get("*/api/tenants/:t/settings", () =>
    HttpResponse.json({ displayName: "Acme", defaultModel: "claude-sonnet-5" }),
  ),
  http.get("*/api/tenants/:t/notifications", () =>
    HttpResponse.json([
      {
        type: "slack",
        enabled: true,
        webhookUrl: "https://hooks.slack.com/services/T0/B0/xxx",
        onApprovalPending: true,
        onRunFailed: true,
      },
      {
        type: "teams",
        enabled: false,
        webhookUrl: null,
        onApprovalPending: false,
        onRunFailed: true,
      },
    ]),
  ),
];

const meta: Meta<typeof Settings> = {
  title: "Screens/Settings",
  component: Settings,
  parameters: { layout: "fullscreen", msw: { handlers } },
  decorators: [
    (Story) => (
      <WorkspaceProvider>
        <ModeProvider>
          <div style={{ background: "var(--bg)", minHeight: "100vh" }}>
            <Story />
          </div>
        </ModeProvider>
      </WorkspaceProvider>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof Settings>;

/** Workspace name, default model, and the Slack (on) / Teams (off) notification channels. */
export const Default: Story = {};
