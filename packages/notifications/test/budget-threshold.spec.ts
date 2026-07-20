// budgetThreshold formatter payloads (REDESIGN-FUNCTIONALITY-GAPS.md Slice 3):
// tenant-scoped budget alert — cap/spend facts + a usage deep link, never the
// run-scoped Approve/Reject/View-run affordances.
import { describe, expect, it } from "vitest";
import {
  type NotificationInput,
  type NotificationLinks,
  notificationActions,
  notificationBlocks,
  notificationHeader,
  notificationPayload,
  notificationTeamsCard,
  notificationText,
} from "../src";

const INPUT: NotificationInput = {
  kind: "budget_threshold",
  workflowId: "wh-t1-crossing",
  thresholdPct: 80,
  capUsd: 400,
  spendUsd: 321.4,
};

const LINKS: NotificationLinks = {
  runUrl: "https://app.example.com/app/runs/wh-t1-crossing",
  usageUrl: "https://app.example.com/app/billing",
};

describe("budget_threshold formatter", () => {
  it("header names the threshold percentage", () => {
    expect(notificationHeader(INPUT)).toBe(
      "📊 Budget alert — 80% of the monthly cap",
    );
    expect(notificationHeader({ ...INPUT, thresholdPct: undefined })).toBe(
      "📊 Budget alert",
    );
  });

  it("text carries pct, cap, spend and the usage link", () => {
    const text = notificationText(INPUT, LINKS);
    expect(text).toContain("80%");
    expect(text).toContain("$400.00 monthly cap");
    expect(text).toContain("$321.40");
    expect(text).toContain(LINKS.usageUrl as string);
  });

  it("actions: ONLY the usage link — no Approve/Reject, no View run", () => {
    const actions = notificationActions(INPUT, LINKS);
    expect(actions).toEqual([
      { label: "View usage & budgets", url: LINKS.usageUrl },
    ]);
  });

  it("actions are empty without a usage link (no fabricated buttons)", () => {
    expect(notificationActions(INPUT, { runUrl: LINKS.runUrl })).toEqual([]);
  });

  it("Slack blocks: cap/spend fields grid (no Workflow/Run pair) + a usage button", () => {
    const { blocks, actions } = notificationBlocks(INPUT, LINKS);
    const fieldsBlock = blocks.find(
      (b) => (b as { type: string }).type === "section",
    ) as { fields: { text: string }[] };
    const texts = fieldsBlock.fields.map((f) => f.text).join("\n");
    expect(texts).toContain("*Monthly cap*");
    expect(texts).toContain("$400.00");
    expect(texts).toContain("*Spend (incl. reserved)*");
    expect(texts).toContain("$321.40");
    expect(texts).not.toContain("*Workflow*");
    expect(texts).not.toContain("*Run*");
    expect(actions.map((a) => a.label)).toEqual(["View usage & budgets"]);
  });

  it("Teams card: threshold/cap/spend FactSet + an OpenUrl usage action", () => {
    const card = notificationTeamsCard(INPUT, LINKS) as {
      attachments: {
        content: {
          body: ({ type: string } & Record<string, unknown>)[];
          actions?: { type: string; title: string; url: string }[];
        };
      }[];
    };
    const content = card.attachments[0].content;
    const factSet = content.body.find((b) => b.type === "FactSet") as {
      facts: { title: string; value: string }[];
    };
    expect(factSet.facts).toEqual([
      { title: "Threshold", value: "80%" },
      { title: "Monthly cap", value: "$400.00" },
      { title: "Spend (incl. reserved)", value: "$321.40" },
    ]);
    expect(content.actions).toEqual([
      {
        type: "Action.OpenUrl",
        title: "View usage & budgets",
        url: LINKS.usageUrl,
      },
    ]);
  });

  it("generic payload exposes the raw figures + usageUrl for non-Slack hooks", () => {
    const payload = notificationPayload(INPUT, "slack", LINKS) as Record<
      string,
      unknown
    >;
    expect(payload.kind).toBe("budget_threshold");
    expect(payload.thresholdPct).toBe(80);
    expect(payload.capUsd).toBe(400);
    expect(payload.spendUsd).toBe(321.4);
    expect(payload.usageUrl).toBe(LINKS.usageUrl);
    // Run-scoped extras stay off the budget payload.
    expect(payload.approvalUrl).toBeUndefined();
  });

  it("small-figure caps render with cent precision (sub-$1 fidelity)", () => {
    const text = notificationText(
      { ...INPUT, capUsd: 0.5, spendUsd: 0.4123 },
      LINKS,
    );
    expect(text).toContain("$0.5000 monthly cap");
    expect(text).toContain("$0.4123");
  });
});
