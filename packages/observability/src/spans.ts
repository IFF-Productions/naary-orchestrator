/**
 * Method / activity span tracing on top of Sentry performance. OFF unless Sentry is
 * initialized (SENTRY_DSN set) AND sampled (SENTRY_TRACES_SAMPLE_RATE > 0) — when
 * disabled every helper is a transparent passthrough with ZERO overhead.
 *
 * SECURITY (CLAUDE.md: secrets never enter telemetry spans). These helpers set only a
 * span NAME (+ a coarse `op`) — never raw arguments or return values. The transaction
 * that carries the finished spans is additionally scrubbed on `beforeSendTransaction`
 * (see initSentry), so auto-instrumented attributes (request URLs, SQL text) are cleaned
 * too. Do NOT pass secrets as span attributes here.
 *
 * DETERMINISM (CLAUDE.md rule 2). Never call these from workflow code (workflows.ts):
 * opening a span reads the clock / async context and would break replay. API request
 * handlers/services and worker ACTIVITIES only.
 */
import * as Sentry from "@sentry/node";

/** Sentry is active iff a client was installed by initSentry (only when SENTRY_DSN is set).
 *  Checked via the SDK (not an import from ./index) to avoid a circular module dependency. */
function tracingActive(): boolean {
  return Sentry.getClient() !== undefined;
}

/** Span attribute values Sentry accepts. Keep these to non-secret identifiers. */
export type SpanAttrs = Record<string, string | number | boolean>;

/**
 * Set attributes on the CURRENTLY ACTIVE span — for values only known AFTER the work finished
 * (token counts, a finish reason), which {@link withSpan}'s creation-time `attributes` can't carry.
 * No-op when tracing is off or there is no active span, so callers need no guard; a failure is
 * swallowed (telemetry must never break the caller).
 *
 * SAME SECRETS RULE as withSpan (CLAUDE.md Tier-1 §4): ids, counts, and enum-ish strings only —
 * never arguments, return values, prompt/completion text, or credentials. The list form is allowed
 * because some OTel conventions are typed as string arrays (e.g. `gen_ai.response.finish_reasons`)
 * and deepScrub walks arrays, so a list value is still scrubbed on egress.
 */
export function setSpanAttributes(
  attrs: Record<string, string | number | boolean | string[]>,
): void {
  if (!tracingActive()) return;
  const span = Sentry.getActiveSpan();
  if (!span) return;
  try {
    span.setAttributes(attrs);
  } catch {
    /* telemetry must never break the caller */
  }
}

/**
 * The ONLY fields lifted from an activity's arguments onto its span/log — a strict
 * allowlist of non-secret correlation ids (CLAUDE.md Tier-1 §4: secrets never enter
 * telemetry). Do NOT widen this to "all of meta" or spread an arg object: activity
 * configs carry headers/tokens/DSNs, and a blanket copy would leak them. Every entry
 * here must be an id that is safe to search on in Sentry.
 */
const ACTIVITY_ID_KEYS = [
  "tenantId",
  "environmentId",
  "executionId",
  "nodeId",
  "workflowId",
  "workflowKey",
] as const;

/**
 * Pull the allowlisted correlation ids out of an activity's positional arguments. Activities
 * take their ids on a `meta`/config object (usually the last arg), so we scan every object arg
 * and copy ONLY {@link ACTIVITY_ID_KEYS} that are present and string-valued — never the raw arg.
 * A later object's id wins over an earlier one (the explicit `meta` arg beats an incidental match).
 * Exported so it can be unit-tested directly (the passthrough span tests can't observe attributes).
 */
export function activityIdAttrs(args: readonly unknown[]): SpanAttrs {
  const attrs: SpanAttrs = {};
  for (const arg of args) {
    if (!arg || typeof arg !== "object") continue;
    const rec = arg as Record<string, unknown>;
    for (const key of ACTIVITY_ID_KEYS) {
      const v = rec[key];
      if (typeof v === "string" && v) attrs[key] = v;
    }
  }
  return attrs;
}

export interface SpanOptions {
  /** Coarse category shown in the Sentry UI (e.g. "http.server", "db", "activity"). */
  op?: string;
  /**
   * Non-secret, id-only attributes (tenantId/executionId/nodeId). Never raw args. May be a
   * THUNK — resolved only when a span is actually created (tracing on), so extracting the
   * ids costs nothing on the disabled passthrough path.
   */
  attributes?: SpanAttrs | (() => SpanAttrs);
}

