import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
const findFirst = vi.fn();
const count = vi.fn();
const create = vi.fn();
const update = vi.fn();
const deleteMany = vi.fn();
const connectionFindFirst = vi.fn();
vi.mock("@naary/db", () => ({
  getPrisma: () => ({
    notificationChannel: {
      findMany,
      findFirst,
      count,
      create,
      update,
      deleteMany,
    },
    connection: { findFirst: connectionFindFirst },
  }),
}));

// Mock the shared egress guard + transport so sendTest needs no real network. Defined via
// vi.hoisted so the (hoisted) vi.mock factory and the tests share the same class/spies.
const { assertEgressAllowed, safeFetch, BlockedEgressError } = vi.hoisted(
  () => {
    class BlockedEgressError extends Error {}
    return {
      assertEgressAllowed: vi.fn(),
      safeFetch: vi.fn(),
      BlockedEgressError,
    };
  },
);
vi.mock("@naary/connections", () => ({
  assertEgressAllowed,
  safeFetch,
  BlockedEgressError,
  // Email seam defaults (the service captures these into __apiNotifyDeps; tests
  // re-point the seam per spec, so these only need to exist).
  resolveSmtpUri: vi.fn(),
  pinnedSmtpUri: vi.fn(),
}));

// `approvalPath` mints a token over a CURRENT-TIME expiry claim. Pin it so the payload this
// spec DERIVES from the formatter is byte-identical to the one the service sent (the exp
// second would otherwise be free to tick over between the two calls). File-wide, so the
// reminder specs below run against the stub too — none of them assert link contents.
vi.mock("../src/executions/approval-token", () => ({
  approvalPath: (id: string) =>
    `/approve/${encodeURIComponent(id)}?token=deadbeef&exp=4102444800`,
}));

import { notificationEmail, notificationPayload } from "@naary/notifications";
import {
  __apiNotifyDeps,
  buildTestNotification,
  MAX_CHANNELS_PER_ENV,
  MAX_EMAIL_RECIPIENTS,
  NotificationsService,
} from "../src/notifications/notifications.service";

const svc = new NotificationsService();

// Email seam spies (Slice 4): SMTP-URI resolver + SSRF check/connect-pin + transport.
const resolveSmtpUri = vi.fn();
const pinnedSmtpUri = vi.fn();
const sendMail = vi.fn();

const row = (over: Record<string, unknown> = {}) => ({
  id: "ch_1",
  type: "slack",
  label: null,
  enabled: true,
  webhookUrl: "https://hooks.slack.com/x",
  config: null,
  onApprovalPending: true,
  onRunFailed: true,
  onBudgetThreshold: false,
  onPromotion: false,
  ...over,
});

const emailRow = (over: Record<string, unknown> = {}) =>
  row({
    id: "ch_mail",
    type: "email",
    webhookUrl: null,
    config: { connectionId: "conn-smtp-1", to: ["ops@acme.io"] },
    ...over,
  });

beforeEach(() => {
  findMany.mockReset();
  findFirst.mockReset();
  count.mockReset().mockResolvedValue(0);
  create.mockReset();
  update.mockReset();
  deleteMany.mockReset();
  connectionFindFirst.mockReset().mockResolvedValue({ type: "smtp" });
  assertEgressAllowed.mockReset().mockResolvedValue(undefined);
  safeFetch.mockReset().mockResolvedValue({ ok: true, status: 200 });
  resolveSmtpUri
    .mockReset()
    .mockResolvedValue("smtps://ops%40acme.io:s3cret@smtp.acme.io:465");
  // Stands in for the real pin: the URI nodemailer should dial (host → the one validated
  // address, hostname kept as the TLS servername).
  pinnedSmtpUri
    .mockReset()
    .mockImplementation(
      async (uri: string) => `${uri}?servername=smtp.acme.io`,
    );
  sendMail.mockReset().mockResolvedValue({ messageId: "m1" });
  __apiNotifyDeps.resolveSmtpUri = resolveSmtpUri as never;
  __apiNotifyDeps.pinnedSmtpUri = pinnedSmtpUri as never;
  __apiNotifyDeps.createTransport = (() => ({ sendMail })) as never;
});

