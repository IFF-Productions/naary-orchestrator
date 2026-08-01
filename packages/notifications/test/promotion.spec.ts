// promotion formatter payloads (REDESIGN-FUNCTIONALITY-GAPS.md Slice 4): a workflow
// definition promoted into an environment — workflow/version/from/to facts + a workflow
// deep link, never the run-scoped Approve/Reject/View-run affordances (there is no run).
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
  kind: "promotion",
  workflowId: "poller", // the WORKFLOW KEY — promotions have no run
  workflowKey: "poller",
  fromEnv: "sandbox",
  toEnv: "prod",
  version: 7,
};

const LINKS: NotificationLinks = {
  workflowUrl: "https://app.example.com/app/workflows/poller",
};

describe("promotion formatter", () => {
  it("header names the target environment", () => {
    expect(notificationHeader(INPUT)).toBe("🚀 Workflow promoted to prod");
    expect(notificationHeader({ ...INPUT, toEnv: undefined })).toBe(
      "🚀 Workflow promoted",
    );
  });

  it("text carries workflow, from → to, version and the workflow link", () => {
    const text = notificationText(INPUT, LINKS);
    expect(text).toContain('"poller"');
    expect(text).toContain("sandbox → prod");
    expect(text).toContain("(v7)");
    expect(text).toContain(LINKS.workflowUrl as string);
  });

  it("actions: ONLY the workflow link — no Approve/Reject, no View run", () => {
    expect(notificationActions(INPUT, LINKS)).toEqual([
      { label: "View workflow", url: LINKS.workflowUrl },
    ]);
    // No fabricated buttons without a link.
    expect(notificationActions(INPUT, {})).toEqual([]);
  });

  it("Slack blocks: a prose headline + a context line — never a fields grid (#987)", () => {
    const { blocks } = notificationBlocks(INPUT, LINKS);
    // No block anywhere carries a `fields` array: that is what Slack renders as the
    // two-column form the redesign removed.
    expect(
      blocks.some((b) => (b as { fields?: unknown }).fields !== undefined),
    ).toBe(false);
    const section = blocks.find(
      (b) => (b as { type: string }).type === "section",
    ) as { text: { text: string } };
    // The promotion said as a sentence, not as four label/value cells.
    expect(section.text.text).toBe("*poller* is now *v7* in *prod*.");
    const context = blocks.find(
      (b) => (b as { type: string }).type === "context",
    ) as { elements: { text: string }[] };
    expect(context.elements[0].text).toBe("Promoted from *sandbox*");
    // A promotion has NO run — `workflowId` carries the key, so nothing may claim otherwise.
    expect(JSON.stringify(blocks)).not.toContain("Run ");
  });

  it("degrades cleanly when version / envs are missing", () => {
    const only = (input: NotificationInput) =>
      (
        notificationBlocks(input, LINKS).blocks.find(
          (b) => (b as { type: string }).type === "section",
        ) as { text: { text: string } }
      ).text.text;
    expect(only({ ...INPUT, version: undefined })).toBe(
      "*poller* is now live in *prod*.",
    );
    expect(only({ ...INPUT, toEnv: undefined })).toBe("*poller* is now *v7*.");
    expect(only({ ...INPUT, toEnv: undefined, version: undefined })).toBe(
      "*poller* was promoted.",
    );
    // No source env → no context line rather than an empty grey line.
    expect(
      notificationBlocks({ ...INPUT, fromEnv: undefined }, LINKS).blocks.some(
        (b) => (b as { type: string }).type === "context",
      ),
    ).toBe(false);
  });

  it("Teams card: From/To/Version facts + a View-workflow OpenUrl action", () => {
    const card = notificationTeamsCard(INPUT, LINKS) as {
      attachments: {
        content: {
          body: { type: string; facts?: { title: string; value: string }[] }[];
          actions?: { type: string; title: string; url: string }[];
        };
      }[];
    };
    const facts = card.attachments[0].content.body.find(
      (b) => b.type === "FactSet",
    )?.facts;
    expect(facts).toContainEqual({ title: "From", value: "sandbox" });
    expect(facts).toContainEqual({ title: "To", value: "prod" });
    expect(facts).toContainEqual({ title: "Version", value: "v7" });
    expect(facts?.map((f) => f.title)).not.toContain("Run");
    expect(card.attachments[0].content.actions).toEqual([
      {
        type: "Action.OpenUrl",
        title: "View workflow",
        url: LINKS.workflowUrl,
      },
    ]);
  });

  it("generic payload: raw fromEnv/toEnv/version + workflowUrl for generic hooks", () => {
    const body = notificationPayload(INPUT, "slack", LINKS) as Record<
      string,
      unknown
    >;
    expect(body.kind).toBe("promotion");
    expect(body.fromEnv).toBe("sandbox");
    expect(body.toEnv).toBe("prod");
    expect(body.version).toBe(7);
    expect(body.workflowUrl).toBe(LINKS.workflowUrl);
  });

  it("escapes env names in Slack mrkdwn (a hostile env name can't inject markup)", () => {
    const { blocks } = notificationBlocks(
      { ...INPUT, fromEnv: "sand<box>", toEnv: "pr&od" },
      LINKS,
    );
    const joined = JSON.stringify(blocks);
    expect(joined).toContain("sand&lt;box&gt;");
    expect(joined).toContain("pr&amp;od");
  });
});