/**
 * Run `fn` inside a span named `name`. Returns whatever `fn` returns (sync value or
 * promise). Sentry.startSpan auto-ends the span and, if `fn` throws/rejects, marks the
 * span errored before rethrowing — so callers see identical behavior whether tracing is
 * on or off. When Sentry is disabled this is a direct `fn()` call (no span, no cost) — and
 * a thunk `attributes` is NOT evaluated, preserving the zero-overhead guarantee.
 */
export function withSpan<T>(
  name: string,
  fn: () => T,
  opts: SpanOptions = {},
): T {
  if (!tracingActive()) return fn();
  const attributes =
    typeof opts.attributes === "function" ? opts.attributes() : opts.attributes;
  return Sentry.startSpan({ name, op: opts.op, attributes }, () => fn());
}

/**
 * Method decorator: wrap a class method so each call opens a span `Class.method`
 * (override with `name`). Sets the span name + op only — never the arguments or the
 * return value (secrets rule). `this`, args, and the return value pass through unchanged.
 *
 *   @Traced()                  // span "ExecutionsService.approve"
 *   async approve(...) { ... }
 */
export function Traced(opts: { op?: string; name?: string } = {}) {
  return (
    target: object,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ): PropertyDescriptor => {
    const original = descriptor.value;
    if (typeof original !== "function") return descriptor;
    const cls =
      (target as { constructor?: { name?: string } })?.constructor?.name ?? "";
    const spanName = opts.name ?? `${cls}.${String(propertyKey)}`;
    const op = opts.op ?? "function";
    descriptor.value = function (this: unknown, ...args: unknown[]): unknown {
      return withSpan(spanName, () => original.apply(this, args), { op });
    };
    return descriptor;
  };
}

/**
 * Class decorator: wrap EVERY method on the class so each call opens a span
 * `Class.method` — instrument a whole service with one line instead of decorating each
 * method. Same secrets rule as {@link Traced} (name + op only). Getters/setters and the
 * constructor are left untouched; `this`/args/return pass through. The class identity is
 * preserved (same constructor, same reflect-metadata), so NestJS DI is unaffected.
 *
 *   @TracedClass()
 *   export class ExecutionsService { … }   // every method → its own span
 */
export function TracedClass(opts: { op?: string } = {}) {
  return <T extends { new (...args: never[]): object }>(ctor: T): T => {
    const proto = ctor.prototype as Record<string, unknown>;
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key === "constructor") continue;
      const desc = Object.getOwnPropertyDescriptor(proto, key);
      if (!desc || typeof desc.value !== "function" || desc.get || desc.set) {
        continue;
      }
      const original = desc.value as (...a: unknown[]) => unknown;
      const spanName = `${ctor.name}.${key}`;
      const op = opts.op ?? "function";
      Object.defineProperty(proto, key, {
        ...desc,
        value: function (this: unknown, ...args: unknown[]): unknown {
          return withSpan(spanName, () => original.apply(this, args), { op });
        },
      });
    }
    return ctor;
  };
}

/**
 * Wrap every function in an activities map so each invocation opens a span
 * `activity.<name>`. Temporal registers activities by the object KEY, and this preserves
 * the keys (only the values are wrapped), so activity names — and Temporal's dispatch —
 * are unchanged.
 *
 * The `activity.<name>` span is a CHILD of the API request span when trace context was
 * propagated across the Temporal boundary (the client + workflow + activity interceptors in
 * apps/{api,worker} carry `sentry-trace`/`baggage` through workflow → activity headers, and the
 * activity interceptor runs `continueSentryTrace` around this call). When no trace was propagated
 * (tracing off, or a run started before that wiring), it degrades to a ROOT span — still correct,
 * just not stitched into a single waterfall. See temporal-trace.ts.
 *
 * Each span is tagged with the run's correlation ids ({@link activityIdAttrs}) lifted off the
 * activity's `meta` arg, so a trace can be filtered/pivoted by tenantId/executionId/nodeId in the
 * Sentry UI. Only allowlisted ids are copied — never the raw config (secrets rule).
 */
export function traceActivities<T extends Record<string, unknown>>(
  activities: T,
): T {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(activities)) {
    out[name] =
      typeof value === "function"
        ? (...args: unknown[]) =>
            withSpan(
              `activity.${name}`,
              () => (value as (...a: unknown[]) => unknown)(...args),
              // Thunk: ids are extracted only when a span is actually created (tracing on),
              // so the disabled passthrough stays zero-overhead.
              { op: "activity", attributes: () => activityIdAttrs(args) },
            )
        : value;
  }
  return out as T;
}
