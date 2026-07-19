import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";
import { Billing } from "./Billing";

/**
 * Usage & budgets screen — hero + enforcement ladder against msw-mocked
 * usage/insights/budget endpoints. Two states: Healthy (downgrade policy,
 * ~33% used) and Near cap (reject policy, 93% used, guardrail banner +
 * company outer cap).
 */

const DAY = 86_400_000;
const MODELS = [
  { provider: "anthropic", model: "claude-sonnet-4-5", weight: 0.52 },
  { provider: "openai", model: "gpt-4o", weight: 0.27 },
  { provider: "anthropic", model: "claude-3-5-haiku", weight: 0.13 },
  { provider: "openai", model: "embeddings-3-large", weight: 0.05 },
  { provider: "self", model: "llama-3-70b", weight: 0.03 },
];

/** Deterministic-ish daily seed so the stacked chart has a believable shape. */
const SEED = [
  3, 4, 3, 5, 6, 4, 5, 7, 6, 8, 7, 6, 9, 8, 7, 9, 11, 9, 8, 10, 12, 10, 9, 11,
  13, 12, 10, 13, 15, 14,
];

/** 30 days of ledger line items + the matching insights rollup. */
function usageFixtures(scale: number) {
  const now = Date.now();
  const events: object[] = [];
  const byDay: {
    date: string;
    costUsd: number;
    totalTokens: number;
    calls: number;
  }[] = [];
  const byModelAgg = new Map<
    string,
    {
      provider: string;
      model: string;
      costUsd: number;
      totalTokens: number;
      calls: number;
    }
  >();
  let totalCost = 0;
  let totalTokens = 0;
  let calls = 0;

  for (let i = 29; i >= 0; i--) {
    const t = now - i * DAY;
    const date = new Date(t).toISOString().slice(0, 10);
    const dayCost = SEED[29 - i] * scale;
    let dayTotal = 0;
    let dayTokens = 0;
    let dayCalls = 0;
    for (const m of MODELS) {
      const cost = dayCost * m.weight;
      const tokens = Math.round(cost * 90_000);
      dayTotal += cost;
      dayTokens += tokens;
      dayCalls += 4;
      totalCost += cost;
      totalTokens += tokens;
      calls += 4;
      const key = `${m.provider}/${m.model}`;
      const agg = byModelAgg.get(key) ?? {
        provider: m.provider,
        model: m.model,
        costUsd: 0,
        totalTokens: 0,
        calls: 0,
      };
      agg.costUsd += cost;
      agg.totalTokens += tokens;
      agg.calls += 4;
      byModelAgg.set(key, agg);
      events.push({
        id: `u-${date}-${m.model}`,
        executionId: `run-${date}`,
        nodeId: "agent-1",
        provider: m.provider,
        model: m.model,
        inputTokens: Math.round(tokens * 0.8),
        outputTokens: Math.round(tokens * 0.2),
        totalTokens: tokens,
        costUsd: cost,
        createdAt: new Date(t).toISOString(),
      });
    }
    byDay.push({
      date,
      costUsd: dayTotal,
      totalTokens: dayTokens,
      calls: dayCalls,
    });
  }

  const byModel = [...byModelAgg.values()];
  return {
    usage: {
      totalCostUsd: totalCost,
      totalTokens,
      byModel,
      events,
    },
    insights: {
      range: { from: byDay[0].date, to: null },
      totals: { costUsd: totalCost, totalTokens, calls },
      byDay,
      byEnvironment: [
        {
          environmentId: "e-prod",
          costUsd: totalCost * 0.7,
          totalTokens: Math.round(totalTokens * 0.7),
          calls: Math.round(calls * 0.7),
        },
        {
          environmentId: "e-uat",
          costUsd: totalCost * 0.2,
          totalTokens: Math.round(totalTokens * 0.2),
          calls: Math.round(calls * 0.2),
        },
        {
          environmentId: "e-sb",
          costUsd: totalCost * 0.1,
          totalTokens: Math.round(totalTokens * 0.1),
          calls: Math.round(calls * 0.1),
        },
      ],
      byWorkflow: [
        {
          workflowKey: "deal-won-notifier",
          costUsd: totalCost * 0.36,
          totalTokens: 0,
          calls: 4200,
        },
        {
          workflowKey: "rag-support-bot",
          costUsd: totalCost * 0.28,
          totalTokens: 0,
          calls: 3100,
        },
        {
          workflowKey: "nightly-digest",
          costUsd: totalCost * 0.17,
          totalTokens: 0,
          calls: 900,
        },
        {
          workflowKey: "invoice-ap",
          costUsd: totalCost * 0.12,
          totalTokens: 0,
          calls: 640,
        },
        {
          workflowKey: "incident-triage",
          costUsd: totalCost * 0.07,
          totalTokens: 0,
          calls: 220,
        },
      ],
      byModel,
    },
  };
}

