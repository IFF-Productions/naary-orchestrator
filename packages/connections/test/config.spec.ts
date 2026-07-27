import { describe, expect, it } from "vitest";
import {
  atlassianScopes,
  githubAppPrivateKey,
  githubAppSlug,
  hasDatabase,
} from "../src/config";

/**
 * Slice 3 of docs/design/CONFIG-CENTRALIZATION.md moved these reads into a package-local
 * `config.ts`. Two of them carry real parsing that used to sit inline at the call site, so they
 * are pinned here — a transform that moves is a transform that can change.
 */
describe("platform app credentials", () => {
  /**
   * A PEM in a single-line env var arrives with its newlines as the two characters `\` and `n`.
   * `createPrivateKey` rejects that, so the un-escape is load-bearing: getting it wrong doesn't
   * misparse anything, it turns the whole GitHub App integration off.
   */
  it("un-escapes a single-line PEM, and leaves a real multi-line one alone", () => {
    const escaped = "-----BEGIN KEY-----\\nabc\\ndef\\n-----END KEY-----";
    expect(githubAppPrivateKey({ GITHUB_APP_PRIVATE_KEY: escaped })).toBe(
      "-----BEGIN KEY-----\nabc\ndef\n-----END KEY-----",
    );
    const real = "-----BEGIN KEY-----\nabc\n-----END KEY-----";
    expect(githubAppPrivateKey({ GITHUB_APP_PRIVATE_KEY: real })).toBe(real);
    expect(githubAppPrivateKey({})).toBe(undefined);
  });

  it("treats an empty slug as absent — it gates the install flow", () => {
    expect(githubAppSlug({ GITHUB_APP_SLUG: "" })).toBe(undefined);
    expect(githubAppSlug({ GITHUB_APP_SLUG: "naary" })).toBe("naary");
  });

  /** Both forms get pasted straight out of Atlassian's console. */
  it("accepts Atlassian scopes comma- OR space-separated", () => {
    expect(
      atlassianScopes({ ATLASSIAN_OAUTH_SCOPES: "read:jira, write:jira" }),
    ).toEqual(["read:jira", "write:jira"]);
    expect(
      atlassianScopes({ ATLASSIAN_OAUTH_SCOPES: "read:jira write:jira" }),
    ).toEqual(["read:jira", "write:jira"]);
  });

  /** Empty ⇒ the caller substitutes DEFAULT_SCOPES; the accessor must not invent them itself,
   *  or "configured but empty" and "unset" would stop being distinguishable. */
  it("returns an empty list when unset, rather than defaults", () => {
    expect(atlassianScopes({})).toEqual([]);
    expect(atlassianScopes({ ATLASSIAN_OAUTH_SCOPES: "   " })).toEqual([]);
  });

  /**
   * Only the PRESENCE of a database is exposed. The connection string belongs to @naary/db —
   * this package needs to know whether OAuth refresh can take a cross-process advisory lock or
   * must fall back to in-process locking, and nothing more.
   */
  it("exposes whether a DB exists, not the URL", () => {
    expect(hasDatabase({ DATABASE_URL: "postgres://x" })).toBe(true);
    expect(hasDatabase({})).toBe(false);
    expect(hasDatabase({ DATABASE_URL: "" })).toBe(false);
  });
});
