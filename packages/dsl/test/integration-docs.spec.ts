import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { INTEGRATION_PROSE } from "../src/docs/integration-prose";
import {
  GENERATED_NOTICE,
  LIVE_VERIFIED,
  needsServerUrl,
  probeAction,
  renderIntegrationDoc,
} from "../src/docs/render";
import { INTEGRATION_PROVIDERS } from "../src/integrations";

/**
 * The setup guides in `docs/integrations/` are GENERATED from the catalog (see
 * `src/docs/render.ts`). This suite is what makes them trustworthy enough for the marketing site
 * to consume: it re-renders every provider and diffs against the committed file, so
 *
 *   - editing a generated section by hand fails here, and
 *   - changing the catalog without regenerating fails here.
 *
 * Motivation, not hypothetical: before the generator existed, `docs/integrations/github.md` listed
 * 4 of GitHub's 5 catalog actions. Prose and catalog drift silently, and a wrong setup guide costs a
 * user more time than a missing one.
 */
const REPO_ROOT = join(__dirname, "..", "..", "..");
const DOCS_DIR = join(REPO_ROOT, "docs", "integrations");
/** The committed page for a provider key. */
const pagePath = (key: string) => join(DOCS_DIR, `${key}.md`);

describe("integration setup guides are in sync with the catalog", () => {
  it.each(INTEGRATION_PROVIDERS.map((p) => [p.key, p] as const))(
    "%s.md matches the generator output",
    (key, provider) => {
      const path = join(DOCS_DIR, `${key}.md`);
      expect(
        existsSync(path),
        `docs/integrations/${key}.md is missing — run \`pnpm gen:integration-docs\``,
      ).toBe(true);
      const prose = INTEGRATION_PROSE[key];
      expect(prose, `no prose entry for '${key}'`).toBeDefined();
      const expected = renderIntegrationDoc(provider, prose, {
        liveVerified: LIVE_VERIFIED.has(key),
      });
      expect(
        readFileSync(path, "utf8"),
        `docs/integrations/${key}.md is stale or hand-edited — run \`pnpm gen:integration-docs\``,
      ).toBe(expected);
    },
  );

  /** Every provider must be documented: an undocumented integration is unusable in practice. */
  it("every catalog provider has a prose entry", () => {
    const missing = INTEGRATION_PROVIDERS.filter(
      (p) => !INTEGRATION_PROSE[p.key],
    ).map((p) => p.key);
    expect(missing).toEqual([]);
  });

  /** And no prose entry may outlive its provider (a page nothing links to, describing nothing). */
  it("has no prose entry without a catalog provider", () => {
    const keys = new Set(INTEGRATION_PROVIDERS.map((p) => p.key));
    expect(Object.keys(INTEGRATION_PROSE).filter((k) => !keys.has(k))).toEqual(
      [],
    );
  });
});

