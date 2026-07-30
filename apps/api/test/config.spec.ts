import { describe, expect, it } from "vitest";
import {
  accessAllowedEmails,
  appBaseUrlCandidates,
  atlassianOauthRedirectUri,
  browserCorsOrigins,
  corsOrigins,
  encryptionKey,
  firebaseTenantClaim,
  mailFrom,
  oauthRedirectUri,
  platformOperators,
  port,
  requireMfa,
  resumeSnapshotsEnabled,
  ssoSelfService,
  swaggerDisabled,
} from "../src/config";

/**
 * Slice 1 of docs/design/CONFIG-CENTRALIZATION.md moved 48 inline `process.env` reads behind these
 * accessors. A sweep that wide can hide a changed default in the noise, so the defaults are pinned
 * here — every one of them is a decision (fail-open vs fail-closed, dev convenience vs production
 * safety), not an implementation detail.
 *
 * Every accessor takes an injectable env, so none of this mutates `process.env`.
 */
describe("defaults that are security decisions", () => {
  /** Unset ⇒ NOBODY. A posture that depends on remembering to set a var isn't one. */
  it("PLATFORM_OPERATORS fails CLOSED", () => {
    expect(platformOperators({})).toEqual([]);
    expect(platformOperators({ PLATFORM_OPERATORS: "  " })).toEqual([]);
    expect(
      platformOperators({ PLATFORM_OPERATORS: "Sam@Acme.io, b@c.d" }),
    ).toEqual(["sam@acme.io", "b@c.d"]);
  });

  /** Unset ⇒ OPEN. This gates a private beta; defaulting closed would lock every self-hosted user out. */
  it("ACCESS_ALLOWED_EMAILS fails OPEN — the opposite of PLATFORM_OPERATORS, on purpose", () => {
    expect(accessAllowedEmails({})).toBe(null);
    expect(accessAllowedEmails({ ACCESS_ALLOWED_EMAILS: "" })).toBe(null);
    expect(accessAllowedEmails({ ACCESS_ALLOWED_EMAILS: "A@b.c" })).toEqual(
      new Set(["a@b.c"]),
    );
  });

  it("REQUIRE_MFA and SSO_SELF_SERVICE need an explicit truthy value", () => {
    for (const on of ["1", "true", "TRUE", " yes ", "on"]) {
      expect(requireMfa({ REQUIRE_MFA: on })).toBe(true);
      expect(ssoSelfService({ SSO_SELF_SERVICE: on })).toBe(true);
    }
    // A typo must fail closed, not enable an instance-wide auth policy.
    for (const off of [undefined, "", "0", "false", "no", "maybe", "  "]) {
      expect(requireMfa({ REQUIRE_MFA: off })).toBe(false);
      expect(ssoSelfService({ SSO_SELF_SERVICE: off })).toBe(false);
    }
  });

  // `subprocessBaseEnv` was tested here until #680. It built the allowlisted env for the graph
  // generator's `claude` subprocess; the api spawns no CLI any more, so the helper is gone. The
  // successor invariant — the api sends the runner ONLY run data, never its own environment — is
  // asserted in graph-generator.service.spec.ts ("sends the runner ONLY run data").

  /** Not stored, not defaulted, not logged — just read. Pinned so a default is never introduced. */
  it("ENCRYPTION_KEY has no fallback value", () => {
    expect(encryptionKey({})).toBe(undefined);
  });
});

/**
 * CORS_ORIGINS feeds two things with DIFFERENT correct defaults, which is the single trap in this
 * refactor: browser CORS wants a dev fallback, while deriving a public base URL from that same
 * fallback would hand production a localhost link (in emails and Slack buttons, no less).
 */
describe("CORS_ORIGINS: two readers, two defaults", () => {
  it("browser CORS falls back to the Vite dev server", () => {
    expect(browserCorsOrigins({})).toEqual(["http://localhost:5173"]);
    expect(
      browserCorsOrigins({ CORS_ORIGINS: "https://a.io, https://b.io" }),
    ).toEqual(["https://a.io", "https://b.io"]);
  });

  it("the configured list does NOT invent a localhost entry", () => {
    expect(corsOrigins({})).toEqual([]);
  });

  /** UNSET means "dev default"; EMPTY means "no origins". Collapsing the two would silently
   *  re-admit localhost to a deployment that had deliberately allowed nothing. */
  it("an explicitly empty CORS_ORIGINS stays empty", () => {
    expect(browserCorsOrigins({ CORS_ORIGINS: "" })).toEqual([]);
    expect(browserCorsOrigins({ CORS_ORIGINS: "  ,  " })).toEqual([]);
  });

  it("base-URL candidates are APP_BASE_URL first, then CORS origins, with no dev default", () => {
    expect(
      appBaseUrlCandidates({
        APP_BASE_URL: "https://app.example",
        CORS_ORIGINS: "https://a.io,https://b.io",
      }),
    ).toEqual(["https://app.example", "https://a.io", "https://b.io"]);
    // Unset ⇒ only an empty candidate ⇒ callers fall through to a relative, same-origin redirect.
    expect(appBaseUrlCandidates({}).filter(Boolean)).toEqual([]);
  });
});

describe("ordinary defaults", () => {
  it("PORT is 3000, and the OAuth redirect URIs follow it", () => {
    expect(port({})).toBe(3000);
    expect(port({ PORT: "8080" })).toBe(8080);
    expect(oauthRedirectUri({})).toBe("http://localhost:3000/oauth/callback");
    expect(atlassianOauthRedirectUri({ PORT: "4000" })).toBe(
      "http://localhost:4000/atlassian/oauth/callback",
    );
    // An explicit value wins — it has to match what was registered with the provider.
    expect(oauthRedirectUri({ OAUTH_REDIRECT_URI: "https://x/cb" })).toBe(
      "https://x/cb",
    );
    // BLANK is unset, not "the redirect URI is the empty string". compose now declares both
    // vars (so an operator can actually set them), and an unset compose var interpolates to "" —
    // under the previous `??` that empty string would have become the redirect URI itself.
    expect(oauthRedirectUri({ OAUTH_REDIRECT_URI: "" })).toBe(
      "http://localhost:3000/oauth/callback",
    );
    expect(
      atlassianOauthRedirectUri({ ATLASSIAN_OAUTH_REDIRECT_URI: "  " }),
    ).toBe("http://localhost:3000/atlassian/oauth/callback");
  });

  it("Swagger is on unless SWAGGER_DISABLED is exactly 1", () => {
    expect(swaggerDisabled({})).toBe(false);
    expect(swaggerDisabled({ SWAGGER_DISABLED: "true" })).toBe(false);
    expect(swaggerDisabled({ SWAGGER_DISABLED: "1" })).toBe(true);
  });

  /** ON by default: a snapshot taken only when someone opted in wouldn't exist for the failure
   *  it's meant to recover from. */
  it("resume snapshots default ON and take an explicit off", () => {
    expect(resumeSnapshotsEnabled({})).toBe(true);
    expect(resumeSnapshotsEnabled({ RESUME_SNAPSHOTS: "OFF" })).toBe(false);
    expect(resumeSnapshotsEnabled({ RESUME_SNAPSHOTS: "on" })).toBe(true);
  });

  it("the mail From default is undeliverable, so a misconfigured install can't look real", () => {
    expect(mailFrom({})).toBe("Naary <no-reply@naary.local>");
    expect(mailFrom({ MAIL_FROM: "  a@b.c " })).toBe("a@b.c");
  });

  it("the Firebase tenant claim defaults to what set-tenant-claim.ts writes", () => {
    expect(firebaseTenantClaim({})).toBe("tenant");
  });
});
