import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  type NotificationInput,
  type NotificationLinks,
  notificationBlocks,
  notificationEmail,
  notificationTeamsCard,
} from "@naary/notifications";
import { EmailMessage } from "./EmailMessage";
import { SlackMessage } from "./SlackMessage";
import { TeamsCard } from "./TeamsCard";

// Fake but realistic links — the pure formatter takes these as data (the worker mints the real
// signed ones). Rendering the ACTUAL formatter output is the point: what you see here is byte-for-
// byte what the worker POSTs to Slack/Teams.
const LINKS: NotificationLinks = {
  approvalUrl:
    "https://app.naary.io/approve/wh-t1-9a8b7c?token=deadbeefcafef00d",
  runUrl: "https://app.naary.io/app/runs/wh-t1-9a8b7c",
  usageUrl: "https://app.naary.io/app/billing",
  workflowUrl: "https://app.naary.io/app/workflows/invoice-sync",
};

const APPROVAL: NotificationInput = {
  kind: "approval_pending",
  workflowId: "wh-t1-9a8b7c",
  workflowKey: "refund-triage",
  title: "Refund over $500 needs a human",
};

// What the worker sends for a failed run after #987: the thrown error's message, its
// ApplicationFailure type and the node it failed at. (It used to send the literal "failed"
// and nothing else, next to a 48-character run id used as a link label.)
const FAILED: NotificationInput = {
  kind: "run_failed",
  workflowId: "exec-t-demo-9f44d033-8bac-4418-98ec-5550172e7100",
  workflowKey: "invoice-sync",
  detail: "Agent call timed out after 60s",
  errorType: "AGENT_TIMEOUT",
  failedNodeId: "summarize",
};

/** The old payload, kept as a story: a reason that only restates the header is now DROPPED
 *  rather than rendered as "Reason: failed". */
const FAILED_BARE: NotificationInput = {
  kind: "run_failed",
  workflowId: "exec-t-demo-9f44d033-8bac-4418-98ec-5550172e7100",
  workflowKey: "invoice-sync",
  detail: "failed",
};

// A run that ended on a RETURNED terminal status rather than a throw — the reason carries
// real information, so it must survive the redundancy suppression.
const FAILED_STATUS: NotificationInput = {
  kind: "run_failed",
  workflowId: "exec-t-demo-9f44d033-8bac-4418-98ec-5550172e7100",
  workflowKey: "invoice-sync",
  detail: "budget_exceeded",
};

// A promotion (Slice 4) — no run at all; `workflowId` carries the workflow KEY.
const PROMOTION: NotificationInput = {
  kind: "promotion",
  workflowId: "invoice-sync",
  workflowKey: "invoice-sync",
  fromEnv: "sandbox",
  toEnv: "prod",
  version: 7,
};

// A self-healing fix proposal (Phase 2) — also keyed, also runless.
const FIX_PROPOSAL: NotificationInput = {
  kind: "fix_proposal",
  workflowId: "pagerduty-triage",
  workflowKey: "pagerduty-triage",
  title: "pagerduty: Missing required header 'From'",
};

// Slice-1 approval flavors: a scheduled reminder (#2) and an escalation naming its target.
const REMINDER: NotificationInput = {
  ...APPROVAL,
  flavor: "reminder",
  reminderIndex: 2,
};

const ESCALATION: NotificationInput = {
  ...APPROVAL,
  flavor: "escalation",
  escalateTo: "@ops-oncall",
};

