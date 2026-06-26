/**
 * Canonical serialization for content-hashing a graph (Slice #5). Pure — no
 * crypto, time, or I/O — so it is safe to live in the DSL (which is bundled into
 * the deterministic workflow). The actual sha256 hashing lives server-side.
 *
 * Object KEYS are sorted (cosmetic reordering doesn't change identity), but ARRAY
 * order is preserved — node/edge order is SEMANTIC (the interpreter's `walk` takes
 * the first declared outgoing edge), so reordering edges is a real change.
 */
function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = sortValue(obj[key]);
    }
    return out;
  }
  return value;
}

/** Deterministic, key-sorted JSON string of a graph (or any JSON value). */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}
