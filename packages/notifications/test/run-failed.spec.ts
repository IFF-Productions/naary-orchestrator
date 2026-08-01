// run_failed formatter (#987) — the kind a tenant sees most and, until this spec, the only kind
// with NO test at all. What it pins is the three defects behind "Slack messages in general does
// not look nice at all":
//
//   1. the message is prose, not a two-column `fields` FORM (Slack renders `fields` as a grid);
//   2. a 48-character run id is never a link LABEL — it goes, truncated, in the small grey
//      context line, and the button says "View run";
//   3. the reason is the REAL failure (message / type / failing step), and a reason that only
//      restates the header ("Reason: failed") is dropped rather than shown.
//
// Every assertion is about what a human sees, so the exact rendered strings are asserted — a
// looser `toContain` would pass on the old grid too.
import { describe, expect, it } from "vitest";
import {
  type NotificationInput,
  type NotificationLinks,
  notificationBlocks,
  notificationDetail,
  notificationEmail,
  notificationHeader,
  notificationPayload,
  notificationTeamsCard,
  notificationText,
  shortId,
} from "../src";

/** The real shape of a failure notification after the worker change: the thrown error's
 *  message, its ApplicationFailure type, and the node it failed at. */
const FAILED: NotificationInput = {
  kind: "run_failed",
  workflowId: "exec-t-demo-9f44d033-8bac-4418-98ec-5550172e7100",
  workflowKey: "invoice-sync",
  detail: "Agent call timed out after 60s",
  errorType: "AGENT_TIMEOUT",
  failedNodeId: "summarize",
};

const LINKS: NotificationLinks = {
  runUrl:
    "https://app.example.com/app/runs/exec-t-demo-9f44d033-8bac-4418-98ec-5550172e7100",
};

const section = (input: NotificationInput, links: NotificationLinks = LINKS) =>
  (
    notificationBlocks(input, links).blocks.find(
      (b) => (b as { type: string }).type === "section",
    ) as { text: { text: string } }
  ).text.text;

const context = (input: NotificationInput, links: NotificationLinks = LINKS) =>
  (
    notificationBlocks(input, links).blocks.find(
      (b) => (b as { type: string }).type === "context",
    ) as { elements: { text: string }[] } | undefined
  )?.elements[0].text;

describe("run_failed Slack blocks — shape", () => {
  it("is header + section + context + actions, with NO fields grid anywhere", () => {
    const { blocks } = notificationBlocks(FAILED, LINKS);
    expect(blocks.map((b) => (b as { type: string }).type)).toEqual([
      "header",
      "section",
      "context",
      "actions",
    ]);
    // The defect: Slack lays a section's `fields` array out as a two-column table, which is
    // what made the message read as a form. No block may carry one.
    expect(
      blocks.some((b) => (b as { fields?: unknown }).fields !== undefined),
    ).toBe(false);
  });

  it("headline names the workflow, the error type and the failing step", () => {
    expect(notificationHeader(FAILED)).toBe("❌ Run failed");
    expect(section(FAILED)).toBe(
      "*invoice-sync* — `AGENT_TIMEOUT` at step `summarize`\nAgent call timed out after 60s",
    );
  });

  it("puts the run id in the small context line, truncated — never as a link label", () => {
    expect(context(FAILED)).toBe("Run `exec-t-demo-9f44d033…`");
    // The old message linked `<url|run exec-t-demo-9f44d033-8bac-4418-98ec-5550172e7100>`,
    // which wrapped onto two lines in a half-width grid column.
    const json = JSON.stringify(notificationBlocks(FAILED, LINKS).blocks);
    expect(json).not.toContain(`|run ${FAILED.workflowId}>`);
    // The raw id appears nowhere a reader READS it (the deep-link href is exempt — a URL is
    // not text, and its label is "View run").
    const readable = JSON.stringify(
      notificationBlocks(FAILED, LINKS).blocks.filter(
        (b) => (b as { type: string }).type !== "actions",
      ),
    );
    expect(readable).not.toContain(FAILED.workflowId);
    // The full id still reaches the deep link and the generic payload — it is only the
    // DISPLAY that is shortened.
    expect(
      (notificationPayload(FAILED, "slack", LINKS) as { workflowId: string })
        .workflowId,
    ).toBe(FAILED.workflowId);
  });

  it("the one button is a LABEL — 'View run', not an id", () => {
    const { blocks, actions } = notificationBlocks(FAILED, LINKS);
    expect(actions).toEqual([{ label: "View run", url: LINKS.runUrl }]);
    const buttons = blocks.find(
      (b) => (b as { type: string }).type === "actions",
    ) as { elements: { text: { text: string }; url: string }[] };
    expect(buttons.elements[0].text.text).toBe("View run");
    expect(buttons.elements[0].url).toBe(LINKS.runUrl);
  });

  it("shortId keeps a short id intact and only truncates a long one", () => {
    expect(shortId("wf-1")).toBe("wf-1");
    expect(shortId(FAILED.workflowId)).toBe("exec-t-demo-9f44d033…");
  });
});

