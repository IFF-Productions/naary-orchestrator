import { ConnectCallbackError } from "@naary/connections";
import { captureError } from "@naary/observability";

/** The subset of NestJS's `Logger` the reporter needs (kept structural for easy testing). */
interface CallbackLogger {
  warn(message: string): void;
  error(message: string): void;
}

/**
 * Record a connect-callback failure at the RIGHT severity. The @Public callbacks catch every
 * error and 302 the browser back to the SPA (never a user-facing 500), but that must not blind
 * ops to genuine faults:
 *
 *  - `ConnectCallbackError` (missing/unknown/expired single-use state) is USER-RECOVERABLE and
 *    expected traffic on a public GET — a WARN only, never paged. This is the #419/#426 class.
 *  - Anything else is a GENUINE fault (store/provider outage, or a tampered/mismatched state) —
 *    an ERROR that IS captured to alerting, so a real problem stays visible even though the user
 *    was still redirected cleanly.
 *
 * The caller redirects the browser either way.
 */
export function reportConnectCallbackFailure(
  err: unknown,
  logger: CallbackLogger,
  where: string,
): void {
  if (err instanceof ConnectCallbackError) {
    logger.warn(`${where}: ${err.message} (${err.reason})`);
    return;
  }
  logger.error(`${where}: ${(err as Error)?.message ?? "unknown error"}`);
  captureError(err, { where });
}