describe("NotificationsService.list", () => {
  it("returns ALL rows — several channels of the SAME type coexist", async () => {
    findMany.mockResolvedValue([
      row({ id: "ch_1", label: "#alerts" }),
      row({ id: "ch_2", label: "#oncall", webhookUrl: "https://h/2" }),
      row({ id: "ch_3", type: "teams", label: null }),
    ]);
    const out = await svc.list("t-1", "e-1");
    expect(out.map((c) => c.id)).toEqual(["ch_1", "ch_2", "ch_3"]);
    expect(out.filter((c) => c.type === "slack")).toHaveLength(2);
    // Env-scoped (6b): only the active env's channels are listed.
    expect(findMany.mock.calls[0][0].where).toEqual({
      tenantId: "t-1",
      environmentId: "e-1",
    });
    // Stable order comes from the query, not post-sorting.
    expect(findMany.mock.calls[0][0].orderBy).toEqual([
      { type: "asc" },
      { createdAt: "asc" },
      { id: "asc" },
    ]);
  });

  it("returns an empty list when nothing is configured (no synthesized defaults)", async () => {
    findMany.mockResolvedValue([]);
    expect(await svc.list("t-1", "e-1")).toEqual([]);
  });
});

describe("NotificationsService.createChannel", () => {
  it("creates a SECOND channel of an existing type (N per type)", async () => {
    count.mockResolvedValue(1); // one slack channel already exists
    create.mockResolvedValue(row({ id: "ch_2", label: "#oncall" }));
    const out = await svc.createChannel("t-1", "e-1", "slack", {
      label: "#oncall",
      webhookUrl: "https://hooks.slack.com/second",
    });
    expect(out.id).toBe("ch_2");
    expect(create.mock.calls[0][0].data).toMatchObject({
      tenantId: "t-1",
      environmentId: "e-1",
      type: "slack",
      label: "#oncall",
      enabled: true, // explicit add → on by default
      webhookUrl: "https://hooks.slack.com/second",
    });
  });

  it("normalizes a blank label/URL to null", async () => {
    create.mockResolvedValue(row());
    await svc.createChannel("t-1", "e-1", "slack", {
      label: "  ",
      webhookUrl: "",
    });
    expect(create.mock.calls[0][0].data).toMatchObject({
      label: null,
      webhookUrl: null,
    });
  });

  it("rejects an unknown channel type", async () => {
    await expect(
      svc.createChannel("t-1", "e-1", "discord", { enabled: true }),
    ).rejects.toThrow(/Unknown notification channel/);
    expect(create).not.toHaveBeenCalled();
  });

  it("enforces the per-ENV channel cap (another env's channels don't count)", async () => {
    count.mockResolvedValue(MAX_CHANNELS_PER_ENV);
    await expect(svc.createChannel("t-1", "e-1", "slack", {})).rejects.toThrow(
      /limit reached/,
    );
    expect(count.mock.calls[0][0].where).toEqual({
      tenantId: "t-1",
      environmentId: "e-1",
    });
    expect(create).not.toHaveBeenCalled();
  });
});

describe("NotificationsService.updateChannel", () => {
  it("patches ONE channel by id, tenant-scoped, and normalizes blanks", async () => {
    findFirst.mockResolvedValue({ id: "ch_1" });
    update.mockResolvedValue(row({ webhookUrl: null }));
    await svc.updateChannel("t-1", "e-1", "ch_1", {
      enabled: true,
      webhookUrl: "  ",
    });
    // Existence check is TENANT+ENV-scoped (id alone would be a cross-tenant/env hole).
    expect(findFirst.mock.calls[0][0].where).toEqual({
      id: "ch_1",
      tenantId: "t-1",
      environmentId: "e-1",
    });
    expect(update.mock.calls[0][0]).toMatchObject({
      where: { id: "ch_1" },
      data: { enabled: true, webhookUrl: null },
    });
  });

  it("404s for another tenant's (or unknown) channel id", async () => {
    findFirst.mockResolvedValue(null);
    await expect(
      svc.updateChannel("t-1", "e-1", "ch_other", { enabled: false }),
    ).rejects.toThrow(/Unknown notification channel/);
    expect(update).not.toHaveBeenCalled();
  });
});

