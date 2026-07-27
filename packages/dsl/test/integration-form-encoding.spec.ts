import { describe, expect, it } from "vitest";
import {
  INTEGRATION_PROVIDERS,
  buildIntegrationRequest,
  getIntegrationAction,
} from "../src";
import { planIntegrationCall } from "../src/integration-request";

/**
 * #707 — Twilio and Stripe reject a JSON body outright: both APIs accept ONLY
 * `application/x-www-form-urlencoded`. The catalog had no field that could say so, so five shipped
 * WRITE actions — Twilio send_sms/make_call and Stripe create_customer/create_payment_intent/
 * create_refund — failed 100% of the time. An author placing one got a failure they couldn't fix
 * from the UI.
 *
 * These pin the wire format, because that is the entire bug: the request "looked" right in every
 * unit test that only checked method/path/body-object.
 */

const plan = (
  provider: string,
  action: string,
  fields: Record<string, unknown>,
) =>
  planIntegrationCall({
    provider,
    action,
    fields,
    baseUrl: "https://api.example",
    authHeaders: { Authorization: "Bearer tok" },
  });

describe("form-encoded providers send a form body", () => {
  it("Twilio send_sms posts urlencoded, not JSON", () => {
    const out = plan("twilio", "send_sms", {
      accountSid: "AC123",
      To: "+15558675310",
      From: "+15551112222",
      Body: "hello there",
    });
    expect(out.headers["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    // Spaces as `+`, which is what a form body means by a space.
    expect(out.body).toBe(
      "To=%2B15558675310&From=%2B15551112222&Body=hello+there",
    );
    // The `+` of an E.164 number MUST be percent-encoded — a literal `+` in a form body decodes as
    // a space, so an unencoded number would reach Twilio as " 15558675310" and be rejected.
    expect(out.body).not.toContain("=+1555");
  });

  it("Stripe create_payment_intent posts urlencoded", () => {
    const out = plan("stripe", "create_payment_intent", {
      amount: 1999,
      currency: "usd",
      customer: "cus_123",
    });
    expect(out.headers["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(out.body).toBe("amount=1999&currency=usd&customer=cus_123");
  });

  it("still sends JSON for every provider that expects it", () => {
    const out = plan("github", "create_issue", {
      owner: "octocat",
      repo: "hello",
      title: "It broke",
    });
    expect(out.headers["Content-Type"]).toBe("application/json");
    expect(out.body).toBe(JSON.stringify({ title: "It broke" }));
  });

  /** A GET has no body and must not acquire a Content-Type from either branch. */
  it("adds no Content-Type to a read", () => {
    const out = plan("twilio", "list_messages", { accountSid: "AC123" });
    expect(out.body).toBeUndefined();
    expect(out.headers["Content-Type"]).toBeUndefined();
  });
});

describe("the encoding is declared by the catalog, not guessed", () => {
  /**
   * The five actions that were broken. Named explicitly rather than derived, so removing a flag
   * fails here instead of silently shipping a request the provider rejects.
   */
  it.each([
    ["twilio", "send_sms"],
    ["twilio", "make_call"],
    ["stripe", "create_customer"],
    ["stripe", "create_payment_intent"],
    ["stripe", "create_refund"],
  ])("%s.%s is marked form-encoded", (provider, action) => {
    expect(getIntegrationAction(provider, action)?.bodyEncoding).toBe("form");
  });

  /**
   * Everything else must stay JSON. `bodyEncoding` defaults to undefined precisely so adding the
   * field changed no existing entry — this asserts that, rather than trusting it.
   */
  it("no other action was switched", () => {
    const formActions = Object.values(INTEGRATION_PROVIDERS).flatMap((p) =>
      p.actions
        .filter((a) => a.bodyEncoding === "form")
        .map((a) => `${p.key}.${a.key}`),
    );
    expect(formActions.sort()).toEqual([
      "stripe.create_customer",
      "stripe.create_payment_intent",
      "stripe.create_refund",
      "twilio.make_call",
      "twilio.send_sms",
    ]);
  });

  /** Only WRITES were affected: a form-encoded GET would be a catalog mistake. */
  it("every form-encoded action is a POST write", () => {
    for (const p of Object.values(INTEGRATION_PROVIDERS)) {
      for (const a of p.actions.filter((x) => x.bodyEncoding === "form")) {
        expect(a.method, `${p.key}.${a.key}`).toBe("POST");
        expect(a.write, `${p.key}.${a.key}`).toBe(true);
      }
    }
  });
});

describe("a nested value is refused, not mangled", () => {
  /**
   * A form body has no nesting. Stripe wants `metadata[key]=v`, others want `a.b=v` — any mapping
   * we invented would be a guess, and a silently wrong encoding produces a provider 400 the author
   * can't diagnose from the UI, which is the failure this whole change exists to remove.
   */
  it("throws naming the field, and never echoes its value", () => {
    const nested = () =>
      buildIntegrationRequest("stripe", "create_customer", {
        email: { deep: "value-should-not-appear" },
      });
    expect(nested).toThrow(/nested value for 'email'/);
    expect(nested).not.toThrow(/value-should-not-appear/);
  });

  /**
   * REJECTED AT BUILD TIME, not just in the encoder, and that placement is the point: the activity
   * wraps `buildIntegrationRequest` in a catch that maps to a NON-RETRYABLE
   * INTEGRATION_INVALID_CONFIG, exactly as it does for a CR/LF in a header field. Thrown later —
   * from the planner, after auth resolution — it would instead hit the activity's transient
   * fallthrough and be retried as if it were a network blip, with this message sanitized away.
   */
  it("is rejected by the builder, so the activity classifies it as a config fault", () => {
    expect(() =>
      buildIntegrationRequest("twilio", "send_sms", {
        accountSid: "AC1",
        To: "+15550001111",
        From: "+15552223333",
        Body: { nope: true },
      }),
    ).toThrow(/form-encoded actions can't send a nested value for 'Body'/);
  });

  /** An ARRAY is not nesting — it's a repeated key, which both APIs accept. */
  it("allows a list", () => {
    expect(() =>
      buildIntegrationRequest("stripe", "create_customer", {
        name: ["a", "b"],
      }),
    ).not.toThrow();
  });

  /** A JSON action is untouched by any of this — nesting is its whole point. */
  it("still allows a nested body for a JSON action", () => {
    expect(() =>
      buildIntegrationRequest("pagerduty", "create_incident", {
        title: "x",
        serviceId: "P1",
        from: "a@b.c",
      }),
    ).not.toThrow();
  });
});
