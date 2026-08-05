import { describe, expect, it } from "vitest";
import {
  ago,
  deviceName,
  exact,
} from "../src/screens/app/settings/cli-sessions.model";

/**
 * The CLI sessions list (#1078 §5) is a security screen, so the two strings it leans on have to be
 * right: "last used", which is how someone recognises a session they don't remember starting, and
 * the device name, which is what they'd revoke by.
 */

const NOW = Date.parse("2026-08-05T12:00:00Z");
const before = (ms: number) => new Date(NOW - ms).toISOString();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("ago", () => {
  it("reads as recency near the present", () => {
    expect(ago(before(5_000), NOW)).toBe("just now");
    expect(ago(before(20 * MINUTE), NOW)).toBe("20 minutes ago");
    expect(ago(before(HOUR), NOW)).toBe("an hour ago");
    expect(ago(before(5 * HOUR), NOW)).toBe("5 hours ago");
    expect(ago(before(DAY), NOW)).toBe("yesterday");
    expect(ago(before(4 * DAY), NOW)).toBe("4 days ago");
  });

  it("switches to an absolute date past a week", () => {
    // "23 days ago" is no easier to place than the date, and the 30-day idle window means a row
    // can legitimately be three weeks old.
    const out = ago(before(23 * DAY), NOW);
    expect(out).not.toContain("ago");
    expect(out).toBe(new Date(NOW - 23 * DAY).toLocaleDateString());
  });

  it("does not render a negative age when the browser clock is behind the server", () => {
    // Clock skew is display-only here — the server is the only clock that decides anything — but
    // "in -2 minutes" on a security screen reads as a bug in the session, not in the laptop.
    expect(ago(new Date(NOW + 90_000).toISOString(), NOW)).toBe("just now");
  });

  it("degrades on an unparseable timestamp instead of printing NaN", () => {
    expect(ago("not-a-date", NOW)).toBe("unknown");
    expect(exact("not-a-date")).toBe("not-a-date");
  });
});

describe("deviceName", () => {
  it("uses the label the login handshake recorded", () => {
    expect(deviceName({ label: "naary CLI — hassans-macbook" })).toBe(
      "naary CLI — hassans-macbook",
    );
  });

  it("says Unknown device rather than inventing one", () => {
    // Sessions predating the label column, and the whitespace-only case. A fabricated machine
    // name on a screen whose job is "do you recognise this?" would be worse than the gap.
    expect(deviceName({ label: null })).toBe("Unknown device");
    expect(deviceName({ label: "   " })).toBe("Unknown device");
  });
});