describe("NotificationsService.deleteChannel", () => {
  it("deletes by id, tenant+env-scoped (idempotent)", async () => {
    deleteMany.mockResolvedValue({ count: 1 });
    await svc.deleteChannel("t-1", "e-1", "ch_1");
    expect(deleteMany).toHaveBeenCalledWith({
      where: { id: "ch_1", tenantId: "t-1", environmentId: "e-1" },
    });
  });
});

describe("NotificationsService.sendTest", () => {
  it("404s for an unknown channel id", async () => {
    findFirst.mockResolvedValue(null);
    await expect(svc.sendTest("t-1", "e-1", "ch_ghost")).rejects.toThrow(
      /Unknown notification channel/,
    );
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("400s (and never fetches) when the channel has no webhook", async () => {
    findFirst.mockResolvedValue(row({ webhookUrl: null }));
    await expect(svc.sendTest("t-1", "e-1", "ch_1")).rejects.toThrow(
      /No webhook URL/,
    );
    expect(safeFetch).not.toHaveBeenCalled();
  });

  /** The NO-LINKS branch — an API with no APP_BASE_URL, which is most deployments' default.
   *  Asserted the same way as the linked case (#1043): the body is COMPUTED from the shared
   *  formatter, so a hand-rolled "no links" fallback would fail here too. */
  it("POSTs the shared formatter's Slack body (no APP_BASE_URL) and reports ok on 2xx", async () => {
    // Both candidates for the public base URL are unset (APP_BASE_URL, then CORS_ORIGINS).
    const saved = {
      APP_BASE_URL: process.env.APP_BASE_URL,
      CORS_ORIGINS: process.env.CORS_ORIGINS,
    };
    delete process.env.APP_BASE_URL;
    delete process.env.CORS_ORIGINS;
    try {
      findFirst.mockResolvedValue(row());
      const out = await svc.sendTest("t-1", "e-1", "ch_1");
      expect(out).toEqual({ ok: true, status: 200 });
      expect(assertEgressAllowed).toHaveBeenCalledWith(
        "https://hooks.slack.com/x",
      );
      const { input, links } = buildTestNotification();
      expect(links).toEqual({ approvalUrl: undefined, runUrl: undefined });
      const body = JSON.parse(safeFetch.mock.calls[0][1].body);
      expect(body).toEqual(notificationPayload(input, "slack", links));
      expect(body.type).toBeUndefined(); // Slack shape, not the Teams envelope
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("POSTs a Teams Adaptive Card envelope for a teams channel", async () => {
    findFirst.mockResolvedValue(
      row({ type: "teams", webhookUrl: "https://teams.example/x" }),
    );
    await svc.sendTest("t-1", "e-1", "ch_1");
    const body = JSON.parse(safeFetch.mock.calls[0][1].body);
    expect(body.type).toBe("message");
    expect(body.attachments[0].contentType).toBe(
      "application/vnd.microsoft.card.adaptive",
    );
  });

  it("maps a blocked (SSRF) URL to a 400 without fetching", async () => {
    findFirst.mockResolvedValue(
      row({ webhookUrl: "https://169.254.169.254/x" }),
    );
    assertEgressAllowed.mockRejectedValue(
      new BlockedEgressError("host resolves to a private/reserved address"),
    );
    await expect(svc.sendTest("t-1", "e-1", "ch_1")).rejects.toThrow(
      /isn't allowed/,
    );
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("surfaces a non-2xx webhook response as a 400", async () => {
    findFirst.mockResolvedValue(
      row({ type: "teams", webhookUrl: "https://teams.example/x" }),
    );
    safeFetch.mockResolvedValue({ ok: false, status: 404 });
    await expect(svc.sendTest("t-1", "e-1", "ch_1")).rejects.toThrow(
      /responded 404/,
    );
  });
});

/**
 * #1043 — the property under test is the PATH, not the shape.
 *
 * "Send test" is the one surface whose purpose is showing a tenant what they will receive, so
 * every expectation here is COMPUTED by calling `@naary/notifications` with the service's own
 * sample input — never a transcribed copy of today's blocks. Redesign the formatter and these
 * stay green; re-introduce a second, hand-rolled test payload (as #992 silently left behind)
 * and they go red, which is the regression that actually recurred.
 */
describe("NotificationsService.sendTest — the test message IS the real message (#1043)", () => {
  const saved = {
    APP_BASE_URL: process.env.APP_BASE_URL,
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
  };
  beforeEach(() => {
    // Links (and therefore the action buttons — the part of the payload a Teams Workflows
    // webhook is most likely to reject) only exist once the API knows its public base URL.
    process.env.APP_BASE_URL = "https://app.naary.io";
    process.env.ENCRYPTION_KEY = "0".repeat(64);
  });
  afterEach(() => {
    process.env.APP_BASE_URL = saved.APP_BASE_URL;
    process.env.ENCRYPTION_KEY = saved.ENCRYPTION_KEY;
    if (saved.APP_BASE_URL === undefined) delete process.env.APP_BASE_URL;
    if (saved.ENCRYPTION_KEY === undefined) delete process.env.ENCRYPTION_KEY;
  });

  it("POSTs a Slack body byte-identical to the shared formatter's", async () => {
    findFirst.mockResolvedValue(row());
    await svc.sendTest("t-1", "e-1", "ch_1");
    const { input, links } = buildTestNotification();
    expect(JSON.parse(safeFetch.mock.calls[0][1].body as string)).toEqual(
      notificationPayload(input, "slack", links),
    );
  });

  it("POSTs a Teams card byte-identical to the shared formatter's", async () => {
    findFirst.mockResolvedValue(
      row({ type: "teams", webhookUrl: "https://teams.example/x" }),
    );
    await svc.sendTest("t-1", "e-1", "ch_1");
    const { input, links } = buildTestNotification();
    expect(JSON.parse(safeFetch.mock.calls[0][1].body as string)).toEqual(
      notificationPayload(input, "teams", links),
    );
  });

  it("mails a subject + both bodies byte-identical to the shared formatter's", async () => {
    findFirst.mockResolvedValue(emailRow());
    await svc.sendTest("t-1", "e-1", "ch_mail");
    const { input, links } = buildTestNotification();
    const mail = sendMail.mock.calls[0][0];
    expect({
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    }).toEqual(notificationEmail(input, links));
  });

  /** Not a shape pin: these are the STRUCTURAL properties of the post-#992 formatter (prose
   *  headline + small grey context line, and deliberately no two-column `fields` grid) that
   *  the hand-rolled test payload provably lacked. Any formatter that still has them passes. */
  it("carries the redesigned structure — a context line, no fields grid", async () => {
    findFirst.mockResolvedValue(row());
    await svc.sendTest("t-1", "e-1", "ch_1");
    const body = JSON.parse(safeFetch.mock.calls[0][1].body as string);
    const blocks = body.blocks as { type: string; fields?: unknown }[];
    expect(blocks.some((b) => b.type === "context")).toBe(true);
    expect(blocks.every((b) => b.type !== "section" || !b.fields)).toBe(true);
    // The buttons a real approval carries are exercised too, not just the text blocks.
    expect(blocks.some((b) => b.type === "actions")).toBe(true);
  });

  /** The one thing the sample must say in its own right: this is a test. It lives in the
   *  INPUT (fake key + a title that says so), which is why the formatter can render it. */
  it("reads as a test — fake workflow key and a title that says so", async () => {
    findFirst.mockResolvedValue(row());
    await svc.sendTest("t-1", "e-1", "ch_1");
    const raw = safeFetch.mock.calls[0][1].body as string;
    expect(raw).toContain("naary-send-test");
    expect(raw).toContain("Test notification");
  });
});

describe("email channels (Slice 4) — create/update validation", () => {
  it("creates an email channel: config carries { connectionId, to }; flat view fields", async () => {
    create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve(row({ id: "ch_mail", ...data })),
    );
    const out = await svc.createChannel("t-1", "e-1", "email", {
      label: "Ops list",
      emailConnectionId: "conn-smtp-1",
      emailTo: ["ops@acme.io", " sre@acme.io "],
    });
    // The referenced connection is validated TENANT+ENV-scoped and must be smtp.
    expect(connectionFindFirst).toHaveBeenCalledWith({
      where: { id: "conn-smtp-1", tenantId: "t-1", environmentId: "e-1" },
      select: { type: true },
    });
    expect(create.mock.calls[0][0].data).toMatchObject({
      type: "email",
      webhookUrl: null,
      config: {
        connectionId: "conn-smtp-1",
        to: ["ops@acme.io", "sre@acme.io"],
      },
      onPromotion: false, // opt-in, never surprise-enabled
    });
    expect(out.type).toBe("email");
    expect(out.emailConnectionId).toBe("conn-smtp-1");
    expect(out.emailTo).toEqual(["ops@acme.io", "sre@acme.io"]);
    expect(out.onPromotion).toBe(false);
  });

  it("400s when the connection is unknown in this env, or not smtp", async () => {
    connectionFindFirst.mockResolvedValue(null);
    await expect(
      svc.createChannel("t-1", "e-1", "email", {
        emailConnectionId: "conn-ghost",
        emailTo: ["ops@acme.io"],
      }),
    ).rejects.toThrow(/Unknown SMTP connection/);

    connectionFindFirst.mockResolvedValue({ type: "github" });
    await expect(
      svc.createChannel("t-1", "e-1", "email", {
        emailConnectionId: "conn-gh",
        emailTo: ["ops@acme.io"],
      }),
    ).rejects.toThrow(/isn't an SMTP connection/);
    expect(create).not.toHaveBeenCalled();
  });

  it("caps recipients and rejects a non-address", async () => {
    await expect(
      svc.createChannel("t-1", "e-1", "email", {
        emailConnectionId: "conn-smtp-1",
        emailTo: Array.from(
          { length: MAX_EMAIL_RECIPIENTS + 1 },
          (_, i) => `u${i}@acme.io`,
        ),
      }),
    ).rejects.toThrow(/Too many recipients/);
    await expect(
      svc.createChannel("t-1", "e-1", "email", {
        emailConnectionId: "conn-smtp-1",
        emailTo: ["not an email"],
      }),
    ).rejects.toThrow(/doesn't look like an email address/);
    expect(create).not.toHaveBeenCalled();
  });

  it("update merges email config (recipients alone keep the saved connection)", async () => {
    findFirst.mockResolvedValue({
      id: "ch_mail",
      type: "email",
      config: { connectionId: "conn-smtp-1", to: ["ops@acme.io"] },
    });
    update.mockResolvedValue(emailRow());
    await svc.updateChannel("t-1", "e-1", "ch_mail", {
      emailTo: ["oncall@acme.io"],
    });
    expect(update.mock.calls[0][0].data.config).toEqual({
      connectionId: "conn-smtp-1",
      to: ["oncall@acme.io"],
    });
    // No connection change → no connection lookup needed… but the patch touched email
    // fields, so validation ran on the recipients only.
    expect(connectionFindFirst).not.toHaveBeenCalled();
  });

  it("a webhook channel's update never touches config", async () => {
    findFirst.mockResolvedValue({ id: "ch_1", type: "slack", config: null });
    update.mockResolvedValue(row());
    await svc.updateChannel("t-1", "e-1", "ch_1", { enabled: false });
    expect(update.mock.calls[0][0].data.config).toBeUndefined();
  });
});

describe("NotificationsService.sendTest — email channel", () => {
  it("sends a REAL test email through the resolved SMTP connection", async () => {
    findFirst.mockResolvedValue(emailRow());
    const out = await svc.sendTest("t-1", "e-1", "ch_mail");
    expect(out).toEqual({ ok: true, status: 200 });
    expect(resolveSmtpUri).toHaveBeenCalledWith("t-1", "conn-smtp-1");
    expect(pinnedSmtpUri).toHaveBeenCalledWith(
      "smtps://ops%40acme.io:s3cret@smtp.acme.io:465",
    );
    const mail = sendMail.mock.calls[0][0];
    expect(mail.to).toEqual(["ops@acme.io"]);
    expect(mail.from).toBe("ops@acme.io"); // decoded from the URI's user
    // The sample says it is a test through the formatter's own rendering, not a bespoke
    // subject line (#1043); the same-code-path pin lives in the describe block below.
    expect(mail.subject).toContain("naary-send-test");
    // No webhook involved.
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("400s when the email channel is unconfigured", async () => {
    findFirst.mockResolvedValue(emailRow({ config: null }));
    await expect(svc.sendTest("t-1", "e-1", "ch_mail")).rejects.toThrow(
      /No SMTP connection or recipients/,
    );
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("maps an SMTP failure to a GENERIC 400 (no URI/credential leakage)", async () => {
    findFirst.mockResolvedValue(emailRow());
    sendMail.mockRejectedValue(
      new Error("connect ECONNREFUSED smtps://ops:s3cret@smtp.acme.io:465"),
    );
    const err = await svc.sendTest("t-1", "e-1", "ch_mail").catch((e) => e);
    expect(String(err.message)).toContain("Couldn't send the test email");
    expect(String(err.message)).not.toContain("s3cret");
    expect(String(err.message)).not.toContain("smtp.acme.io");
  });
});

describe("NotificationsService.sendApprovalReminder — email fan-out", () => {
  it("delivers to BOTH a Slack webhook and an email channel; counts both", async () => {
    findMany.mockResolvedValue([
      { type: "slack", webhookUrl: "https://hooks.slack.com/x", config: null },
      {
        type: "email",
        webhookUrl: null,
        config: { connectionId: "conn-smtp-1", to: ["ops@acme.io"] },
      },
    ]);
    const out = await svc.sendApprovalReminder("t-1", "e-1", {
      workflowId: "wf-1",
      workflowKey: "poller",
      title: "Ship it?",
    });
    expect(out).toEqual({ sent: 2 });
    expect(safeFetch).toHaveBeenCalledOnce();
    expect(sendMail).toHaveBeenCalledOnce();
    const mail = sendMail.mock.calls[0][0];
    expect(mail.subject).toContain("Approval reminder");
    expect(mail.text).toContain("Ship it?");
  });

  it("an SMTP failure is best-effort: the webhook still counts, nothing throws", async () => {
    findMany.mockResolvedValue([
      {
        type: "email",
        webhookUrl: null,
        config: { connectionId: "conn-smtp-1", to: ["ops@acme.io"] },
      },
      { type: "slack", webhookUrl: "https://hooks.slack.com/x", config: null },
    ]);
    sendMail.mockRejectedValue(new Error("greylisted"));
    const out = await svc.sendApprovalReminder("t-1", "e-1", {
      workflowId: "wf-1",
    });
    expect(out).toEqual({ sent: 1 });
  });

  it("skips an unconfigured email channel without resolving anything", async () => {
    findMany.mockResolvedValue([
      { type: "email", webhookUrl: null, config: { to: [] } },
    ]);
    const out = await svc.sendApprovalReminder("t-1", "e-1", {
      workflowId: "wf-1",
    });
    expect(out).toEqual({ sent: 0 });
    expect(resolveSmtpUri).not.toHaveBeenCalled();
  });
});

describe("NotificationsService.sendPromotion (Slice 4)", () => {
  it("fans out to the TARGET env's onPromotion channels (webhook + email)", async () => {
    findMany.mockResolvedValue([
      { type: "slack", webhookUrl: "https://hooks.slack.com/x", config: null },
      {
        type: "email",
        webhookUrl: null,
        config: { connectionId: "conn-smtp-1", to: ["ops@acme.io"] },
      },
    ]);
    const out = await svc.sendPromotion("t-1", "e-prod", {
      workflowKey: "poller",
      fromEnv: "sandbox",
      toEnv: "prod",
      version: 7,
    });
    expect(out).toEqual({ sent: 2 });
    // Reads ONLY enabled + onPromotion channels of the TARGET env.
    expect(findMany.mock.calls[0][0].where).toEqual({
      tenantId: "t-1",
      environmentId: "e-prod",
      enabled: true,
      onPromotion: true,
    });
    const body = JSON.parse(safeFetch.mock.calls[0][1].body as string);
    expect(body.kind).toBe("promotion");
    expect(body.fromEnv).toBe("sandbox");
    expect(body.toEnv).toBe("prod");
    expect(body.version).toBe(7);
    const mail = sendMail.mock.calls[0][0];
    expect(mail.subject).toBe('🚀 Workflow promoted to prod — "poller"');
    expect(mail.text).toContain("From: sandbox");
    expect(mail.text).toContain("To: prod");
  });

  it("NEVER throws — even a channel-read failure resolves to { sent: 0 }", async () => {
    findMany.mockRejectedValue(new Error("db down"));
    await expect(
      svc.sendPromotion("t-1", "e-prod", {
        workflowKey: "poller",
        fromEnv: "sandbox",
        toEnv: "prod",
        version: 7,
      }),
    ).resolves.toEqual({ sent: 0 });
  });
});