describe("what the guides claim is derived, not asserted", () => {
  /**
   * A probe action must be safe to call unattended: never a write, and never needing an argument
   * the user has to invent. If this ever passes something mutating, a "test your connection"
   * button would start changing customer data.
   */
  it("no probe action writes or requires a field", () => {
    for (const p of INTEGRATION_PROVIDERS) {
      const probe = probeAction(p);
      if (!probe) continue;
      expect(probe.write, `${p.key}.${probe.key} is a write`).toBe(false);
      expect(probe.method, `${p.key}.${probe.key} is not a GET`).toBe("GET");
      expect(
        probe.fields.filter((f) => f.required && f.const === undefined),
        `${p.key}.${probe.key} needs a user-supplied field`,
      ).toEqual([]);
    }
  });

  /**
   * A provider with NO read action at all can't be told to "choose a read action" — that sends
   * the reader looking for something the catalog doesn't have. Slack is the only one today; the
   * page must instead say to pick any action, and warn that the test really writes.
   */
  it("never tells an all-write provider to pick a read action", () => {
    const allWrite = INTEGRATION_PROVIDERS.filter(
      (p) =>
        (p.actions ?? []).length > 0 && (p.actions ?? []).every((a) => a.write),
    );
    expect(allWrite.map((p) => p.key)).toEqual(["slack"]);
    for (const p of allWrite) {
      const page = readFileSync(pagePath(p.key), "utf8");
      expect(
        page,
        `${p.key} names a read action it does not have`,
      ).not.toContain("choose a read action");
      expect(page, `${p.key} omits the real-write warning`).toContain(
        "performs a **real** action",
      );
    }
  });

  /** The generated notice must point at paths that EXIST, or it sends contributors nowhere. */
  it("the generated-file notice cites real source paths", () => {
    for (const rel of [
      "packages/dsl/src/integrations.ts",
      "packages/dsl/src/docs/integration-prose.ts",
      "packages/dsl/test/integration-docs.spec.ts",
    ]) {
      expect(GENERATED_NOTICE, `notice omits ${rel}`).toContain(rel);
      expect(
        existsSync(join(REPO_ROOT, rel)),
        `${rel} is cited by the notice but does not exist`,
      ).toBe(true);
    }
  });

  /**
   * Pins how much of the catalog can be checked WITHOUT the user supplying anything. Not a vanity
   * number — it is the honest ceiling on one-click verification, and it should move only
   * deliberately. A drop means someone made a read action mutating or added a required field to a
   * probe; a rise means a new argument-free read (good, update the list).
   */
  it("32 providers are one-click testable, 6 are not", () => {
    // 14/24 before #835, when the rule was "any incidentally argument-free read" and it missed
    // GitHub, Jira, Notion, GitLab and 14 others. The six that remain are named — each has a
    // catalog `unprobeableReason` saying why, which is what the user is shown.
    const testable = INTEGRATION_PROVIDERS.filter((p) => probeAction(p));
    expect(testable.map((p) => p.key).sort()).toEqual([
      "airtable",
      "asana",
      "box",
      "calendly",
      "clickup",
      "cloudflare",
      "deepl",
      "digitalocean",
      "discord",
      "front",
      "github",
      "gitlab",
      "hubspot",
      "intercom",
      "jira",
      "mailchimp",
      "mattermost",
      "netlify",
      "notion",
      "pagerduty",
      "pipedrive",
      "posthog",
      "sendgrid",
      "sentry",
      "shopify",
      "stripe",
      "todoist",
      "twilio",
      "vercel",
      "webflow",
      "zendesk",
      "zoom",
    ]);
    const unprobeable = INTEGRATION_PROVIDERS.filter((p) => !probeAction(p));
    expect(unprobeable.map((p) => p.key).sort()).toEqual([
      "dropbox",
      "googlesheets",
      "linear",
      "monday",
      "msgraph",
      "slack",
    ]);
    // …and every one of them says why, in the catalog, where the API and the docs both read it.
    for (const p of unprobeable) {
      expect(
        p.unprobeableReason,
        `${p.key} has no unprobeableReason`,
      ).toBeTruthy();
    }
  });

  /** The 6 Server-URL providers are the top setup failure; the guides must say so for exactly them. */
  it("exactly 6 providers require a Server URL", () => {
    expect(
      INTEGRATION_PROVIDERS.filter(needsServerUrl)
        .map((p) => p.key)
        .sort(),
    ).toEqual([
      "deepl",
      "jira",
      "mailchimp",
      "mattermost",
      "shopify",
      "zendesk",
    ]);
  });

  /**
   * `liveVerified` must never outrun the live suite. If someone adds a key here without a
   * `*.live.spec.ts` behind it, every downstream surface starts claiming proof we don't have.
   */
  it("liveVerified covers only providers with a live spec", () => {
    expect([...LIVE_VERIFIED].sort()).toEqual(["github"]);
  });

  /**
   * A provider whose credential prose says nothing about where to get the token is worse than no
   * page — it looks authoritative and answers nothing.
   */
  it("every prose entry has a tagline, a credential name and at least one step", () => {
    for (const [key, prose] of Object.entries(INTEGRATION_PROSE)) {
      expect(prose.tagline.length, `${key}: empty tagline`).toBeGreaterThan(10);
      expect(
        prose.credentialName.length,
        `${key}: empty credentialName`,
      ).toBeGreaterThan(2);
      expect(prose.steps.length, `${key}: no steps`).toBeGreaterThan(0);
      expect(prose.category.length, `${key}: no category`).toBeGreaterThan(2);
    }
  });

  /** Server-URL providers must document the FORMAT — "set a server URL" helps nobody. */
  it("every Server-URL provider documents its URL format", () => {
    for (const p of INTEGRATION_PROVIDERS.filter(needsServerUrl)) {
      expect(
        INTEGRATION_PROSE[p.key].serverUrl,
        `${p.key} needs a Server URL but its prose gives no format`,
      ).toBeTruthy();
    }
  });
});