// Slice 3: the monthly-spend alert — tenant-scoped (cap/spend facts, a usage link,
// no run buttons). Fired at most once per calendar month from the reservation path.
const BUDGET_THRESHOLD: NotificationInput = {
  kind: "budget_threshold",
  workflowId: "wh-t1-9a8b7c",
  thresholdPct: 80,
  capUsd: 400,
  spendUsd: 321.4,
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

/** Subject + HTML body + text/plain body, straight from `notificationEmail` (#1059). */
function Email({
  input,
  links = LINKS,
}: {
  input: NotificationInput;
  links?: NotificationLinks;
}) {
  return (
    <div style={{ padding: 24, background: "#f0f2f5", minHeight: "100vh" }}>
      <EmailMessage mail={notificationEmail(input, links)} />
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

/** Scheduled reminder flavor — "⏰ Approval reminder #2" header, same decision buttons. */
export const SlackApprovalReminder: Story = {
  render: () => <Slack input={REMINDER} />,
};

/** Escalation flavor — "🚨 Approval escalated" + the full-width "Escalated to" line. */
export const SlackApprovalEscalation: Story = {
  render: () => <Slack input={ESCALATION} />,
};

export const TeamsApprovalPending: Story = {
  render: () => <Teams input={APPROVAL} />,
};

/** Escalation as an Adaptive Card — the target rides the FactSet. */
export const TeamsApprovalEscalation: Story = {
  render: () => <Teams input={ESCALATION} />,
};

export const TeamsRunFailed: Story = {
  render: () => <Teams input={FAILED} />,
};

/** Budget alert (Slice 3) — cap/spend facts + a "View usage & budgets" button. */
export const SlackBudgetThreshold: Story = {
  render: () => <Slack input={BUDGET_THRESHOLD} />,
};

export const TeamsBudgetThreshold: Story = {
  render: () => <Teams input={BUDGET_THRESHOLD} />,
};

/** A run that ended on a returned terminal status — the reason is real information. */
export const SlackRunFailedStatus: Story = {
  render: () => <Slack input={FAILED_STATUS} />,
};

/** Nothing known but the workflow: the redundant "Reason: failed" is dropped, not shown. */
export const SlackRunFailedBare: Story = {
  render: () => <Slack input={FAILED_BARE} />,
};

/** Promotion (Slice 4) — runless: workflow + version + target env, a workflow link. */
export const SlackPromotion: Story = {
  render: () => <Slack input={PROMOTION} />,
};

export const TeamsPromotion: Story = {
  render: () => <Teams input={PROMOTION} />,
};

/** Self-healing fix proposal (Phase 2) — runless, no approve/reject buttons. */
export const SlackFixProposal: Story = {
  render: () => <Slack input={FIX_PROPOSAL} />,
};

export const TeamsFixProposal: Story = {
  render: () => <Teams input={FIX_PROPOSAL} />,
};

/* ---------------- Email (#1059) ----------------
 * Email had no story at all until now, which is most of how it kept the pre-#992 shape: the
 * channel nobody could see is the channel nobody fixed. Each story shows the SUBJECT (the only
 * part a crowded inbox renders), the HTML body and the text/plain body — a headline that exists
 * in only one of the two bodies is half a fix. Coverage mirrors the Slack stories kind for kind.
 */

/** The kind a tenant sees most: the prose headline says what failed, of which type, at which
 *  step; the subject now says it too instead of stopping at "❌ Run failed". */
export const EmailRunFailed: Story = {
  render: () => <Email input={FAILED} />,
};

/** A returned terminal status — a short reason rides the headline's first line, so it reaches
 *  the subject as well. */
export const EmailRunFailedStatus: Story = {
  render: () => <Email input={FAILED_STATUS} />,
};

/** Nothing known but the workflow: the redundant "Reason: failed" is dropped here too. */
export const EmailRunFailedBare: Story = {
  render: () => <Email input={FAILED_BARE} />,
};

export const EmailApprovalPending: Story = {
  render: () => <Email input={APPROVAL} />,
};

/** The subject keeps the flavor marker in front of the specifics. */
export const EmailApprovalReminder: Story = {
  render: () => <Email input={REMINDER} />,
};

/** Escalation — the target is the headline's SECOND line, so it stays out of the subject. */
export const EmailApprovalEscalation: Story = {
  render: () => <Email input={ESCALATION} />,
};

/** No APP_BASE_URL / signing key → no buttons and no links in either body. */
export const EmailNoLinks: Story = {
  render: () => <Email input={APPROVAL} links={{}} />,
};

/** Tenant-scoped: the headline says the spend AND what does not stop; the subject is unchanged
 *  because the header already carries the threshold. */
export const EmailBudgetThreshold: Story = {
  render: () => <Email input={BUDGET_THRESHOLD} />,
};

/** Runless — the subject is unchanged here too: the header already names the target env. */
export const EmailPromotion: Story = {
  render: () => <Email input={PROMOTION} />,
};

/** The headline states the guarantee ("Nothing is applied until you approve it") in the body,
 *  not only in the Slack fallback text. */
export const EmailFixProposal: Story = {
  render: () => <Email input={FIX_PROPOSAL} />,
};
