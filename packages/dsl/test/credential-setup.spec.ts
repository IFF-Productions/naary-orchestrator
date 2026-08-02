import { describe, expect, it } from "vitest";
import {
  INTEGRATION_PROVIDERS,
  deriveTokenFormat,
  resolveCredentialSetup,
  getIntegrationProvider,
} from "../src";
import type { IntegrationProvider } from "../src";

/**
 * The PURE half of the Connect dialog's "where do I get this token?" help (#1063).
 *
 * The value here is the precedence rule: `tokenFormat` is generated from `authScheme` so that
 * every provider says something, and an authored sentence must beat it — a generated line that
 * silently overwrote Stripe's "the publishable key will not work" would be a regression nobody
 * would notice until a user pasted `pk_…`.
 */

/** A minimal provider; each test names only the field it is about. */
const provider = (over: Partial<IntegrationProvider>): IntegrationProvider => ({
  key: "test",
  label: "Test",
  description: "d",
  auth: "a",
  actions: [],
  ...over,
});

describe("deriveTokenFormat — the paste format implied by authScheme", () => {
  it("bearer (and an omitted scheme) says the prefix is added for you", () => {
    for (const p of [
      provider({ authScheme: "bearer" }),
      provider({ authScheme: undefined }),
    ]) {
      expect(deriveTokenFormat(p)).toMatch(/Bearer/);
      expect(deriveTokenFormat(p)).toMatch(/on its own/);
    }
  });

  it("basic asks for the PAIR, without naming which one", () => {
    const hint = deriveTokenFormat(provider({ authScheme: "basic" }));
    expect(hint).toMatch(/id:secret/);
    expect(hint).toMatch(/both halves/);
    // Jira's pair is an email, Twilio's an Account SID, Zendesk's an email + literal `/token`.
    // A generated sentence that named one would be wrong for the other two.
    expect(hint).not.toMatch(/email/i);
  });

  it("a custom header with a prefix names the prefix as the thing NOT to type", () => {
    const hint = deriveTokenFormat(
      provider({ authScheme: { header: "Authorization", prefix: "Bot " } }),
    );
    expect(hint).toMatch(/`Authorization: Bot <token>`/);
    expect(hint).toMatch(/`Bot` prefix yourself/);
  });

  it("Authorization with NO prefix says the token is the whole header", () => {
    const hint = deriveTokenFormat(
      provider({ authScheme: { header: "Authorization" } }),
    );
    expect(hint).toMatch(/whole `Authorization` header/i);
    expect(hint).toMatch(/no `Bearer `/);
  });

  it("a provider-specific header names that header and the provider", () => {
    const hint = deriveTokenFormat(
      provider({
        label: "Shopify",
        authScheme: { header: "X-Shopify-Access-Token" },
      }),
    );
    expect(hint).toMatch(/Shopify's own `X-Shopify-Access-Token` header/);
    expect(hint).toMatch(/not as a Bearer/);
  });

  it("every shipped provider produces a non-empty hint", () => {
    // The one line that catches a new bespoke auth scheme falling through a wrong branch.
    for (const p of INTEGRATION_PROVIDERS) {
      expect(deriveTokenFormat(p).length, p.key).toBeGreaterThan(20);
    }
  });
});

describe("resolveCredentialSetup — authored beats generated", () => {
  it("fills tokenFormat in when the provider authored none", () => {
    const p = provider({ authScheme: "bearer" });
    expect(p.credentialSetup?.tokenFormat).toBeUndefined();
    expect(resolveCredentialSetup(p).tokenFormat).toBe(deriveTokenFormat(p));
  });

  it("keeps an AUTHORED tokenFormat verbatim, generating nothing", () => {
    const p = provider({
      authScheme: "bearer",
      credentialSetup: { tokenFormat: "Paste the secret key." },
    });
    expect(resolveCredentialSetup(p).tokenFormat).toBe("Paste the secret key.");
  });

  it("carries the authored link/scopes/steps through untouched", () => {
    const setup = {
      tokenUrl: "https://example.com/tokens",
      scopes: ["a:read"],
      steps: ["Do the thing."],
    };
    expect(
      resolveCredentialSetup(provider({ credentialSetup: setup })),
    ).toEqual({ ...setup, tokenFormat: expect.any(String) });
  });

  it("answers for EVERY provider, authored or not", () => {
    for (const p of INTEGRATION_PROVIDERS) {
      expect(resolveCredentialSetup(p).tokenFormat, p.key).toBeTruthy();
    }
  });

  it("Stripe's authored warning survives (a bearer provider that needs more than the scheme)", () => {
    const stripe = getIntegrationProvider("stripe")!;
    expect(stripe.authScheme).toBe("bearer");
    const hint = resolveCredentialSetup(stripe).tokenFormat;
    expect(hint).toMatch(/publishable `pk_…` key will not work/);
    expect(hint).not.toBe(deriveTokenFormat(stripe));
  });

  it("Jira's authored pair replaces the deliberately vague Basic sentence", () => {
    const jira = getIntegrationProvider("jira")!;
    expect(jira.authScheme).toBe("basic");
    expect(resolveCredentialSetup(jira).tokenFormat).toMatch(
      /your-email@company\.com:your-api-token/,
    );
  });
});
