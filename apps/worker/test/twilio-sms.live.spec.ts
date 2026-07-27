import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as activities from "../src/temporal/activities";

/**
 * LIVE: send a REAL SMS through the Twilio integration node.
 *
 * This is the verification #707 asks for, and it would be the FIRST live Twilio write ever
 * (docs/integrations/VERIFICATION.md had twilio at 2/4, both reads, live column empty). The bug it
 * covers is invisible to any unit test that only checks method/path/body-object: Twilio accepts
 * ONLY `application/x-www-form-urlencoded`, so every send_sms shipped before this failed 100% of
 * the time with a JSON body.
 *
 * SKIPPED unless all four are set — use a THROWAWAY number; an SMS can't be un-sent, and Twilio
 * bills for it:
 *
 *   TWILIO_TEST_ACCOUNT_SID=AC…      the Account SID (also the Basic username)
 *   TWILIO_TEST_AUTH_TOKEN=…         the Auth Token  (the Basic password)
 *   TWILIO_TEST_FROM=+1…             a Twilio number on that account, E.164
 *   TWILIO_TEST_TO=+1…               your own phone, E.164
 *
 * Run: export those, then `pnpm test:live` (or `... twilio-sms.live`).
 *
 * REAL vs seamed: the real catalog, the real planner (path/query/body + the HTTP Basic re-wrap),
 * the real egress guard, the real fetch to api.twilio.com, and the real at-most-once write-failure
 * handling all run. Only `__httpDeps.resolveAuthHeader` is swapped — to hand in the credential from
 * env instead of a seeded connection row, exactly as github-app.live.spec.ts does.
 */

const SID = process.env.TWILIO_TEST_ACCOUNT_SID;
const TOKEN = process.env.TWILIO_TEST_AUTH_TOKEN;
const FROM = process.env.TWILIO_TEST_FROM;
const TO = process.env.TWILIO_TEST_TO;
const LIVE = Boolean(SID && TOKEN && FROM && TO);

const realResolve = activities.__httpDeps.resolveAuthHeader;

describe.skipIf(!LIVE)("LIVE twilio.send_sms → a real SMS arrives", () => {
  beforeAll(() => {
    // The connection stores `AccountSid:AuthToken` and the resolver hands it back as a Bearer; the
    // planner re-wraps it as HTTP Basic. Returning it in that shape keeps that rewrite under test
    // rather than pre-computing the Basic header here.
    activities.__httpDeps.resolveAuthHeader = (async () => ({
      Authorization: `Bearer ${SID}:${TOKEN}`,
    })) as typeof activities.__httpDeps.resolveAuthHeader;
  });

  afterAll(() => {
    activities.__httpDeps.resolveAuthHeader = realResolve;
  });

  it("sends the message and Twilio returns a queued SID", async () => {
    const stamp = new Date().toISOString().slice(11, 19);
    const result = await activities.callIntegration(
      {
        provider: "twilio",
        action: "send_sms",
        connectionId: "conn-live",
        fields: {},
      } as never,
      {
        accountSid: SID as string,
        To: TO as string,
        From: FROM as string,
        // A space and a `+` in the text: both are exactly what form-encoding gets wrong when it is
        // done by hand, so a body that round-trips them proves the encoder rather than just the
        // content type.
        Body: `naary live test ${stamp} (+ok)`,
      },
      { tenantId: "t-live" } as never,
    );

    // A write that Twilio rejects throws INTEGRATION_WRITE_FAILED, so reaching here already means
    // the request was ACCEPTED — the assertions below pin what came back.
    expect(result.status).toBeGreaterThanOrEqual(200);
    expect(result.status).toBeLessThan(300);
    const body = result.body as {
      sid?: string;
      status?: string;
      body?: string;
    };
    expect(body.sid).toMatch(/^SM|^MM/); // message SID
    expect(["queued", "accepted", "sending", "sent"]).toContain(body.status);
    // Twilio echoes the message text back — proof the form body decoded correctly on their side,
    // including the space and the `+`.
    expect(body.body).toBe(`naary live test ${stamp} (+ok)`);
  }, 30_000);
});
