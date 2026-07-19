/**
 * Waiting-age urgency for the approvals inbox.
 *
 * The backend has NO SLA configuration on approval gates today (AwaitingApproval
 * carries only createdAt/title/instructions/workflowKey/nodeId), so instead of
 * fabricating "SLA 2d / breached" chips we derive an HONEST urgency from how long
 * the run has actually been blocked:
 *   < 4h   → neutral ("waiting 3h")
 *   4–24h  → warn    ("waiting 5h")
 *   > 24h  → bad     ("waiting 2d 4h")
 * Same visual language as the design's SLA chips, truthful labels.
 */

export type UrgencyTone = "neutral" | "warn" | "bad";

export interface WaitingInfo {
  /** Whole minutes the run has been waiting. */
  minutes: number;
  /** Compact duration — "32m", "5h", "2d 4h". */
  duration: string;
  /** Chip label — "waiting 5h". */
  label: string;
  /** One-line banner for the detail panel. */
  banner: string;
  tone: UrgencyTone;
}

const WARN_AFTER_MIN = 4 * 60;
const BAD_AFTER_MIN = 24 * 60;

export function formatDuration(minutes: number): string {
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  const rem = h % 24;
  return rem > 0 ? `${d}d ${rem}h` : `${d}d`;
}

export function waitingInfo(
  createdAtIso: string,
  now = Date.now(),
): WaitingInfo {
  const minutes = Math.max(
    0,
    Math.floor((now - new Date(createdAtIso).getTime()) / 60_000),
  );
  const tone: UrgencyTone =
    minutes > BAD_AFTER_MIN
      ? "bad"
      : minutes >= WARN_AFTER_MIN
        ? "warn"
        : "neutral";
  const duration = formatDuration(minutes);
  const banner =
    tone === "bad"
      ? `Waiting ${duration} — this run has been blocked for over a day.`
      : tone === "warn"
        ? `Waiting ${duration} — needs a decision soon.`
        : `Waiting ${duration}.`;
  return { minutes, duration, label: `waiting ${duration}`, banner, tone };
}

export function isOverdue(info: WaitingInfo): boolean {
  return info.tone === "bad";
}

export function isRecent(info: WaitingInfo): boolean {
  return info.minutes < WARN_AFTER_MIN;
}

/** fg / bg / border for a tone — mapped onto the codebase's state tokens. */
export function toneColors(tone: UrgencyTone): {
  fg: string;
  bg: string;
  bd: string;
} {
  if (tone === "bad")
    return {
      fg: "var(--state-error)",
      bg: "var(--error-soft)",
      bd: "color-mix(in srgb, var(--state-error) 45%, transparent)",
    };
  if (tone === "warn")
    return {
      fg: "var(--state-paused)",
      bg: "var(--paused-soft)",
      bd: "color-mix(in srgb, var(--state-paused) 45%, transparent)",
    };
  return {
    fg: "var(--ink-faint)",
    bg: "var(--card-2)",
    bd: "var(--line-2)",
  };
}

/**
 * If the gate's instructions are a flat JSON object of primitives, surface them
 * as the design's key/value "fields" card. Anything else (plain prose, arrays,
 * nested payloads) renders as text — no invented structure.
 */
export function parseContextFields(
  instructions: string | null,
): { k: string; v: string }[] | null {
  if (!instructions) return null;
  const trimmed = instructions.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.length === 0) return null;
    return entries.map(([k, v]) => ({
      k,
      v: v === null || typeof v === "object" ? JSON.stringify(v) : String(v),
    }));
  } catch {
    return null;
  }
}
