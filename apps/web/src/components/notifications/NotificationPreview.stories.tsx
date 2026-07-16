import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  type NotificationInput,
  type NotificationLinks,
  notificationBlocks,
  notificationTeamsCard,
} from "@naary/notifications";
import { SlackMessage } from "./SlackMessage";
import { TeamsCard } from "./TeamsCard";

// Fake but realistic links — the pure formatter takes these as data (the worker mints the real
// signed ones). Rendering the ACTUAL formatter output is the point: what you see here is byte-for-
// byte what the worker POSTs to Slack/Teams.
const LINKS: NotificationLinks = {
  approvalUrl:
    "https://app.naary.io/approve/wh-t1-9a8b7c?token=deadbeefcafef00d",
  runUrl: "https://app.naary.io/app/runs/wh-t1-9a8b7c",
};

const APPROVAL: NotificationInput = {
  kind: "approval_pending",
  workflowId: "wh-t1-9a8b7c",
  workflowKey: "refund-triage",
  title: "Refund over $500 needs a human",
};

const FAILED: NotificationInput = {
  kind: "run_failed",
  workflowId: "wh-t1-deadbeef",
  workflowKey: "invoice-sync",
  detail: "AGENT_TIMEOUT",
};

function Slack({
  input,
  links = LINKS,
  theme = "dark",
}: {
  input: NotificationInput;
  links?: NotificationLinks;
  theme?: "dark" | "light";
}) {
  const { blocks } = notificationBlocks(input, links);
  // Match the real Slack surface so the message sits seamlessly (dark by default).
  const bg = theme === "dark" ? "#1a1d21" : "#ffffff";
  return (
    <div style={{ padding: 24, background: bg, minHeight: "100vh" }}>
      <SlackMessage blocks={blocks} theme={theme} />
    </div>
  );
}

function Teams({ input }: { input: NotificationInput }) {
  return (
    <div style={{ padding: 24, background: "#faf9f8", minHeight: "100vh" }}>
      <TeamsCard payload={notificationTeamsCard(input, LINKS)} />
    </div>
  );
}

const meta: Meta = {
  title: "Notifications/Preview",
  parameters: { layout: "fullscreen" },
};
export default meta;
type Story = StoryObj;

export const SlackApprovalPending: Story = {
  render: () => <Slack input={APPROVAL} />,
};

export const SlackRunFailed: Story = {
  render: () => <Slack input={FAILED} />,
};

/** No APP_BASE_URL / signing key on the worker → no action buttons, run shown as a bare id. */
export const SlackNoLinks: Story = {
  render: () => <Slack input={APPROVAL} links={{}} />,
};

/** Same payload rendered in Slack's light theme (some workspaces default to it). */
export const SlackLightTheme: Story = {
  render: () => <Slack input={FAILED} theme="light" />,
};

export const TeamsApprovalPending: Story = {
  render: () => <Teams input={APPROVAL} />,
};

export const TeamsRunFailed: Story = {
  render: () => <Teams input={FAILED} />,
};
