import { describe, expect, it } from "vitest";
import {
  isPlatformOperator,
  platformOperatorEmails,
} from "../src/auth/platform-operators";
import type { Principal } from "../src/auth/tenant.decorator";

/**
 * PLATFORM OPERATOR — whoever runs the deployment, as distinct from whoever owns a workspace in it.
 *
 * `WorkersController` previously gated the fleet view on `principal.role === "owner" | "admin"`, which
 * is the caller's role in their OWN workspace. In self-serve SaaS everyone who signs up owns one, so
 * that admitted every customer to the whole global fleet — hostnames, PIDs, worker versions and live
 * slot counts, from which the platform's size and load are readable.
 *
 * The behaviour that matters most below is FAIL CLOSED: unset ⇒ nobody.
 */
const user = (email?: string, role = "owner"): Principal =>
  ({ tenantId: "t-1", role, ...(email ? { email } : {}) }) as Principal;

const env = (v?: string): NodeJS.ProcessEnv =>
  (v === undefined ? {} : { PLATFORM_OPERATORS: v }) as NodeJS.ProcessEnv;

describe("platformOperatorEmails", () => {
  it("parses a comma-separated list", () => {
    expect(platformOperatorEmails(env("a@x.io,b@x.io"))).toEqual([
      "a@x.io",
      "b@x.io",
    ]);
  });

  it("trims whitespace and lowercases", () => {
    expect(platformOperatorEmails(env(" Sam@Acme.IO , b@x.io "))).toEqual([
      "sam@acme.io",
      "b@x.io",
    ]);
  });

  it("drops empty entries from sloppy config", () => {
    expect(platformOperatorEmails(env("a@x.io,,  ,b@x.io,"))).toEqual([
      "a@x.io",
      "b@x.io",
    ]);
  });

  it.each([undefined, "", "   ", ","])("is empty for %s", (v) => {
    expect(platformOperatorEmails(env(v))).toEqual([]);
  });
});

describe("isPlatformOperator FAILS CLOSED", () => {
  /**
   * The headline property. A security posture that depends on remembering to set an env var isn't one,
   * so with nothing configured NOBODY qualifies — including a workspace owner, who used to pass.
   */
  it("is false for everyone when PLATFORM_OPERATORS is unset", () => {
    expect(isPlatformOperator(user("sam@acme.io"), env())).toBe(false);
    expect(isPlatformOperator(user("sam@acme.io", "admin"), env())).toBe(false);
  });

  it("is false when the list is present but empty", () => {
    expect(isPlatformOperator(user("sam@acme.io"), env("  "))).toBe(false);
  });

  it("is false for an absent principal", () => {
    expect(isPlatformOperator(undefined, env("sam@acme.io"))).toBe(false);
  });
});

describe("isPlatformOperator matching", () => {
  it("admits a listed email", () => {
    expect(isPlatformOperator(user("sam@acme.io"), env("sam@acme.io"))).toBe(
      true,
    );
  });

  it("is case-insensitive on both sides", () => {
    expect(isPlatformOperator(user("Sam@Acme.IO"), env("sam@acme.io"))).toBe(
      true,
    );
    expect(isPlatformOperator(user("sam@acme.io"), env("SAM@ACME.IO"))).toBe(
      true,
    );
  });

  it("tolerates whitespace around the configured value", () => {
    expect(isPlatformOperator(user("sam@acme.io"), env(" sam@acme.io "))).toBe(
      true,
    );
  });

  it("rejects an unlisted email", () => {
    expect(
      isPlatformOperator(user("someone@else.io"), env("sam@acme.io")),
    ).toBe(false);
  });

  /** No prefix/substring matching — `sam@acme.io.evil.com` must not pass on a shared prefix. */
  it("requires a full match, not a prefix", () => {
    expect(
      isPlatformOperator(user("sam@acme.io.evil.com"), env("sam@acme.io")),
    ).toBe(false);
    expect(isPlatformOperator(user("am@acme.io"), env("sam@acme.io"))).toBe(
      false,
    );
  });

  /**
   * API tokens carry no email, so a token can never be an operator. Correct: infra telemetry is not
   * something a workflow's automation credential should read, and tokens are stamped `owner` in a
   * workspace with no grants — exactly the role the old check trusted.
   */
  it("is false for an API-token principal (no email), even stamped owner", () => {
    expect(
      isPlatformOperator(user(undefined, "owner"), env("sam@acme.io")),
    ).toBe(false);
  });

  it("ignores workspace role entirely", () => {
    // A plain member who IS a listed operator qualifies; an owner who isn't listed doesn't.
    expect(
      isPlatformOperator(user("sam@acme.io", "member"), env("sam@acme.io")),
    ).toBe(true);
    expect(
      isPlatformOperator(user("owner@acme.io", "owner"), env("sam@acme.io")),
    ).toBe(false);
  });
});
