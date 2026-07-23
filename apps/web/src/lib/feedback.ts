/**
 * Sentry User Feedback — the "Send feedback" drawer button wiring. The feedback integration is
 * registered with `autoInject:false` (instrument.ts), so there's no floating widget; a button in
 * the nav drawer opens the dialog instead. All of this is a no-op unless Sentry actually
 * initialized (a build-time VITE_SENTRY_DSN), so the button hides itself when feedback is off.
 */
import * as Sentry from "@sentry/react";
import { sentryEnabled } from "../instrument";

/** True when the feedback dialog can be opened (Sentry configured at build). */
export const feedbackAvailable = sentryEnabled;

/**
 * Wire a button element to open the feedback dialog on click. Returns the integration's cleanup
 * (call on unmount) or a no-op when feedback is unavailable. Uses `attachTo` so the SDK owns the
 * dialog lifecycle (create → open → remove) — no manual form stacking.
 */
export function attachFeedback(el: HTMLElement): () => void {
  if (!feedbackAvailable) return () => {};
  const feedback = Sentry.getFeedback();
  if (!feedback) return () => {};
  return feedback.attachTo(el);
}
