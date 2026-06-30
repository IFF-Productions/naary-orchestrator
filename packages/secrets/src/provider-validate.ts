import { createAnthropic } from "@ai-sdk/anthropic";
import { APICallError, generateText } from "ai";

/**
 * Validate a tenant's Anthropic key with a cheap 1-token call.
 *
 * Returns `false` for any provider CLIENT error (4xx): a bad key (401/403), a
 * rate-limit/exhausted account (429), or a malformed/disabled-model/low-credit
 * request (400) — the key as provided can't make a successful call, so we mark it
 * invalid and let the user fix it (CLAUDE.md: 401/429 surface to the user, don't
 * loop). A 4xx must NOT become an opaque 500.
 *
 * Rethrows only genuine transients (5xx / network), so a momentary Anthropic
 * outage doesn't wrongly mark a good key invalid. The rethrow is SANITIZED — a raw
 * AI-SDK `APICallError` can carry the request's `Authorization` header (the key),
 * so we never propagate or log the original error object.
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
      typeof e.statusCode === "number" &&
      e.statusCode >= 400 &&
      e.statusCode < 500
    ) {
      return false;
    }
    // 5xx / network / unknown: a real transient (Anthropic's fault, not the key).
    // Surface a sanitized error — drop the original so no secret-bearing field
    // (Authorization header, request body) can reach logs/Sentry.
    const status = APICallError.isInstance(e) ? e.statusCode : undefined;
    throw new Error(
      `Provider key validation failed transiently${
        status ? ` (status ${status})` : ""
      }`,
    );
  }
}
