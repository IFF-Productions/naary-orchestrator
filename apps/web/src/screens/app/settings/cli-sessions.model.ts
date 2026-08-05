// Pure view-model helpers for the CLI sessions section (#1078 §5). Separated from the component
// so the two decisions that actually carry meaning on that screen — how "last used" reads, and
// what an unlabelled device is called — are testable without a DOM.
import type { CliSession } from "../../../lib/api";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "3 hours ago" — the form that lets someone recognise a session they don't remember starting.
 *
 * Past a week it falls back to an absolute date, because "23 days ago" is no easier to place than
 * the date itself. A future timestamp (a clock skew between server and browser) reads as "just
 * now" rather than "in -2 minutes"; it is a display string, and the server is the only clock that
 * decides anything.
 */
export function ago(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown";
  const delta = now - then;
  // FLOOR, not round, at every unit. Rounding reads UP across the boundary the next branch was
  // written for: 59.7 minutes is `< HOUR`, so `Math.round` produced "60 minutes ago" instead of
  // handing over to "an hour ago", and 6.7 days produced "7 days ago" instead of the absolute date.
  // Flooring makes each unit hand over exactly where its guard says it does.
  if (delta < 2 * MINUTE) return "just now";
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)} minutes ago`;
  if (delta < DAY) {
    const h = Math.floor(delta / HOUR);
    return h === 1 ? "an hour ago" : `${h} hours ago`;
  }
  if (delta < 7 * DAY) {
    const d = Math.floor(delta / DAY);
    return d === 1 ? "yesterday" : `${d} days ago`;
  }
  return new Date(then).toLocaleDateString();
}

/** Absolute instant for a row's `title` — the relative form is for scanning, this is for being
 *  sure. It never replaces it: "05/08/2026, 14:03" is not what you read a list with. */
export function exact(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t).toLocaleString();
}

/** The device name, or an honest placeholder. Sessions minted before the label column existed
 *  have none, and inventing a machine name on a security screen would be worse than the gap. */
export function deviceName(session: Pick<CliSession, "label">): string {
  return session.label?.trim() || "Unknown device";
}
