import { describe, expect, it } from "vitest";
import { nameEventRejection } from "../src/lib/sentry-rejections";

/**
 * #793 arrived from Sentry as `Event `Event` (type=error) captured as promise rejection` — no
 * message, no stack, no target. Unactionable, and every occurrence collapsed into ONE issue
 * regardless of which resource actually failed. `beforeSend` still holds the original object, so
 * these tests pin that the target survives into the report.
 */

/** A Sentry event as the SDK builds it for a non-Error rejection. */
const sentryEvent = () => ({
  exception: {
    values: [
      {
        type: "Event",
        value: "Event `Event` (type=error) captured as promise rejection",
      },
    ],
  },
});

/** A DOM error event, structurally — the shape `el.onerror = reject` rejects with. */
const errorEvent = (target: unknown) => ({
  type: "error",
  target,
  isTrusted: true,
});

describe("nameEventRejection", () => {
  it("names the script that failed to load", () => {
    const out = nameEventRejection(
      sentryEvent(),
      errorEvent({
        tagName: "SCRIPT",
        src: "https://static.cloudflareinsights.com/beacon.min.js",
      }),
    );
    expect(out.exception.values[0].value).toBe(
      'Unhandled rejection: "error" event from SCRIPT https://static.cloudflareinsights.com/beacon.min.js',
    );
    // Retitled so Sentry stops grouping every DOM-event rejection into one issue.
    expect(out.exception.values[0].type).toBe("UnhandledRejection");
    expect(out.tags).toMatchObject({ rejection_kind: "dom_event" });
  });

  it("uses href for a stylesheet, and falls back to the tag alone", () => {
    expect(
      nameEventRejection(
        sentryEvent(),
        errorEvent({ tagName: "LINK", href: "https://cdn.example/app.css" }),
      ).exception.values[0].value,
    ).toContain("LINK https://cdn.example/app.css");
    expect(
      nameEventRejection(sentryEvent(), errorEvent({ tagName: "IMG" }))
        .exception.values[0].value,
    ).toContain("from IMG");
  });

  /**
   * A resource URL has no business carrying a token into a report. `safeScrub` runs over the
   * finished event and would catch a secret-shaped param anyway, but the origin+path is the part
   * that identifies the resource — so the query is dropped before it can be seen at all.
   */
  it("drops the query string from the URL", () => {
    const value = nameEventRejection(
      sentryEvent(),
      errorEvent({
        tagName: "SCRIPT",
        src: "https://x.test/a.js?token=super-secret&v=2",
      }),
    ).exception.values[0].value;
    expect(value).toContain("https://x.test/a.js");
    expect(value).not.toContain("super-secret");
    expect(value).not.toContain("?");
  });

  /** A detached event has target === null. That must still be named, not fall through unchanged —
   *  "a DOM Event with no target" is itself the useful finding. */
  it("handles an event whose target is null", () => {
    const value = nameEventRejection(sentryEvent(), errorEvent(null)).exception
      .values[0].value;
    expect(value).toContain("no target");
    expect(value).toContain('"error"');
  });

  it("leaves a real Error rejection completely alone", () => {
    const original = sentryEvent();
    const out = nameEventRejection(original, new Error("boom"));
    expect(out).toBe(original);
    expect(out.exception.values[0].type).toBe("Event");
    expect(out.tags).toBeUndefined();
  });

  /** Runs on the crash path: throwing here would lose the report entirely. */
  it("never throws on junk", () => {
    for (const junk of [
      undefined,
      null,
      "string",
      42,
      {},
      { type: 42 },
      { type: "error" }, // no target key at all ⇒ not an event
      [],
    ]) {
      expect(() => nameEventRejection(sentryEvent(), junk)).not.toThrow();
    }
    // An event-shaped reason with an unusable target still must not throw.
    expect(() =>
      nameEventRejection(sentryEvent(), errorEvent("not-an-element")),
    ).not.toThrow();
  });

  it("tolerates a Sentry event with no exception values", () => {
    const bare = {} as Parameters<typeof nameEventRejection>[0];
    expect(() =>
      nameEventRejection(bare, errorEvent({ tagName: "SCRIPT" })),
    ).not.toThrow();
    expect(nameEventRejection(bare, errorEvent({ tagName: "SCRIPT" }))).toBe(
      bare,
    );
  });
});
