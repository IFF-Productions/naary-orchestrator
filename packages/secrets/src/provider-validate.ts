import { createAnthropic } from "@ai-sdk/anthropic";
import { APICallError, generateText } from "ai";

/**
 * Validate a tenant's Anthropic key with a cheap 1-token call.
 * Returns false for an auth failure (401/403 — the user must fix the key);
 * rethrows genuine transient errors so the caller doesn't mark a good key invalid.
 */
export async function validateAnthropicKey(apiKey: string): Promise<boolean> {
  const anthropic = createAnthropic({ apiKey });
  try {
    await generateText({
      model: anthropic("claude-haiku-4-5"),
      prompt: "ping",
      maxOutputTokens: 1,
    });
    return true;
  } catch (e) {
    if (
      APICallError.isInstance(e) &&
      (e.statusCode === 401 || e.statusCode === 403)
    ) {
      return false;
    }
    throw e;
  }
}
