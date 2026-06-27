import { describe, expect, it } from "vitest";
import { bucketByDay } from "../src/lib/timeseries";

// Fixed "now" = 2026-06-27T12:00:00Z for deterministic buckets.
const NOW = Date.parse("2026-06-27T12:00:00.000Z");
const day = (d: string, h = 10) => `2026-06-${d}T${h}:00:00.000Z`;

describe("bucketByDay", () => {
  it("produces a continuous axis of `days` buckets ending today (UTC)", () => {
    const b = bucketByDay([], 7, NOW);
    expect(b).toHaveLength(7);
    expect(b[6].day).toBe("2026-06-27");
    expect(b[0].day).toBe("2026-06-21");
    expect(b.every((x) => x.value === 0)).toBe(true);
    expect(b[6].label).toBe("Jun 27");
  });

  it("counts items per day by default (value = 1 each)", () => {
    const b = bucketByDay(
      [{ at: day("27") }, { at: day("27", 11) }, { at: day("25") }],
      7,
      NOW,
    );
    expect(b.find((x) => x.day === "2026-06-27")?.value).toBe(2);
    expect(b.find((x) => x.day === "2026-06-25")?.value).toBe(1);
    expect(b.find((x) => x.day === "2026-06-24")?.value).toBe(0);
  });

  it("sums a numeric value (e.g. cost) when provided", () => {
    const b = bucketByDay(
      [
        { at: day("27"), value: 1.5 },
        { at: day("27", 13), value: 2.25 },
      ],
      3,
      NOW,
    );
    expect(b.find((x) => x.day === "2026-06-27")?.value).toBeCloseTo(3.75);
  });

  it("ignores items outside the window and invalid dates", () => {
    const b = bucketByDay(
      [{ at: "2026-01-01T00:00:00Z" }, { at: "not-a-date" }],
      5,
      NOW,
    );
    expect(b.reduce((s, x) => s + x.value, 0)).toBe(0);
  });
});
