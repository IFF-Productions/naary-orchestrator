/**
 * The dedupe key for a self-healing proposal: "is this the same failure we already proposed a fix
 * for?"
 *
 * WHY IT HAS TO BE GOOD. A workflow failing on a 5-minute schedule produces a failed run every 5
 * minutes. Without dedupe that is 288 model calls a day, billed to the tenant, each producing a
 * near-identical proposal, and an inbox nobody can use. With dedupe that is one.
 *
 * The cost of being WRONG runs both ways, which is why the normalization below is deliberately
 * modest:
 *   - too LOOSE and two genuinely different failures collapse into one, so the second never gets
 *     a proposal and the user is never told why;
 *   - too TIGHT and a per-run id in the message makes every run unique, which is the same as
 *     having no dedupe at all.
 *
 * So the node and the classified kind carry most of the identity — they are already structured —
 * and only the volatile parts of the MESSAGE are removed: ids that change per run, and numbers.
 * Everything else is left alone, because "Missing required header 'From'" and "Missing required
 * header 'Authorization'" are different problems and must stay different keys.
 *
 * Pure and deterministic: no clock, no randomness, no I/O. Safe to call from workflow code.
 */

/** Longest signature we store. Long enough to stay specific; short enough to index. */
const MAX_SIGNATURE = 300;

/**
 * Strip the parts of an error message that differ between two occurrences of the SAME failure.
 *
 * Each rule earns its place by being something that varies run-to-run while the underlying fault
 * does not — a uuid in "run abc-123 failed", a timestamp, a row count, a port. Anything not on
 * this list survives, because unrecognised text is more likely to be the diagnosis than noise.
 */
export function normalizeFailureMessage(message: string): string {
  return (
    message
      .toLowerCase()
      // UUIDs — run ids, request ids, connection ids.
      .replace(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
        "<id>",
      )
      // ISO timestamps.
      .replace(/\d{4}-\d{2}-\d{2}t[\d:.]+z?/g, "<time>")
      // Long hex/base-ish runs (request ids, hashes) — 12+ so ordinary words survive.
      .replace(/\b[0-9a-f]{12,}\b/g, "<id>")
      // Bare numbers. A status code IS meaningful, but `failureKind` already carries that
      // distinction (rate_limit / timeout / upstream_5xx), so losing it here costs nothing and
      // stops "retry 1 of 3" from minting a fresh signature every attempt.
      .replace(/\b\d+\b/g, "<n>")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * A stable identity for a failure: which node, what kind, and what it said.
 *
 * The parts are ESCAPED before joining, so the encoding is injective. Relying on "a node id can
 * only contain [\w$-], so it can never hold a separator" was the first version, and it is exactly
 * the kind of invariant that holds until some other caller passes something else: `{"a|b", "c"}`
 * and `{"a", "b|c"}` both produced `a|b|c|`, merging two unrelated failures into one signature so
 * the second would never have been proposed. A test caught it; escaping removes the assumption
 * rather than restating it.
 */
function escapePart(s: string): string {
  return s.replace(/%/g, "%25").replace(/\|/g, "%7C");
}

export function healFailureSignature(input: {
  failedNodeId: string;
  failureKind: string;
  message?: string | null;
}): string {
  const message = normalizeFailureMessage(input.message ?? "");
  return [input.failedNodeId, input.failureKind, message]
    .map(escapePart)
    .join("|")
    .slice(0, MAX_SIGNATURE);
}
