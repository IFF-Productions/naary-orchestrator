import { describe, expect, it } from "vitest";
import {
  getIntegrationProvider,
  resolveIntegrationBaseUrl,
} from "../src/index";

/**
 * WHICH HOST a provider's request goes to (#1110).
 *
 * Filed against PostHog, whose host is REGIONAL — `us.posthog.com`, `eu.posthog.com`, or a
 * self-hosted domain — while the catalog hardcoded `app.posthog.com`. Every action failed for an
 * EU tenant, and so did the credential check, because `get_me` was wrong in exactly the same way:
 * the connection test reported a broken token for a token that was fine.
 *
 * Both callers (the worker's integration activity and the API's Test Connection) resolve through
 * this one function, so that class of divergence can't come back.
 */
const provider = (key: string) => getIntegrationProvider(key)!;

describe("resolveIntegrationBaseUrl", () => {
  it("uses the catalog's static base for a fixed-host provider, ignoring any serverUrl", () => {
    // A GitHub connection's Server URL is a label; honouring it would send API calls somewhere else.
    expect(
      resolveIntegrationBaseUrl(provider("github"), "https://evil.example.com"),
    ).toBe("https://api.github.com");
  });

  it("uses the connection's serverUrl for a per-tenant host", () => {
    expect(
      resolveIntegrationBaseUrl(provider("jira"), "https://acme.atlassian.net"),
    ).toBe("https://acme.atlassian.net");
  });

  it("trims it — a pasted host with whitespace must not build a broken URL", () => {
    expect(
      resolveIntegrationBaseUrl(
        provider("jira"),
        "  https://acme.atlassian.net  ",
      ),
    ).toBe("https://acme.atlassian.net");
  });

  it("returns null when a per-tenant host has neither a serverUrl nor a default", () => {
    // The callers turn this into "this connection needs a Server URL" — a config fault with its own
    // message, never a probe against a garbage URL that reads as a bad credential.
    expect(resolveIntegrationBaseUrl(provider("jira"), "   ")).toBeNull();
    expect(resolveIntegrationBaseUrl(provider("jira"), null)).toBeNull();
    expect(resolveIntegrationBaseUrl(provider("jira"), undefined)).toBeNull();
  });

  describe("posthog — regional host with a fallback (#1110)", () => {
    it("honours the tenant's own region", () => {
      expect(
        resolveIntegrationBaseUrl(
          provider("posthog"),
          "https://eu.posthog.com",
        ),
      ).toBe("https://eu.posthog.com");
    });

    it("honours a self-hosted host", () => {
      expect(
        resolveIntegrationBaseUrl(
          provider("posthog"),
          "https://posthog.acme.com",
        ),
      ).toBe("https://posthog.acme.com");
    });

    /**
     * THE COMPATIBILITY GUARANTEE. Every PostHog connection that exists today was created while the
     * catalog hardcoded the host, so none of them stores one — and a `Connection` row records no
     * provider key (it is a `custom` connection with a user-chosen label), so no migration can find
     * them to backfill. Without this fallback, fixing EU/self-hosted tenants would break every US
     * tenant that works today.
     */
    it("falls back to US Cloud when the connection stores no host", () => {
      for (const stored of [undefined, null, "", "   "]) {
        expect(resolveIntegrationBaseUrl(provider("posthog"), stored)).toBe(
          "https://us.posthog.com",
        );
      }
    });

    it("no longer hardcodes app.posthog.com anywhere in the entry", () => {
      // The bug itself: one host cannot serve two regions. `app.posthog.com` may still be MENTIONED
      // in prose as the legacy alias, but nothing derives a request from it.
      expect(provider("posthog").baseUrl).toBeUndefined();
      expect(provider("posthog").defaultBaseUrl).toBe("https://us.posthog.com");
    });
  });
});
