/**
 * Turn a Temporal client failure into something a human can act on.
 *
 * `client.workflow.execute()` rejects with a `WorkflowFailedError` whose own message is always the
 * same three words — **"Workflow execution failed"** — and whose `cause` chain carries the actual
 * reason: the `ApplicationFailure` the activity threw, with its message and `type`.
 *
 * Reported against the single-node test run, which showed exactly that:
 *
 *     {"pure":false,"message":"Test run failed: Workflow execution failed"}
 *
 * — no reason in the response, and nothing in the server log either. The cause was thrown away one
 * line after it arrived.
 *
 * PURE (no I/O, no SDK imports): walked structurally rather than with `instanceof`, so it works on a
 * failure that crossed a serialization boundary and can be unit-tested without constructing SDK
 * error objects.
 */
import { redactString } from "@naary/observability";

/** How much of the innermost message to keep. Long enough for a provider's error body excerpt,
 *  short enough not to dump a stack into a toast. */
const MAX_MESSAGE = 300;

/** Per-LAYER cap for the chain. The chain is logged in FULL, and an activity failure can quote a
 *  multi-KB provider body or a stack — a log line built from an unbounded chain is its own
 *  incident (raised in review). Roomier than MAX_MESSAGE because the log is where you go to
 *  diagnose, but still bounded. */
const MAX_CHAIN_ENTRY = 500;

/** The generic wrappers that carry no information — skipped when a deeper cause exists. */
const UNINFORMATIVE = [
  /^workflow execution failed\.?$/i,
  /^activity task failed\.?$/i,
  /^child workflow (execution )?failed\.?$/i,
];

interface FailureLike {
  message?: unknown;
  type?: unknown;
  cause?: unknown;
}

function asFailure(e: unknown): FailureLike | undefined {
  return e !== null && typeof e === "object" ? (e as FailureLike) : undefined;
}

/**
 * Every message in the cause chain, outermost first, with blanks dropped. Bounded: a cyclic or
 * pathologically deep chain can't spin here.
 */
export function failureChain(error: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<unknown>();
  let node = asFailure(error);
  for (let depth = 0; node && depth < 12; depth++) {
    if (seen.has(node)) break;
    seen.add(node);
    const message = typeof node.message === "string" ? node.message.trim() : "";
    const type = typeof node.type === "string" ? node.type : "";
    if (message) {
      const capped = message.slice(0, MAX_CHAIN_ENTRY);
      out.push(type ? `${capped} [${type}]` : capped);
    }
    node = asFailure(node.cause);
  }
  return out;
}

/**
 * The most specific message in the chain — the INNERMOST one that actually says something.
 *
 * Innermost rather than outermost because Temporal wraps: the activity's real error ("integration
 * 'pagerduty.acknowledge' failed: 401 …") sits underneath two generic wrappers. Falls back to the
 * outermost entry if every layer is generic, so this never returns an empty string.
 *
 * Redacted: an activity failure can quote a provider's response body, which may contain a token.
 */
export function describeWorkflowFailure(error: unknown): string {
  const chain = failureChain(error);
  if (chain.length === 0) {
    return error instanceof Error && error.message
      ? redactString(error.message).slice(0, MAX_MESSAGE)
      : "the node errored";
  }
  const informative = chain.filter(
    (m) =>
      !UNINFORMATIVE.some((re) => re.test(m.replace(/\s*\[[^\]]+\]$/, ""))),
  );
  // `.at(-1)` isn't in this project's lib target — index explicitly.
  const best =
    informative.length > 0 ? informative[informative.length - 1] : chain[0];
  return redactString(best).slice(0, MAX_MESSAGE);
}
