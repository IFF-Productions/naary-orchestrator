/**
 * Structured JSON logging shared by the API + worker (PRODUCTION-READINESS §3.D).
 * One machine-parseable line per event, carrying correlation / tenant / execution
 * IDs via pino child bindings — so a single run can be traced API → activity.
 *
 * SECURITY (CLAUDE.md: secrets never enter logs). Every argument — the message
 * string AND any merged object — passes through the audited scrubber reused from
 * @naary/observability (drops sensitive-named keys, redacts secret-shaped
 * substrings). So even a stray key echoed in a provider error message is redacted
 * before it is serialized.
 *
 * Do NOT import this from workflow code (workflows.ts): logging is I/O and would
 * break deterministic replay. API/worker boot, request handlers, and activities
 * (worker side) only — same rule as @naary/observability.
 */
import { randomUUID } from "node:crypto";
import { deepScrub, redactString } from "@naary/observability";
import pino, { type DestinationStream, type Logger } from "pino";

export type { Logger } from "pino";

export interface LoggerOptions {
  /** Tags every line so api/worker streams are distinguishable in one sink. */
  component: "api" | "worker";
}

/**
 * Build a structured logger. `destination` is injectable so tests can capture
 * output; production omits it and pino writes JSON lines to stdout.
 */
export function createLogger(
  opts: LoggerOptions,
  destination?: DestinationStream,
): Logger {
  const options = {
    // Quiet by default; raise with LOG_LEVEL=debug for local debugging.
    level: process.env.LOG_LEVEL ?? "info",
    base: { component: opts.component },
    // ISO timestamps over pino's default epoch-ms — readable in a log search UI.
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      // Emit the level as a word ("info") instead of a number (30).
      level: (label: string) => ({ level: label }),
    },
    hooks: {
      // Defense-in-depth: scrub BOTH the message and any structured fields before
      // pino serializes them. Reuses the unit-tested observability scrubber so the
      // redaction rules stay in one place. Applies to child loggers too (hooks are
      // inherited), so per-request/per-execution bindings are scrubbed as well.
      logMethod(
        this: Logger,
        args: unknown[],
        method: (...a: unknown[]) => void,
      ) {
        const scrubbed = args.map((a) =>
          typeof a === "string"
            ? redactString(a)
            : a && typeof a === "object"
              ? deepScrub(a)
              : a,
        );
        method.apply(this, scrubbed);
      },
    },
  };
  return destination
    ? pino(options as pino.LoggerOptions, destination)
    : pino(options as pino.LoggerOptions);
}

/**
 * Generate a correlation / request id. Uses randomUUID (non-deterministic) — safe
 * in API/worker code, NEVER inside workflow code.
 */
export function newCorrelationId(): string {
  return randomUUID();
}
