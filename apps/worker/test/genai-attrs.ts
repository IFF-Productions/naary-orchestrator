/**
 * Shared test helper: pull the `gen_ai.*` / `naary.gen_ai.*` attributes back out of the EXPORTED
 * Sentry envelopes captured by `__initSentryForTest`. Asserting the exported payload (not a
 * mapper's return value) is what makes the GenAI-span specs prove what actually egresses.
 *
 * Not a spec — imported by genai-spans.spec.ts and rag.activity.spec.ts.
 */

/** Unwrap OTel's typed `{ type, value }` span-attribute form (child spans use it; roots don't). */
export function unwrapAttr(v: unknown): unknown {
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    const keys = Object.keys(v);
    if (keys.length === 2 && keys.includes("type") && keys.includes("value")) {
      return (v as { value: unknown }).value;
    }
  }
  return v;
}

/** Merge every `gen_ai.*` / `naary.gen_ai.*` attribute found anywhere in the captured envelopes. */
export function collectGenAiAttrs(
  value: unknown,
  out: Record<string, unknown> = {},
): Record<string, unknown> {
  if (value === null || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const v of value) collectGenAiAttrs(v, out);
    return out;
  }
  for (const [k, v] of Object.entries(value)) {
    if (k.startsWith("gen_ai.") || k.startsWith("naary.gen_ai.")) {
      out[k] = unwrapAttr(v);
    } else collectGenAiAttrs(v, out);
  }
  return out;
}
