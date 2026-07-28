// Cloudflare Turnstile widget for the public form/chat pages (docs/design/TURNSTILE-BOT-PROTECTION.md,
// Slice 2). Loads Cloudflare's script once, renders the widget with the tenant's site key, and calls
// `onToken` with the solved (single-use) token. `resetSignal` lets the parent re-arm the widget after
// a token is spent (e.g. a submit failed) so the visitor can retry. If the script fails to load the
// page still works — the server fail-opens on a Cloudflare outage, so we never hard-block the page.
import { useEffect, useRef } from "react";

const SCRIPT_ID = "cf-turnstile-script";
const SCRIPT_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface TurnstileApi {
  render: (
    el: HTMLElement,
    opts: {
      sitekey: string;
      callback: (token: string) => void;
      "error-callback"?: () => void;
      "expired-callback"?: () => void;
      theme?: "auto" | "light" | "dark";
    },
  ) => string;
  remove: (id: string) => void;
  reset: (id: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

/** Load Cloudflare's Turnstile script once (idempotent); resolves when `window.turnstile` is ready. */
function loadTurnstile(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.turnstile) return resolve();
    const existing = document.getElementById(
      SCRIPT_ID,
    ) as HTMLScriptElement | null;
    // Reject with an ERROR that names the script, never bare `reject()` or the DOM event.
    // A rejection whose reason is `undefined` or an `Event` reaches Sentry with no message and no
    // stack — that is #793, filed as literally "<unknown>". `nameEventRejection` recovers the
    // target for THIRD-PARTY scripts we don't control; for our own call sites the fix is simply to
    // say what failed.
    const failed = () =>
      reject(
        new Error(
          `Turnstile script failed to load (${SCRIPT_SRC}). A blocked or offline ` +
            `request, or a CSP script-src that doesn't allow it.`,
        ),
      );

    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", failed);
      return;
    }
    const s = document.createElement("script");
    s.id = SCRIPT_ID;
    s.src = SCRIPT_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = failed;
    document.head.appendChild(s);
  });
}

export function TurnstileWidget({
  siteKey,
  onToken,
  onReset,
  onUnavailable,
  resetSignal = 0,
}: {
  siteKey: string;
  /** Called with the solved single-use token. */
  onToken: (token: string) => void;
  /** Called when the token is cleared (expired/errored/reset) so the parent can disable submit. */
  onReset?: () => void;
  /** Called when the widget can never produce a token here (script blocked/offline) so the
   *  parent can stop gating submit — see below. */
  onUnavailable?: () => void;
  /** Bump to re-arm the widget after the token was spent (e.g. a failed submit). */
  resetSignal?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  // Keep the latest callbacks without re-rendering the widget (which would reset it).
  const cb = useRef({ onToken, onReset, onUnavailable });
  useEffect(() => {
    cb.current = { onToken, onReset, onUnavailable };
  });

  // Render once per site key.
  useEffect(() => {
    let cancelled = false;
    const el = ref.current;
    loadTurnstile()
      .then(() => {
        if (cancelled || !el || !window.turnstile) return;
        widgetId.current = window.turnstile.render(el, {
          sitekey: siteKey,
          theme: "auto",
          callback: (t) => cb.current.onToken(t),
          "expired-callback": () => cb.current.onReset?.(),
          "error-callback": () => cb.current.onReset?.(),
        });
      })
      .catch(() => {
        // Script blocked (ad/privacy extension) or offline. The header comment always claimed
        // this leaves the page usable, but it did NOT: the parent kept submit disabled until a
        // token arrived, so a blocked script meant a permanently dead button. Tell the parent
        // explicitly, and let the server — which fail-opens on a Cloudflare outage — decide.
        if (!cancelled) cb.current.onUnavailable?.();
      });
    return () => {
      cancelled = true;
      if (widgetId.current && window.turnstile) {
        try {
          window.turnstile.remove(widgetId.current);
        } catch {
          /* already gone */
        }
        widgetId.current = null;
      }
    };
  }, [siteKey]);

  // Re-arm after a spent token (parent bumps resetSignal); ignore the initial 0.
  useEffect(() => {
    if (!resetSignal) return;
    if (widgetId.current && window.turnstile) {
      try {
        window.turnstile.reset(widgetId.current);
      } catch {
        /* not rendered yet */
      }
    }
    cb.current.onReset?.();
  }, [resetSignal]);

  return <div ref={ref} style={{ marginBottom: 14 }} />;
}