describe("run_failed — the reason says something (defect 2)", () => {
  it('drops a reason that only restates the header ("Reason: failed")', () => {
    // What the worker used to send for EVERY thrown failure. "❌ Run failed" + "failed"
    // told the reader nothing, twice.
    const bare: NotificationInput = {
      kind: "run_failed",
      workflowId: "exec-1",
      workflowKey: "invoice-sync",
      detail: "failed",
    };
    expect(notificationDetail(bare)).toBeUndefined();
    expect(section(bare)).toBe("*invoice-sync*");
    expect(
      JSON.stringify(notificationBlocks(bare, LINKS).blocks),
    ).not.toContain("Reason");
    // Same rule on every surface — Teams/email must not drift back to it.
    expect(notificationEmail(bare, LINKS).text).not.toContain("Reason:");
    expect(notificationText(bare, LINKS)).toBe(
      '❌ "invoice-sync" run failed — run exec-1. View: ' + LINKS.runUrl,
    );
  });

  it("keeps a terminal status that DOES add information, inline", () => {
    // rejected / budget_exceeded / circuit_open / invalid_graph are not restatements of the
    // header — suppression is a redundancy test, not a blocklist.
    for (const status of [
      "rejected",
      "budget_exceeded",
      "circuit_open",
      "invalid_graph",
    ]) {
      const input: NotificationInput = {
        kind: "run_failed",
        workflowId: "exec-1",
        workflowKey: "invoice-sync",
        detail: status,
      };
      expect(section(input)).toBe(`*invoice-sync* — ${status}`);
    }
  });

  it("a long error message gets its own line and is truncated", () => {
    const long = `boom ${"x".repeat(400)}`;
    const text = section({ ...FAILED, detail: long });
    const reason = text.split("\n")[1];
    expect(reason.length).toBeLessThanOrEqual(240);
    expect(reason.endsWith("…")).toBe(true);
    // A multi-line message is collapsed — a Slack alert is not a stack-trace viewer.
    expect(section({ ...FAILED, detail: "line one\nline two" })).toContain(
      "line one line two",
    );
  });

  it("degrades to just the workflow when nothing is known", () => {
    const nothing: NotificationInput = {
      kind: "run_failed",
      workflowId: "exec-1",
    };
    expect(section(nothing)).toBe("_an unnamed workflow_");
    expect(context(nothing)).toBe("Run `exec-1`");
  });

  it("omits the actions block (no fabricated button) without a run link", () => {
    const { blocks, actions } = notificationBlocks(FAILED, {});
    expect(actions).toEqual([]);
    expect(blocks.map((b) => (b as { type: string }).type)).toEqual([
      "header",
      "section",
      "context",
    ]);
    // The id is still readable — in the context line, not as a dead link.
    expect(context(FAILED, {})).toBe("Run `exec-t-demo-9f44d033…`");
  });
});

describe("run_failed — the other surfaces carry the same facts", () => {
  it("Teams facts gain the failing step + error type", () => {
    const card = notificationTeamsCard(FAILED, LINKS) as {
      attachments: {
        content: {
          body: { type: string; facts?: { title: string; value: string }[] }[];
        };
      }[];
    };
    const facts = card.attachments[0].content.body.find(
      (b) => b.type === "FactSet",
    )?.facts;
    expect(facts).toEqual([
      { title: "Workflow", value: "invoice-sync" },
      // A table cell is not a chat line: the FULL id is useful here and costs no layout.
      { title: "Run", value: FAILED.workflowId },
      { title: "Failed step", value: "summarize" },
      { title: "Error", value: "AGENT_TIMEOUT" },
      { title: "Reason", value: "Agent call timed out after 60s" },
    ]);
  });

  it("email subject/body carry the failure, not the word 'failed'", () => {
    const mail = notificationEmail(FAILED, LINKS);
    expect(mail.subject).toBe('❌ Run failed — "invoice-sync"');
    expect(mail.text).toContain("Failed step: summarize");
    expect(mail.text).toContain("Error: AGENT_TIMEOUT");
    expect(mail.text).toContain("Reason: Agent call timed out after 60s");
  });

  it("the fallback line and generic payload carry type + step too", () => {
    expect(notificationText(FAILED, LINKS)).toBe(
      '❌ "invoice-sync" run failed (AGENT_TIMEOUT · at step summarize · Agent call timed out after 60s)' +
        ` — run ${FAILED.workflowId}. View: ${LINKS.runUrl}`,
    );
    const body = notificationPayload(FAILED, "slack", LINKS) as Record<
      string,
      unknown
    >;
    expect(body.errorType).toBe("AGENT_TIMEOUT");
    expect(body.failedNodeId).toBe("summarize");
    expect(body.detail).toBe("Agent call timed out after 60s");
  });
});

describe("run_failed — injection safety survives the redesign", () => {
  it("escapes mrkdwn control chars and neutralizes backticks everywhere", () => {
    const hostile: NotificationInput = {
      kind: "run_failed",
      workflowId: "exec-<a&b>",
      workflowKey: "orders`rm -rf`<x>",
      detail: "timeout & <reset> `code`",
      errorType: "BAD`TYPE",
      failedNodeId: "node`1`",
    };
    const json = JSON.stringify(notificationBlocks(hostile, LINKS).blocks);
    expect(json).toContain("&lt;x&gt;");
    expect(json).toContain("&amp;");
    // No raw backtick from a user value survives: one would close a code span and mangle
    // the rest of the message.
    expect(json).not.toContain("rm -rf`");
    expect(json).not.toContain("BAD`TYPE");
    expect(json).not.toContain("node`1`");
    // The fallback line is mrkdwn too, so it is escaped as well.
    expect(notificationText(hostile, LINKS)).toContain(
      "orders&lt;x&gt;".replace("orders", "ordersʼrm -rfʼ"),
    );
  });
});
