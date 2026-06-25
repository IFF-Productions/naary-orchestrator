/**
 * Activities — the ONLY place side effects are allowed (CLAUDE.md Tier-1 rule 3).
 *
 * `runAgentStub` does no real work yet (no LLM, no network): it establishes the
 * activity boundary now so the interpreter calls agents through an activity from
 * day one. Slice #2 swaps the body for a real model call via the AI SDK.
 */
export async function runAgentStub(
  config: { canned: string },
  input: unknown,
): Promise<string> {
  return `[stub-agent] ${config.canned} :: ${JSON.stringify(input)}`;
}
