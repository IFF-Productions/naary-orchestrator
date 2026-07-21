import type { CompanyUsage } from "../../../lib/api";

/** Initials for a workspace/company mark — first letters of up to two words. */
export function initialsOf(label: string): string {
  const parts = label.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

/** Format the rollup window (usage.range) as a human billing period. */
export function billingPeriod(range: CompanyUsage["range"]): string {
  if (!range.from || !range.to) return "this month";
  const fmt = (s: string) =>
    // Pin to UTC: range.from/to are date-only ISO strings, which would otherwise
    // render off-by-one in timezones behind UTC.
    new Date(s).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  return `${fmt(range.from)} – ${fmt(range.to)}`;
}

/** Threshold color for a budget ratio: red > 85%, warn amber > 70%, else success green. */
export function budgetColor(pct: number): string {
  if (pct > 85) return "var(--state-error)";
  if (pct > 70) return "var(--state-paused)";
  return "var(--state-done)";
}