const ENVIRONMENTS = [
  { id: "e-sb", name: "sandbox", slug: "sandbox", isDefault: true },
  { id: "e-uat", name: "UAT", slug: "uat", isDefault: false },
  { id: "e-prod", name: "prod", slug: "prod", isDefault: false },
];

function run(id: string, status: string, daysAgo: number, cost: number | null) {
  const at = new Date(Date.now() - daysAgo * DAY).toISOString();
  return {
    workflowId: id,
    workflowKey: "rag-support-bot",
    status,
    costUsd: cost,
    startedAt: at,
    createdAt: at,
    archived: false,
    graphVersion: 3,
  };
}

function handlers(opts: {
  budget: object;
  runs: object[];
  companies?: object[];
  companyBudget?: object;
  scale: number;
}) {
  const fx = usageFixtures(opts.scale);
  return [
    http.get("*/api/me", () => HttpResponse.json({ tenantId: "t1" })),
    http.get("*/api/tenants/:t/budget", () => HttpResponse.json(opts.budget)),
    http.get("*/api/tenants/:t/usage", () => HttpResponse.json(fx.usage)),
    http.get("*/api/tenants/:t/usage/insights", () =>
      HttpResponse.json(fx.insights),
    ),
    http.get("*/api/tenants/:t/environments", () =>
      HttpResponse.json(ENVIRONMENTS),
    ),
    http.get("*/api/executions", () => HttpResponse.json(opts.runs)),
    http.get("*/api/me/companies", () =>
      HttpResponse.json(opts.companies ?? []),
    ),
    http.get("*/api/companies/:c/budget", () =>
      HttpResponse.json(
        opts.companyBudget ?? {
          budget: null,
          mtdSpendUsd: 0,
          remainingUsd: null,
        },
      ),
    ),
  ];
}

const meta: Meta<typeof Billing> = {
  title: "Screens/Usage & budgets",
  component: Billing,
  parameters: { layout: "fullscreen" },
};
export default meta;
type Story = StoryObj<typeof Billing>;

/** ~33% of cap, downgrade policy — green pill, no banner, downgrade rung. */
export const Healthy: Story = {
  parameters: {
    msw: {
      handlers: handlers({
        scale: 0.5, // ≈ $132 over 30 days
        budget: {
          tenantId: "t1",
          monthlyCapUsd: 400,
          perExecutionCapUsd: 0.5,
          maxStepsPerRun: 50,
          onBudgetExceeded: "downgrade",
          fallbackModel: "claude-3-5-haiku",
          mtdSpendUsd: 132.4,
          remainingUsd: 267.6,
        },
        runs: [
          run("wh-1", "completed", 0.2, 0.014),
          run("wh-2", "running", 0.1, null),
          run("wh-3", "completed", 1.4, 0.032),
        ],
      }),
    },
  },
};

/** 93% of cap, reject policy — red meter, guardrail banner, company outer cap. */
export const NearCap: Story = {
  parameters: {
    msw: {
      handlers: handlers({
        scale: 1.4, // ≈ $372 over 30 days
        budget: {
          tenantId: "t1",
          monthlyCapUsd: 400,
          perExecutionCapUsd: 0.5,
          maxStepsPerRun: 50,
          onBudgetExceeded: "reject",
          fallbackModel: null,
          mtdSpendUsd: 372.1,
          remainingUsd: 27.9,
        },
        runs: [
          run("wh-1", "budget_exceeded", 0.3, 0.51),
          run("wh-2", "budget_exceeded", 1.1, 0.5),
          run("wh-3", "budget_exceeded", 2.6, 0.55),
          run("wh-4", "completed", 0.5, 0.02),
        ],
        companies: [
          { id: "c1", name: "Acme Holdings", slug: "acme", role: "owner" },
        ],
        companyBudget: {
          budget: { monthlyCapUsd: 1500, onBudgetExceeded: "reject" },
          mtdSpendUsd: 940,
          remainingUsd: 560,
        },
      }),
    },
  },
};

/** No budget configured — the hero degrades honestly and offers "Set a budget". */
export const NoBudget: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/api/tenants/:t/budget", () =>
          HttpResponse.json({ message: "no budget" }, { status: 404 }),
        ),
        ...handlers({
          scale: 0.5,
          budget: {}, // shadowed by the 404 handler above
          runs: [run("wh-1", "completed", 0.2, 0.014)],
        }),
      ],
    },
  },
};
