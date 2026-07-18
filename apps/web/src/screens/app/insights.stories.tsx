import type { Meta, StoryObj } from "@storybook/react-vite";
import type { InsightsReport } from "../../lib/api";
import { InsightsBody } from "./insights";

// A realistic ~10-day window with two envs and a handful of workflows so the time-series bars, the
// ranked env/workflow bars, and the null-bucket labels all show.
const days = (n: number, cost: number, calls: number) => ({
  date: `2026-07-${String(n).padStart(2, "0")}`,
  costUsd: cost,
  totalTokens: calls * 1500,
  calls,
});

const POPULATED: InsightsReport = {
  range: { from: "2026-07-01", to: null },
  totals: { costUsd: 6.4212, totalTokens: 812_000, calls: 214 },
  byDay: [
    days(8, 0.42, 12),
    days(9, 0.61, 18),
    days(10, 0.38, 9),
    days(11, 0.94, 26),
    days(12, 0.12, 4),
    days(13, 0.77, 21),
    days(14, 1.31, 40),
    days(15, 0.58, 17),
    days(16, 1.02, 31),
    days(17, 0.28, 36),
  ],
  byEnvironment: [
    { environmentId: "prod", costUsd: 4.9, totalTokens: 600_000, calls: 150 },
    { environmentId: "sandbox", costUsd: 1.3, totalTokens: 180_000, calls: 55 },
    { environmentId: null, costUsd: 0.2212, totalTokens: 32_000, calls: 9 },
  ],
  byWorkflow: [
    {
      workflowKey: "refund-triage",
      costUsd: 2.7,
      totalTokens: 330_000,
      calls: 88,
    },
    {
      workflowKey: "github-pr-ai-review",
      costUsd: 1.9,
      totalTokens: 250_000,
      calls: 61,
    },
    {
      workflowKey: "support-summary",
      costUsd: 1.1,
      totalTokens: 150_000,
      calls: 44,
    },
    { workflowKey: null, costUsd: 0.7212, totalTokens: 82_000, calls: 21 },
  ],
  byModel: [],
};

const SINGLE_ENV: InsightsReport = {
  range: { from: "2026-07-10", to: null },
  totals: { costUsd: 0.9, totalTokens: 120_000, calls: 30 },
  byDay: [days(15, 0.3, 10), days(16, 0.35, 12), days(17, 0.25, 8)],
  byEnvironment: [
    { environmentId: "prod", costUsd: 0.9, totalTokens: 120_000, calls: 30 },
  ],
  byWorkflow: [
    {
      workflowKey: "refund-triage",
      costUsd: 0.9,
      totalTokens: 120_000,
      calls: 30,
    },
  ],
  byModel: [],
};

const EMPTY: InsightsReport = {
  range: { from: "2026-07-01", to: null },
  totals: { costUsd: 0, totalTokens: 0, calls: 0 },
  byDay: [],
  byEnvironment: [],
  byWorkflow: [],
  byModel: [],
};

const meta: Meta<typeof InsightsBody> = {
  title: "App/Insights",
  component: InsightsBody,
  parameters: { layout: "padded" },
};
export default meta;

type Story = StoryObj<typeof InsightsBody>;

export const Populated: Story = { args: { data: POPULATED } };
export const SingleEnvironment: Story = { args: { data: SINGLE_ENV } };
export const Empty: Story = { args: { data: EMPTY } };
