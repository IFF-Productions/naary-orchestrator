import { describe, expect, it } from "vitest";
import { INTEGRATION_PROVIDERS } from "../src";
import type { IntegrationProvider } from "../src";
import { INTEGRATION_PROSE } from "../src/docs/integration-prose";

/**
 * The guard on AUTHORED `credentialSetup` content (#1063).
 *
 * Setup help is worse than useless when it is wrong: a bad scope list sends someone to mint a
 * token that cannot do the job, and the failure surfaces later as a 403 on a run they thought was
 * configured. Two stores now describe the same act of getting a credential — the catalog's
 * `credentialSetup` (rendered in the Connect dialog) and `INTEGRATION_PROSE` (rendered into
 * `docs/integrations/<key>.md`, and provenance-checked against each provider's own documentation
 * on 2026-07-25). This suite is what keeps them honest while both exist: everything asserted here
 * is mechanically checkable, and every check catches the realistic failure, which is somebody
 * editing one store and not the other.
 *
 * The scope check is one-directional ON PURPOSE: the catalog's list must be a SUBSET of what the
 * prose names, so a narrower dialog list passes (GitHub ships `repo` while the prose also names
 * the fine-grained equivalent, which its steps explain in words). The direction that matters is
 * the other one — a scope in the dialog that nobody ever verified.
 *
 * Deliberately NOT asserted: that a provider HAS `credentialSetup`. It is a first slice; an
 * unauthored provider still gets a derived `tokenFormat`, and demanding content would just invite
 * someone to invent a console URL to make the suite pass — the exact outcome this file exists to
 * prevent.
 */

const authored = INTEGRATION_PROVIDERS.filter((p) => p.credentialSetup);

/** `www.` is a display prefix, not an identity — `notion.so` and `www.notion.so` are one host. */
const bareHost = (u: URL) => u.host.replace(/^www\./, "");
/** The registrable-ish root: `api.github.com` → `github.com`, so a console link on the
 *  provider's own domain is recognised as such. */
const rootDomain = (host: string) => host.split(".").slice(-2).join(".");

/** Everything the provider's prose says about getting the credential, as one haystack. */
const proseText = (p: IntegrationProvider) => {
  const prose = INTEGRATION_PROSE[p.key];
  return [prose?.steps.join(" "), prose?.scopes, prose?.credentialName]
    .filter(Boolean)
    .join(" ");
};

describe("authored credentialSetup is well-formed", () => {
  it("at least one provider is authored (a silent empty slice would pass everything below)", () => {
    expect(authored.length).toBeGreaterThan(0);
  });

  it.each(authored.map((p) => [p.key, p] as const))(
    "%s — tokenUrl is an absolute https URL",
    (_key, p) => {
      const url = p.credentialSetup?.tokenUrl;
      if (!url) return; // Unauthored on purpose — see the file header.
      expect(() => new URL(url)).not.toThrow();
      expect(new URL(url).protocol).toBe("https:");
      // A bare origin is almost never the page that mints a token; it is what someone writes
      // when they did not actually look.
      expect(new URL(url).pathname).not.toBe("/");
    },
  );

  it.each(authored.map((p) => [p.key, p] as const))(
    "%s — scopes and steps are non-empty, trimmed strings",
    (_key, p) => {
      const setup = p.credentialSetup!;
      for (const list of [setup.scopes, setup.steps]) {
        if (!list) continue;
        expect(list.length).toBeGreaterThan(0);
        for (const s of list) {
          expect(s).toBe(s.trim());
          expect(s.length).toBeGreaterThan(0);
        }
      }
      // 2–5 imperatives. Longer than that is a docs page, and `docs/integrations/<key>.md`
      // already is one.
      if (setup.steps) expect(setup.steps.length).toBeLessThanOrEqual(5);
    },
  );
});

describe("authored credentialSetup agrees with the provider's setup prose", () => {
  it.each(authored.map((p) => [p.key, p] as const))(
    "%s — has a prose entry to agree with",
    (key, _p) => {
      expect(
        INTEGRATION_PROSE[key],
        `no prose entry for '${key}'`,
      ).toBeDefined();
    },
  );

  it.each(authored.map((p) => [p.key, p] as const))(
    "%s — every scope appears in the prose scopes line",
    (key, p) => {
      const scopes = p.credentialSetup?.scopes;
      if (!scopes) return;
      const prose = INTEGRATION_PROSE[key]?.scopes ?? "";
      for (const scope of scopes) {
        expect(
          prose,
          `scope '${scope}' is in the catalog but not in INTEGRATION_PROSE.${key}.scopes — one of the two is wrong`,
        ).toContain(scope);
      }
    },
  );

  it.each(authored.map((p) => [p.key, p] as const))(
    "%s — tokenUrl points at the provider's own domain, or at a host its prose names",
    (key, p) => {
      const url = p.credentialSetup?.tokenUrl;
      if (!url) return;
      const host = bareHost(new URL(url));
      const apiHost = p.baseUrl ? new URL(p.baseUrl).host : "";
      const sameDomain =
        !!apiHost &&
        rootDomain(host) === rootDomain(bareHost(new URL(p.baseUrl!)));
      expect(
        sameDomain || proseText(p).includes(host),
        `${key}: '${host}' is neither ${apiHost || "the API host"}'s domain nor a host named in INTEGRATION_PROSE.${key} — check the link is real`,
      ).toBe(true);
    },
  );
});
