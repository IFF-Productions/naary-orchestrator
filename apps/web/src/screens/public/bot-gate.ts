// Pure bot-gate helpers for the public form/chat pages, kept OUT of BotGate.tsx so they are
// testable in the node-environment suite (same split as form-branding.ts).
import type { BotGate as BotGateDescriptor } from "../../lib/api/types";

/**
 * Derive the gate from a public definition, tolerating an OLDER API that only knows
 * `turnstileSiteKey`. That is the compatibility direction that matters: this page is always
 * the freshly-deployed bundle, whereas the API it talks to may be a release behind (and an
 * embedded iframe can be pinned to an old bundle, which is why the server still emits both).
 *
 * Shared so the form and chat pages cannot drift on it — the failure would be silent, a page
 * quietly rendering no gate while the server enforces one and 403s every submission.
 */
export function resolveBotGate(def: {
  botGate?: BotGateDescriptor;
  turnstileSiteKey?: string;
}): BotGateDescriptor | null {
  if (def.botGate) return def.botGate;
  return def.turnstileSiteKey
    ? { provider: "turnstile", siteKey: def.turnstileSiteKey }
    : null;
}
