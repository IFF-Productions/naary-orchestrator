/**
 * Per-application Sentry DSN resolution. Each app may report to its OWN Sentry project so
 * issues, alert rules and quotas are per-app; unset falls back to the shared SENTRY_DSN.
 *
 * The empty-string case is the one that matters operationally: docker-compose renders an
 * unset variable as `""` (`SENTRY_DSN_WORKER: ${SENTRY_DSN_WORKER:-}`), so a naive
 * `?? SENTRY_DSN` would hand Sentry.init an invalid DSN and silently disable reporting for
 * that app — the exact opposite of what setting up per-app projects is meant to achieve.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { componentDsnVar, sentryDsnFor } from "../src/index";

const VARS = [
  "SENTRY_DSN",
  "SENTRY_DSN_API",
  "SENTRY_DSN_WORKER",
  "SENTRY_DSN_SANDBOX_RUNNER",
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const v of VARS) {
    saved[v] = process.env[v];
    delete process.env[v];
  }
});
afterEach(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
});

describe("componentDsnVar", () => {
  // This mapping is a CONTRACT with docker-compose / deploy.yml / .env.prod.example — those
  // files hardcode the variable names, so a change here silently stops reading them.
  it("maps each component to its documented env var", () => {
    expect(componentDsnVar("api")).toBe("SENTRY_DSN_API");
    expect(componentDsnVar("worker")).toBe("SENTRY_DSN_WORKER");
    expect(componentDsnVar("sandbox-runner")).toBe("SENTRY_DSN_SANDBOX_RUNNER");
  });
});

describe("sentryDsnFor", () => {
  it("is undefined when nothing is configured (Sentry stays OFF)", () => {
    expect(sentryDsnFor("api")).toBeUndefined();
    expect(sentryDsnFor("worker")).toBeUndefined();
  });

  it("falls back to the shared DSN when the app has none of its own", () => {
    process.env.SENTRY_DSN = "https://shared@o0.ingest.sentry.io/1";
    expect(sentryDsnFor("api")).toBe("https://shared@o0.ingest.sentry.io/1");
    expect(sentryDsnFor("worker")).toBe("https://shared@o0.ingest.sentry.io/1");
  });

  it("prefers the app's own DSN over the shared one", () => {
    process.env.SENTRY_DSN = "https://shared@o0.ingest.sentry.io/1";
    process.env.SENTRY_DSN_WORKER = "https://wrk@o0.ingest.sentry.io/2";
    expect(sentryDsnFor("worker")).toBe("https://wrk@o0.ingest.sentry.io/2");
    // …without affecting the app that has no override.
    expect(sentryDsnFor("api")).toBe("https://shared@o0.ingest.sentry.io/1");
  });

  it("routes each app to a different project when both are set", () => {
    process.env.SENTRY_DSN_API = "https://api@o0.ingest.sentry.io/1";
    process.env.SENTRY_DSN_WORKER = "https://wrk@o0.ingest.sentry.io/2";
    expect(sentryDsnFor("api")).not.toBe(sentryDsnFor("worker"));
  });

  // docker-compose passes an unset var through as "". Treating that as "configured" would
  // disable reporting for the app entirely.
  it("treats an EMPTY per-app var as unset and still uses the shared DSN", () => {
    process.env.SENTRY_DSN = "https://shared@o0.ingest.sentry.io/1";
    process.env.SENTRY_DSN_WORKER = "";
    expect(sentryDsnFor("worker")).toBe("https://shared@o0.ingest.sentry.io/1");
  });

  it("treats an empty SHARED var as unset (Sentry OFF, not a broken DSN)", () => {
    process.env.SENTRY_DSN = "";
    expect(sentryDsnFor("api")).toBeUndefined();
  });

  it("trims surrounding whitespace from a pasted DSN", () => {
    process.env.SENTRY_DSN_API = "  https://api@o0.ingest.sentry.io/1  ";
    expect(sentryDsnFor("api")).toBe("https://api@o0.ingest.sentry.io/1");
  });

  it("treats a whitespace-only var as unset", () => {
    process.env.SENTRY_DSN = "   ";
    expect(sentryDsnFor("worker")).toBeUndefined();
  });
});
