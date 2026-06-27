/**
 * Pure time-bucketing for the dashboard charts. Buckets timestamped items into the
 * last `days` calendar days (UTC), summing a numeric value (default 1 = a count).
 * No date lib; unit-tested in test/timeseries.spec.ts. `now` is injectable so the
 * logic stays deterministic/testable.
 */
export interface Bucket {
  /** Day key YYYY-MM-DD (UTC). */
  day: string;
  /** Short label for the axis, e.g. "Jun 27". */
  label: string;
  value: number;
}

const MS_DAY = 86_400_000;
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
function label(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

export function bucketByDay(
  items: { at: string; value?: number }[],
  days: number,
  now: number,
): Bucket[] {
  const todayStart = Math.floor(now / MS_DAY) * MS_DAY;
  // Pre-seed every day in range with 0 so the chart has a continuous axis.
  const buckets: Bucket[] = [];
  const index = new Map<string, number>();
  for (let i = days - 1; i >= 0; i--) {
    const ms = todayStart - i * MS_DAY;
    const key = dayKey(ms);
    index.set(key, buckets.length);
    buckets.push({ day: key, label: label(ms), value: 0 });
  }
  for (const it of items) {
    const t = new Date(it.at).getTime();
    if (Number.isNaN(t)) continue;
    const key = dayKey(t);
    const at = index.get(key);
    if (at !== undefined) buckets[at].value += it.value ?? 1;
  }
  return buckets;
}
