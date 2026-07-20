import { describe, expect, it } from "vitest";
import { slaInfo, waitingInfo } from "../src/screens/app/approvals/urgency";

const NOW = Date.parse("2026-07-19T12:00:00Z");
const iso = (offsetMin: number) =>
  new Date(NOW + offsetMin * 60_000).toISOString();

describe("slaInfo (Slice 1 — real due-by tones)", () => {
  it("falls back to waiting-age urgency when the gate has no dueAt", () => {
    const info = slaInfo(iso(-5 * 60), null, NOW);
    expect(info).toEqual(waitingInfo(iso(-5 * 60), NOW));
    expect(info.tone).toBe("warn"); // 5h waited → age warn band
    expect(info.label).toBe("waiting 5h");
  });

  it("ignores an unparseable dueAt (fallback, never NaN chips)", () => {
    const info = slaInfo(iso(-30), "not-a-date", NOW);
    expect(info.label).toBe("waiting 30m");
  });

  it("neutral 'due Nd' while the deadline is comfortably ahead", () => {
    const info = slaInfo(iso(-60), iso(2 * 24 * 60), NOW);
    expect(info.tone).toBe("neutral");
    expect(info.label).toBe("due 2d");
  });

  it("warn 'due 2h' inside the 4h warn window", () => {
    const info = slaInfo(iso(-46 * 60), iso(2 * 60), NOW);
    expect(info.tone).toBe("warn");
    expect(info.label).toBe("due 2h");
    expect(info.banner).toContain("needs a decision soon");
  });

  it("bad 'breached 3h' once past the deadline", () => {
    const info = slaInfo(iso(-27 * 60), iso(-3 * 60), NOW);
    expect(info.tone).toBe("bad");
    expect(info.label).toBe("breached 3h");
    expect(info.banner).toContain("overdue");
  });

  it("keeps the waited minutes (recent/overdue filters still work)", () => {
    const info = slaInfo(iso(-90), iso(10 * 60), NOW);
    expect(info.minutes).toBe(90);
  });
});
