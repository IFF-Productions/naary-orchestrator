import { useEffect } from "react";

/**
 * When a public page is embedded (`?embed=1`, inside a tenant's iframe), post its content height to
 * the parent so the `embed.js` loader can size the iframe to fit (no inner scrollbar). Protocol:
 * `postMessage({ type: "naary:resize", id, height }, "*")` on mount and whenever the content resizes.
 *
 * `targetOrigin: "*"` because the parent is the tenant's arbitrary site — the message carries only a
 * height (non-sensitive), and the RECEIVER (embed.js) validates the message's origin is ours. No-op
 * when not embedded or not actually inside a frame.
 */
export function useEmbedResize(enabled: boolean, id: string | undefined): void {
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    // Not in a frame (or the parent is us) → nothing to report.
    if (window.parent === window) return;

    // Measure the CONTENT element (PublicFrame root, no min-height in embed mode), not
    // documentElement — `documentElement.scrollHeight` is clamped to the iframe's own height when
    // html/body are height:100%, so it would always report the current (default) frame height.
    const content = () =>
      document.querySelector<HTMLElement>(".naary-public") ??
      document.body ??
      document.documentElement;

    const post = () => {
      const height = Math.ceil(content().getBoundingClientRect().height);
      if (height > 0) {
        window.parent.postMessage({ type: "naary:resize", id, height }, "*");
      }
    };

    post();
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      // Re-measure as the page grows (definition loads, Turnstile widget renders, chat messages…).
      ro = new ResizeObserver(post);
      ro.observe(content());
    }
    window.addEventListener("load", post);
    return () => {
      ro?.disconnect();
      window.removeEventListener("load", post);
    };
  }, [enabled, id]);
}
