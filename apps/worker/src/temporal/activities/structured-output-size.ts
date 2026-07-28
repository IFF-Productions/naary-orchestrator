/**
 * Size guard for a node's STRUCTURED OUTPUT (#827).
 *
 * Structured output is returned inline into the activity result and written into `ctx`, so it
 * rides in Temporal history. That is deliberate and must not change: unlike the codeAgent's
 * `diff`/`trace` (display artifacts the API resolves at its boundary), structured output is data
 * the graph READS — a claim-check reference can't be dereferenced inside workflow code, so
 * offloading it would make the feature unusable downstream.
 *
 * What's unbounded is the SCHEMA, which the user authors: a big array or a long free-text field
 * can produce a result large enough to matter against Temporal's ~2MB payload cap. Today that
 * surfaces as a payload rejection — opaque, and at the worst possible moment, after the model has
 * already been paid for.
 *
 * This does not add a policy; it converts a failure that was going to happen anyway into one that
 * says which node, how big, and what to do about it.
 */
import { ApplicationFailure } from "@temporalio/activity";

/**
 * Half of Temporal's ~2MB payload cap.
 *
 * Deliberately generous rather than tidy. A stricter limit (Temporal warns at 256KB) would be
 * defensible design but would break flows that work today, and this guard exists to improve a
 * failure message — not to newly forbid anything. `ctx` also carries every other node's output, so
 * a single node at 1MB is already on course for a rejection.
 */
export const MAX_STRUCTURED_OUTPUT_BYTES = 1_048_576;

/** `1.4 MB`, `812 KB` — the number the author needs, not a raw byte count. */
function human(bytes: number): string {
  return bytes >= 1_048_576
    ? `${(bytes / 1_048_576).toFixed(1)} MB`
    : `${Math.round(bytes / 1024)} KB`;
}

/**
 * Throw a NON-RETRYABLE failure when a node's structured output is too large to carry.
 *
 * Non-retryable because the cause is the authored schema: retrying re-pays for the same model call
 * and produces the same oversized result. Same reasoning as the 401/429 mapping in the agent
 * activity — don't burn retries on something only the user can fix.
 *
 * CALL IT AFTER `recordUsage`. The model has already run and been billed by this point; throwing
 * before the ledger write would lose the spend, which is the exact failure mode CLAUDE.md's
 * "billing must fail safe" rule exists to prevent.
 *
 * @param value  the structured output, or undefined/null when the node produced none
 * @param nodeId the node to name in the message — the author has to know WHICH one
 */
export function assertStructuredOutputSize(
  value: unknown,
  nodeId: string,
): void {
  if (value === undefined || value === null) return;

  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    // Unserialisable (a cycle, a BigInt) — not this guard's problem, and the payload converter
    // will report it far more precisely than a guess here would.
    return;
  }

  if (bytes <= MAX_STRUCTURED_OUTPUT_BYTES) return;

  throw ApplicationFailure.nonRetryable(
    `Node "${nodeId}" produced ${human(bytes)} of structured output, over the ` +
      `${human(MAX_STRUCTURED_OUTPUT_BYTES)} limit. Structured output travels in the workflow's ` +
      `history, so it can't be offloaded — narrow the node's output schema (fewer fields, a ` +
      `shorter array, or a summary instead of full text) and run it again.`,
    "STRUCTURED_OUTPUT_TOO_LARGE",
  );
}
