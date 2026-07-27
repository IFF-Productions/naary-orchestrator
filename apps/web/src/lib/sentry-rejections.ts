/**
 * Make a DOM-Event promise rejection say what failed.
 *
 * #793 is the motivating case: Sentry filed `Event `Event` (type=error) captured as promise
 * rejection` — no message, no stack, no target, and no way to tell which of several promisified
 * `onerror` handlers produced it. That shape happens whenever a rejection reason is a DOM `Event`
 * rather than an `Error`, which is what you get from the common
 * `new Promise((res, rej) => { el.onerror = rej })` pattern (ours and third-party scripts' alike).
 *
 * Sentry has already discarded the object by the time the event is rendered, but `beforeSend`
 * receives it as `hint.originalException`. So the target IS available — it just has to be read
 * before it's dropped.
 *
 * Pure and defensive: this runs on the crash path, where throwing would lose the report entirely.
 */

/** The subset of a Sentry event this touches. Structural, so it needs no SDK types. */
interface SentryEventLike {
  exception?: {
    values?: { type?: string; value?: string }[];
  };
  tags?: Record<string, unknown>;
}

/** A DOM Event, structurally — `instanceof Event` is unavailable when this is unit-tested. */
function asDomEvent(
  err: unknown,
): { type: string; target?: unknown } | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as {
    type?: unknown;
    target?: unknown;
    currentTarget?: unknown;
  };
  if (typeof e.type !== "string") return undefined;
  // `target` may legitimately be null (a fired-and-detached event), so presence of the KEY is the
  // signal, not truthiness — otherwise a targetless error event would fall through unnamed.
  if (!("target" in e) && !("currentTarget" in e)) return undefined;
  return { type: e.type, target: e.target ?? e.currentTarget };
}

/**
 * Describe the element an event fired on: `SCRIPT https://cdn.example/x.js`.
 *
 * The URL is truncated at `?`. `safeScrub` runs over the finished event and would catch a
 * secret-shaped query param anyway, but a resource URL has no business carrying one into a report
 * in the first place — and a bare origin+path is what identifies the resource.
 */
function describeTarget(target: unknown): string | undefined {
  if (typeof target !== "object" || target === null) return undefined;
  const el = target as { tagName?: unknown; src?: unknown; href?: unknown };
  const tag = typeof el.tagName === "string" ? el.tagName : undefined;
  const url =
    typeof el.src === "string"
      ? el.src
      : typeof el.href === "string"
        ? el.href
        : undefined;
  const trimmed = url?.split("?")[0];
  if (tag && trimmed) return `${tag} ${trimmed}`;
  return tag ?? trimmed;
}

/**
 * Rewrite an Event-shaped rejection into something attributable. Returns the event unchanged for
 * every other kind of failure — an `Error` rejection already carries its own message and stack.
 */
export function nameEventRejection<T extends SentryEventLike>(
  event: T,
  originalException: unknown,
): T {
  const domEvent = asDomEvent(originalException);
  if (!domEvent) return event;
  const first = event.exception?.values?.[0];
  if (!first) return event;

  const where = describeTarget(domEvent.target);
  first.value = where
    ? `Unhandled rejection: "${domEvent.type}" event from ${where}`
    : `Unhandled rejection: "${domEvent.type}" event with no target — a promise was rejected with a DOM Event`;
  // Groupable: Sentry titles on type + value, so a bare "Event" collapsed every one of these into a
  // single issue regardless of which resource failed.
  first.type = "UnhandledRejection";
  event.tags = { ...event.tags, rejection_kind: "dom_event" };
  return event;
}
