import { describe, expect, it } from "vitest";
import { INTEGRATION_PROVIDERS } from "@naary/dsl";
import {
  catalogConnectPrefill,
  connectableProviders,
  splitInlineCode,
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

  /**
   * PostHog (#1110): a per-tenant host that ALSO has a default, which is the one case where
   * prefilling is right — `https://us.posthog.com` is the host the call goes to anyway, and a US
   * tenant leaving it alone gets today's behaviour while an EU tenant edits two letters.
   */
  it("prefills PostHog's default region and names the fallback", () => {
    const ph = catalogConnectPrefill("posthog");

    expect(ph?.hostFromConnection).toBe(true);
    expect(ph?.serverUrl).toBe("https://us.posthog.com");
    expect(ph?.serverUrlHint).toMatch(/every call goes to/);
    expect(ph?.serverUrlHint).toMatch(/https:\/\/us\.posthog\.com/);
    // The form's placeholder must offer the region choice, not Atlassian's site URL.
    expect(ph?.serverUrlPlaceholder).toMatch(/eu\.posthog\.com/);
  });

  /** The placeholder used to be one hardcoded Atlassian URL for every per-tenant host. */
  it("gives every per-tenant host its OWN example URL", () => {
    for (const p of INTEGRATION_PROVIDERS.filter(
      (x) => x.baseUrlFromConnection,
    )) {
      const prefill = catalogConnectPrefill(p.key);
      expect(prefill?.serverUrlPlaceholder, p.key).toBe(p.serverUrlExample);
      expect(prefill?.serverUrlPlaceholder, p.key).toMatch(/^https:\/\//);
    }
    // Non-vacuous, and specific: Shopify's example is a shop, not a Jira site.
    expect(catalogConnectPrefill("shopify")?.serverUrlPlaceholder).toMatch(
      /myshopify\.com/,
    );
    expect(catalogConnectPrefill("jira")?.serverUrlPlaceholder).toMatch(
      /atlassian\.net/,
    );
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

/**
 * "Where do I get this token?" answered in the dialog that asks for it (#1063). The prefill is
 * where the Connect form gets every fact it shows, so this is where the new one has to arrive.
 */
describe("credential setup reaches the connect form", () => {
  it("carries the authored link, scopes and steps for a provider that has them", () => {
    const setup = catalogConnectPrefill("slack")?.credentialSetup;

    expect(setup?.tokenUrl).toBe("https://api.slack.com/apps");
    expect(setup?.scopes).toContain("chat:write");
    expect(setup?.steps?.[0]).toMatch(/api\.slack\.com\/apps/);
  });

  /**
   * PICKED, not named. The point of #1063 is that the remaining providers get authored over time
   * (#754), so hard-coding "front is blank" would be a trap set for whoever authors it — a red
   * suite for a reason unrelated to what this asserts. When the last one is authored the
   * behaviour has nothing left to describe, so the test steps aside rather than failing; the
   * every-provider loop below still holds the invariant that matters.
   */
  const unauthoredBearer = INTEGRATION_PROVIDERS.find(
    (p) =>
      !p.credentialSetup &&
      (p.authScheme === undefined || p.authScheme === "bearer"),
  );

  it.skipIf(!unauthoredBearer)(
    "still answers the paste format for an UNauthored provider",
    () => {
      const setup = catalogConnectPrefill(
        unauthoredBearer!.key,
      )?.credentialSetup;

      // Derived from the auth scheme, so the token field is never left with nothing to say…
      expect(setup?.tokenFormat, unauthoredBearer!.key).toMatch(/Bearer/);
      // …and nothing is invented: no link, no scopes.
      expect(setup?.tokenUrl).toBeUndefined();
      expect(setup?.scopes).toBeUndefined();
    },
  );

  it("prefers a provider's authored format over the derived one", () => {
    expect(
      catalogConnectPrefill("stripe")?.credentialSetup.tokenFormat,
    ).toMatch(/publishable `pk_…` key will not work/);
  });
});

describe("splitInlineCode", () => {
  it("splits `backticked` runs out so the dialog renders code, not backticks", () => {
    expect(splitInlineCode("Paste `sk_test_…` on its own.")).toEqual([
      { text: "Paste ", code: false },
      { text: "sk_test_…", code: true },
      { text: " on its own.", code: false },
    ]);
  });

  it("leaves plain text and an unpaired backtick alone", () => {
    expect(splitInlineCode("no code here")).toEqual([
      { text: "no code here", code: false },
    ]);
    expect(splitInlineCode("a ` dangling one")).toEqual([
      { text: "a ` dangling one", code: false },
    ]);
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
      // Every provider says SOMETHING about the value being pasted — authored or derived.
      expect(
        p?.credentialSetup.tokenFormat?.length ?? 0,
        `${key} token format`,
      ).toBeGreaterThan(20);
      // The minimum useful answer names a HEADER and where the token goes. (Not "ends with the
      // placeholder" — my first version asserted that and Basic legitimately ends with its
      // explanation instead, so the assertion was wrong rather than the code.)
      expect(p?.authHeader, `${key} header`).toMatch(/^[\w-]+: /);
      expect(p?.authHeader, `${key} placeholder`).toMatch(/your token/);
      expect(p?.authNote?.length ?? 0, `${key} prose`).toBeGreaterThan(0);
    }
  });
});
