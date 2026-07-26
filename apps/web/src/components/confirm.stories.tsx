import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { ConfirmProvider, useConfirm } from "./confirm";
import { Button } from "./forms";

/**
 * The in-app confirm dialog that replaced `window.confirm` — which couldn't be themed, couldn't
 * distinguish a destructive action from a benign one, and could be silently suppressed by the
 * browser (making every future confirm return false, so a delete looks like it did nothing).
 *
 * The harness below shows the real call shape: `await confirm({...})` resolves true/false, so a
 * handler keeps its guard-clause structure instead of splitting in two.
 */
function Harness({
  label,
  opts,
}: {
  label: string;
  opts: Parameters<ReturnType<typeof useConfirm>>[0];
}) {
  const confirm = useConfirm();
  const [outcome, setOutcome] = useState<string>("— not asked yet —");
  return (
    <div style={{ display: "grid", gap: 14, justifyItems: "start" }}>
      <Button
        variant={opts.danger ? "danger" : "primary"}
        onClick={async () => {
          const ok = await confirm(opts);
          setOutcome(
            ok ? "confirmed → action ran" : "declined → action aborted",
          );
        }}
      >
        {label}
      </Button>
      <div
        style={{
          fontSize: "var(--text-xs)",
          color: "var(--ink-2)",
          fontFamily: "var(--font-mono)",
        }}
      >
        resolved: {outcome}
      </div>
    </div>
  );
}

const meta: Meta<typeof Harness> = {
  title: "Components/Confirm",
  component: Harness,
  decorators: [
    (Story) => (
      <ConfirmProvider>
        <div style={{ padding: 28, background: "var(--bg)", minHeight: 320 }}>
          <Story />
        </div>
      </ConfirmProvider>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof Harness>;

/**
 * The destructive default. Red accept button, warning glyph, and **focus starts on Cancel** — so a
 * reflexive Enter or Space cancels rather than deletes. The accept button names the action
 * ("Delete workflow"), never "OK", because a button label has to survive being read on its own.
 */
export const Destructive: Story = {
  args: {
    label: "Delete workflow",
    opts: {
      title: 'Delete workflow "Refund triage"?',
      body: "This removes the workflow and its webhooks, forms, chats, and schedules. Run history is kept. This can't be undone.",
      confirmLabel: "Delete workflow",
      danger: true,
    },
  },
};

/** A non-destructive question: neutral primary button, and focus starts on accept. */
export const Benign: Story = {
  args: {
    label: "Rotate secret",
    opts: {
      title: "Rotate the signing secret?",
      body: "Any provider still using the old secret will fail until you reconfigure it with the new one.",
      confirmLabel: "Rotate secret",
    },
  },
};

/** Title only — no body. The dialog omits `aria-describedby` rather than pointing at nothing. */
export const TitleOnly: Story = {
  args: {
    label: "Delete grant",
    opts: {
      title: "Delete this grant?",
      confirmLabel: "Delete grant",
      danger: true,
    },
  },
};

/**
 * A custom cancel label, for when "Cancel" is ambiguous against the action itself — "Cancel this
 * run?" with a "Cancel" button is a genuine coin-flip for the reader.
 */
export const AmbiguousCancel: Story = {
  args: {
    label: "Cancel run",
    opts: {
      title: "Cancel this run?",
      body: "The run will be terminated and can't resume.",
      confirmLabel: "Cancel run",
      cancelLabel: "Keep running",
      danger: true,
    },
  },
};

/** Long, unbroken content (a pasted id/URL) must wrap instead of stretching the panel. */
export const LongContent: Story = {
  args: {
    label: "Revoke token",
    opts: {
      title: 'Revoke "ci-deploy-bot-production-us-east-1"?',
      body: "Any client still using this token stops working immediately. Token id: nry_9f3a1c2e8b7d4a6f5e0c1b2a3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f607",
      confirmLabel: "Revoke token",
      danger: true,
    },
  },
};
