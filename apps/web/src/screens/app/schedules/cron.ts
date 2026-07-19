/**
 * Tiny cron helpers for the Schedules screen — no deps.
 *
 * Scope: standard 5-field cron (minute hour day-of-month month day-of-week) with
 * `*`, lists, ranges, steps, and 3-letter month/day names — the shapes our presets
 * and Temporal accept. Evaluated in **UTC**, because the API registers the cron on
 * a Temporal Schedule spec without a timezone (Temporal defaults cron to UTC).
 *
 * `nextFire` is the client-side FALLBACK for "next fire" — the authoritative value
 * is `ScheduleRow.nextRunAt` (from Temporal); we only compute when that's null.
 */

interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  dom: Set<number>;
  months: Set<number>;
  dow: Set<number>;
  /** Whether dom/dow were written as `*` — needed for vixie OR-semantics. */
  domStar: boolean;
  dowStar: boolean;
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};
const DAY_NAMES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

function parseAtom(
  atom: string,
  names: Record<string, number> | null,
): number | null {
  if (/^\d+$/.test(atom)) return Number(atom);
  const named = names?.[atom.toLowerCase()];
  return named === undefined ? null : named;
}

// One cron field ("*", "*/15", "1-5", "0,30", "mon-fri", "3/2") → the allowed set.
function parseField(
  spec: string,
  min: number,
  max: number,
  names: Record<string, number> | null,
): Set<number> | null {
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const [rangePart, stepPart, extra] = part.split("/");
    if (extra !== undefined || rangePart === "") return null;
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) return null;
    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = min;
      hi = max;
    } else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-");
      const pa = parseAtom(a, names);
      const pb = parseAtom(b, names);
      if (pa === null || pb === null) return null;
      lo = pa;
      hi = pb;
    } else {
      const v = parseAtom(rangePart, names);
      if (v === null) return null;
      lo = v;
      // Bare value with a step ("3/2") means "from 3 to max"; without, just the value.
      hi = stepPart === undefined ? v : max;
    }
    if (lo < min || hi > max || lo > hi) {
      // Allow dow "7" as an alias for Sunday before rejecting.
      if (!(max === 6 && hi === 7)) return null;
    }
    for (let v = lo; v <= hi; v += step) out.add(max === 6 && v === 7 ? 0 : v);
  }
  return out.size > 0 ? out : null;
}

/** Parse a 5-field cron; null if it isn't one we understand. */
export function parseCron(expr: string): CronFields | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minutes = parseField(fields[0], 0, 59, null);
  const hours = parseField(fields[1], 0, 23, null);
  const dom = parseField(fields[2], 1, 31, null);
  const months = parseField(fields[3], 1, 12, MONTH_NAMES);
  const dow = parseField(fields[4], 0, 6, DAY_NAMES);
  if (!minutes || !hours || !dom || !months || !dow) return null;
  return {
    minutes,
    hours,
    dom,
    months,
    dow,
    domStar: fields[2] === "*",
    dowStar: fields[4] === "*",
  };
}

/**
 * The next UTC instant strictly after `from` matching the cron, or null if the
 * expression doesn't parse / doesn't fire within ~2 years (e.g. Feb 30).
 * Vixie semantics: when BOTH dom and dow are restricted, a day matches if EITHER does.
 */
