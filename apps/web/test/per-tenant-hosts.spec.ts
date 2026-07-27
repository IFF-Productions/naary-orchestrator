import { describe, expect, it } from "vitest";
import { INTEGRATION_PROVIDERS } from "@naary/dsl";
import { PER_TENANT_HOSTS } from "../src/screens/app/integrations/connection-forms";

/**
 * The connection form tells users that for SOME catalog providers the Server URL they type is the
 * host that actually gets called — Jira, Shopify and friends — while for the rest it is only a
 * label. Getting that backwards produces a connection that 404s every call with no form error,
 * which is exactly the class of silent failure #815 exists to remove.
 *
 * So the sentence is derived from the catalog, and this pins the derivation: if the flag is
 * renamed, the list would quietly render as "()" and the guidance would become a lie by omission.
 */
describe("PER_TENANT_HOSTS", () => {
  it("is derived from the catalog and non-empty", () => {
    const expected = INTEGRATION_PROVIDERS.filter((p) => p.baseUrlFromConnection);

    expect(expected.length).toBeGreaterThan(0);
    for (const p of expected) expect(PER_TENANT_HOSTS).toContain(p.label);
  });

  it("names Jira, whose host is per-tenant by definition", () => {
    expect(PER_TENANT_HOSTS).toContain("Jira");
  });

  it("does NOT name a provider whose base URL comes from the catalog", () => {
    // GitHub is always api.github.com — listing it would send users to type a host that is ignored.
    expect(PER_TENANT_HOSTS).not.toContain("GitHub");
  });
});
