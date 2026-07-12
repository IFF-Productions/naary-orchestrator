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

export interface SpanOptions {
  /** Coarse category shown in the Sentry UI (e.g. "http.server", "db", "activity"). */
  op?: string;
  /** Non-secret, id-only attributes (tenantId/executionId/nodeId). Never raw args. */
  attributes?: SpanAttrs;
}

/**
 * Run `fn` inside a span named `name`. Returns whatever `fn` returns (sync value or
 * promise). Sentry.startSpan auto-ends the span and, if `fn` throws/rejects, marks the
 * span errored before rethrowing — so callers see identical behavior whether tracing is
 * on or off. When Sentry is disabled this is a direct `fn()` call (no span, no cost).
 */
export function withSpan<T>(
  name: string,
  fn: () => T,
  opts: SpanOptions = {},
): T {
  if (!tracingActive()) return fn();
  return Sentry.startSpan(
    { name, op: opts.op, attributes: opts.attributes },
    () => fn(),
  );
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
 * NOTE: worker activity spans are ROOT spans (their own trace), NOT children of the API
 * request that started the run — trace context cannot cross the Temporal boundary without
 * putting non-deterministic data through workflow code. Correlate an activity trace to its
 * run via the tenantId/executionId on its logs, not via a single waterfall.
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
              { op: "activity" },
            )
        : value;
  }
  return out as T;
}