export function nextFire(expr: string, from: Date = new Date()): Date | null {
  const f = parseCron(expr);
  if (!f) return null;
  // First candidate minute: the minute after `from`, seconds zeroed.
  const start = new Date(from.getTime());
  start.setUTCSeconds(0, 0);
  start.setUTCMinutes(start.getUTCMinutes() + 1);

  const hourList = [...f.hours].sort((a, b) => a - b);
  const minuteList = [...f.minutes].sort((a, b) => a - b);

  for (let dayOffset = 0; dayOffset < 366 * 2; dayOffset++) {
    const day = new Date(
      Date.UTC(
        start.getUTCFullYear(),
        start.getUTCMonth(),
        start.getUTCDate() + dayOffset,
      ),
    );
    if (!f.months.has(day.getUTCMonth() + 1)) continue;
    const domOk = f.dom.has(day.getUTCDate());
    const dowOk = f.dow.has(day.getUTCDay());
    const dayOk =
      f.domStar && f.dowStar
        ? true
        : f.domStar
          ? dowOk
          : f.dowStar
            ? domOk
            : domOk || dowOk; // both restricted → OR (vixie cron)
    if (!dayOk) continue;

    const sameDay = dayOffset === 0;
    for (const h of hourList) {
      if (sameDay && h < start.getUTCHours()) continue;
      for (const m of minuteList) {
        if (sameDay && h === start.getUTCHours() && m < start.getUTCMinutes())
          continue;
        return new Date(
          Date.UTC(
            day.getUTCFullYear(),
            day.getUTCMonth(),
            day.getUTCDate(),
            h,
            m,
          ),
        );
      }
    }
  }
  return null;
}

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function hhmm(h: number, m: number): string {
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

/**
 * Human cadence for the common cron shapes ("Daily · 06:00", "Hourly", "Every 30 min",
 * "Weekdays · 10:00", "Weekly · Mon 09:00", "Monthly · 1st 09:00"). Times are the cron's
 * own clock — UTC on our schedules. Falls back to "Custom" for anything exotic.
 */
export function humanizeCron(expr: string): string {
  const t = expr.trim().split(/\s+/);
  if (t.length !== 5 || !parseCron(expr)) return "Custom";
  const [min, hour, dom, mon, dow] = t;
  const numeric = (s: string) => /^\d+$/.test(s);

  // Sub-hourly: */N in the minute field.
  if (hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    if (min === "*") return "Every minute";
    const step = /^\*\/(\d+)$/.exec(min);
    if (step) return `Every ${step[1]} min`;
    if (numeric(min))
      return Number(min) === 0 ? "Hourly" : `Hourly · :${min.padStart(2, "0")}`;
  }
  if (!numeric(min) || !numeric(hour)) return "Custom";
  const at = hhmm(Number(hour), Number(min));

  if (dom === "*" && mon === "*") {
    if (dow === "*") return `Daily · ${at}`;
    if (dow === "1-5") return `Weekdays · ${at}`;
    if (dow === "0,6" || dow === "6,0") return `Weekends · ${at}`;
    if (numeric(dow)) {
      const d = Number(dow) === 7 ? 0 : Number(dow);
      if (d <= 6) return `Weekly · ${DAY_LABELS[d]} ${at}`;
    }
  }
  if (dow === "*" && mon === "*" && numeric(dom))
    return `Monthly · ${ordinal(Number(dom))} ${at}`;
  return "Custom";
}

/** "in 38m" / "in 4h 12m" / "in 3d 2h" / "in <1m". `null` when the fire time has passed. */
export function countdown(to: Date, now: Date = new Date()): string | null {
  const ms = to.getTime() - now.getTime();
  if (ms < 0) return null;
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return "in <1m";
  if (mins < 60) return `in ${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 24) {
    const rem = mins % 60;
    return rem === 0 ? `in ${h}h` : `in ${h}h ${rem}m`;
  }
  const d = Math.floor(h / 24);
  const remH = h % 24;
  return remH === 0 ? `in ${d}d` : `in ${d}d ${remH}h`;
}

/** Absolute fire time in the viewer's local zone: "Today 15:00" / "Tomorrow 06:00" / "Mon 09:00" / "Aug 3 · 09:00". */
export function absolute(to: Date, now: Date = new Date()): string {
  const time = to.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const startOfDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(to) - startOfDay(now)) / 86_400_000);
  if (dayDiff === 0) return `Today ${time}`;
  if (dayDiff === 1) return `Tomorrow ${time}`;
  if (dayDiff > 1 && dayDiff < 7) return `${DAY_LABELS[to.getDay()]} ${time}`;
  return `${to.toLocaleDateString(undefined, { month: "short", day: "numeric" })} · ${time}`;
}

/** Compact relative age: "22m ago" / "20h ago" / "5d ago". */
export function ago(iso: string, now: Date = new Date()): string {
  const s = Math.max(
    0,
    Math.round((now.getTime() - new Date(iso).getTime()) / 1000),
  );
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
