import { describe, expect, it } from "vitest";
import { INTEGRATION_PROVIDERS, getIntegrationAction } from "../src";
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
    expect(() =>
      planIntegrationCall({
        provider: "twilio",
        action: "send_sms",
        fields: { accountSid: "AC1", To: "+1", From: "+2", Body: "x" },
        baseUrl: "https://api.example",
        authHeaders: {},
        // A nested body can only arrive via a catalog bodyPath; simulate one by hand.
      }),
    ).not.toThrow();

    // Directly exercise the guard with a nested body the builder would produce from a bodyPath.
    const nested = () =>
      planIntegrationCall({
        provider: "stripe",
        action: "create_customer",
        fields: { email: { deep: "value-should-not-appear" } as never },
        baseUrl: "https://api.example",
        authHeaders: {},
      });
    expect(nested).toThrow(/nested value for 'email'/);
    expect(nested).not.toThrow(/value-should-not-appear/);
  });
});
