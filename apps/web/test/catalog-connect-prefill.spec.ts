import { describe, expect, it } from "vitest";
import { INTEGRATION_PROVIDERS } from "@naary/dsl";
import {
  catalogConnectPrefill,
  connectableProviders,
} from "../src/screens/app/integrations/catalog-connect-prefill";

/**
 * Prefill the connect form from the catalog, so adding PagerDuty doesn't require knowing to pick
 * "Custom", knowing the base URL, and knowing the token goes in raw (#815, #673 follow-on).
 *
 * The interesting assertions are the PRECISE ones: "api_token" is true of nearly every provider
 * and therefore tells you nothing, whereas `Authorization: Token token=<your key>` is the line
 * that tells you whether the value you pasted is right.
 */

describe("catalogConnectPrefill", () => {
  it("prefills PagerDuty's endpoint and its EXACT header", () => {
    const p = catalogConnectPrefill("pagerduty");

    expect(p?.label).toBe("PagerDuty");
    expect(p?.serverUrl).toBe("https://api.pagerduty.com");
    // Not "api_token" — the actual header, prefix included.
    expect(p?.authHeader).toBe("Authorization: Token token=<your token>");
    expect(p?.hostFromConnection).toBe(false);
  });

  it("describes a bespoke header provider without inventing a prefix", () => {
    // Shopify authenticates with its own header and NO prefix.
    expect(catalogConnectPrefill("shopify")?.authHeader).toBe(
      "X-Shopify-Access-Token: <your token>",
    );
    expect(catalogConnectPrefill("deepl")?.authHeader).toBe(
      "Authorization: DeepL-Auth-Key <your token>",
    );
    expect(catalogConnectPrefill("discord")?.authHeader).toBe(
      "Authorization: Bot <your token>",
    );
  });

  it("says Basic is encoded FOR you — the trap is double-encoding it yourself", () => {
    expect(catalogConnectPrefill("jira")?.authHeader).toMatch(/Basic/);
    expect(catalogConnectPrefill("jira")?.authHeader).toMatch(
      /base64-encoded for you/,
    );
  });

  it("defaults to Bearer when the catalog states no scheme", () => {
    // GitHub sets no authScheme; the request builder's default is Bearer.
    expect(catalogConnectPrefill("github")?.authHeader).toBe(
      "Authorization: Bearer <your token>",
    );
  });

  /**
   * The distinction that breaks people: for most providers Server URL is cosmetic, but for a
   * per-tenant host it IS the address every call goes to. Prefilling a guess there would send
   * requests to the wrong company's site.
   */
  it("leaves a per-tenant host BLANK and says why", () => {
    const jira = catalogConnectPrefill("jira");

    expect(jira?.hostFromConnection).toBe(true);
    expect(jira?.serverUrl).toBe("");
    expect(jira?.serverUrlHint).toMatch(/Your own Jira host/);
    expect(jira?.serverUrlHint).toMatch(/every call goes to/);
  });

  it("marks a catalog-hosted provider's URL as a label only", () => {
    expect(catalogConnectPrefill("stripe")?.serverUrlHint).toMatch(
      /only a label/,
    );
  });

  it("returns undefined for a non-catalog key, so the manual form stands", () => {
    expect(catalogConnectPrefill("not-a-provider")).toBeUndefined();
  });

  it("carries the catalog's own prose through untouched", () => {
    const p = catalogConnectPrefill("pagerduty");
    const source = INTEGRATION_PROVIDERS.find((x) => x.key === "pagerduty");

    expect(p?.authNote).toBe(source?.auth);
  });
});

describe("every provider is offerable and describable", () => {
  it("the picker lists all 38 and each one prefills", () => {
    const list = connectableProviders();

    expect(list.length).toBe(INTEGRATION_PROVIDERS.length);
    expect(list.length).toBeGreaterThan(30); // not vacuous if the catalog is ever emptied

    for (const { key } of list) {
      const p = catalogConnectPrefill(key);
      expect(p, `${key} did not prefill`).toBeDefined();
      // The minimum useful answer names a HEADER and where the token goes. (Not "ends with the
      // placeholder" — my first version asserted that and Basic legitimately ends with its
      // explanation instead, so the assertion was wrong rather than the code.)
      expect(p?.authHeader, `${key} header`).toMatch(/^[\w-]+: /);
      expect(p?.authHeader, `${key} placeholder`).toMatch(/your token/);
      expect(p?.authNote?.length ?? 0, `${key} prose`).toBeGreaterThan(0);
    }
  });
});
