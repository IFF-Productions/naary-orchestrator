// Shared styles, URL helpers and copy button for the Integrations screen.
import { useState } from "react";

export const monoLabel: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-2xs)",
  fontWeight: "var(--weight-semibold)",
  letterSpacing: "var(--tracking-label)",
  color: "var(--ink-3)",
  textTransform: "uppercase",
};

/** The full, invokable webhook URL. The /hooks/:id ingress is reached through the same /api
 *  proxy the app uses (nginx rewrites /api/hooks/… → /hooks/…), so this URL is callable as-is. */
export const webhookUrl = (id: string): string =>
  `${window.location.origin}/api/hooks/${id}`;

/** The public, shareable URL of a hosted form — the `/f/:formId` page served outside auth. */
export const formUrl = (id: string): string =>
  `${window.location.origin}/f/${id}`;

/** The public, shareable URL of a hosted chat — the `/c/:chatId` page served outside auth. */
export const chatUrl = (id: string): string =>
  `${window.location.origin}/c/${id}`;

/** Small copy-to-clipboard button with brief "Copied ✓" feedback. */
export function UrlCopy({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title="Copy URL"
      className="btn btn-sm btn-secondary"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(url);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard unavailable — the URL is still visible to copy manually */
        }
      }}
      style={{ flex: "none" }}
    >
      {copied ? "Copied ✓" : "Copy"}
    </button>
  );
}

export const fieldStyle: React.CSSProperties = {
  width: "100%",
  padding: "7px 9px",
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--line-2)",
  background: "var(--card)",
  color: "var(--ink)",
  fontSize: "var(--text-body)",
};
export const fieldLabel: React.CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--ink-2)",
  display: "block",
  marginBottom: 6,
};
