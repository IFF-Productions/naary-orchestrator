/**
 * The issues panel, including the dry-run states added in #832.
 *
 * `NoProblemsButUnverified` is the one worth looking at: a clean check on a flow whose connection
 * could NOT be probed. If that state ever renders as a plain "all good", the panel is lying by
 * omission — which is the exact failure the summary line exists to prevent (#835).
 */
import type { Meta, StoryObj } from "@storybook/react-vite";
import { CanvasIssuesPanel, type CanvasIssue } from "./CanvasIssuesPanel";

const meta: Meta<typeof CanvasIssuesPanel> = {
  title: "Canvas/IssuesPanel",
  component: CanvasIssuesPanel,
  args: { onSelectNode: () => {} },
};
export default meta;
type Story = StoryObj<typeof CanvasIssuesPanel>;

const lint: CanvasIssue[] = [
  {
    nodeId: "summarize",
    field: "prompt",
    ref: "{{ $json.incident.titel }}",
    message: "No upstream node produces this field.",
    kind: "reference",
  },
];

const checks: CanvasIssue[] = [
  {
    nodeId: "create-issue",
    field: "config",
    ref: undefined,
    message: "missing required field: repo",
    kind: "check",
  },
  {
    nodeId: "ack",
    field: "connection",
    ref: undefined,
    message:
      "PagerDuty rejected list_incidents with 401 — the token was rejected.",
    kind: "check",
  },
];

/** Lint only — what the panel looked like before the dry run existed. */
export const LintOnly: Story = { args: { issues: lint } };

/** A dry run that found real problems, sitting alongside the lint rows in one list. */
export const DryRunFailures: Story = {
  args: {
    issues: [...lint, ...checks],
    note: "2 problems found before running anything.",
  },
};

/** THE HONEST-EMPTY CASE: nothing failed, but nothing was verified either. */
export const NoProblemsButUnverified: Story = {
  args: {
    issues: [],
    note:
      "No problems found. 0 connections verified. 1 connection could not be checked — this " +
      "provider has no read that is safe to call blind, so its credentials are still unverified.",
  },
};

/** A fully clean, fully covered check. */
export const AllClear: Story = {
  args: { issues: [], note: "No problems found. 2 connections verified." },
};
