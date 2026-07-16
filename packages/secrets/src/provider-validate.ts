// The AI SDK (`ai`, `@ai-sdk/*`) is ESM-only; this file emits CommonJS (consumed via require), so
// static imports trip TS7's ESM/CJS guard. Load them lazily via dynamic import() — the sanctioned
// CJS→ESM path (validation is a rare, already-async operation, so the per-call import is fine).
const ai = () => import("ai");
const anthropicSdk = () => import("@ai-sdk/anthropic");
const openaiSdk = () => import("@ai-sdk/openai");
const googleSdk = () => import("@ai-sdk/google");

/** Shared 4xx→invalid / 5xx→transient classification (see validateAnthropicKey). A raw
 *  APICallError can carry the request's Authorization header (the key), so a transient
 *  is rethrown SANITIZED — the original error object is never propagated or logged. */
async function classifyKeyError(e: unknown): Promise<boolean> {
  const { APICallError } = await ai();
  if (
    APICallError.isInstance(e) &&
    typeof e.statusCode === "number" &&
    e.statusCode >= 400 &&
    e.statusCode < 500
  ) {
    return false; // a client error means the key can't make a successful call
  }
  const status = APICallError.isInstance(e) ? e.statusCode : undefined;
  throw new Error(
    `Provider key validation failed transiently${
      status ? ` (status ${status})` : ""
    }`,
  );
}

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
  const [{ createAnthropic }, { generateText }] = await Promise.all([
    anthropicSdk(),
    ai(),
  ]);
  const anthropic = createAnthropic({ apiKey });
  try {
    await generateText({
      model: anthropic("claude-haiku-4-5"),
      prompt: "ping",
      maxOutputTokens: 1,
    });
    return true;
  } catch (e) {
    return classifyKeyError(e);
  }
}

/**
 * Validate a tenant's OpenAI key with a cheap 1-token call — mirrors validateAnthropicKey
 * (4xx bad/exhausted key ⇒ invalid; 5xx/network ⇒ sanitized transient rethrow). gpt-4o-mini
 * is the cheapest model to probe with.
 */
export async function validateOpenAiKey(apiKey: string): Promise<boolean> {
  const [{ createOpenAI }, { generateText }] = await Promise.all([
    openaiSdk(),
    ai(),
  ]);
  const openai = createOpenAI({ apiKey });
  try {
    await generateText({
      model: openai("gpt-4o-mini"),
      prompt: "ping",
      maxOutputTokens: 1,
    });
    return true;
  } catch (e) {
    return classifyKeyError(e);
  }
}

/**
 * Validate a Claude Code CLI credential. Unlike the model-provider keys above, this is a
 * FORMAT CHECK only (not a live probe): the credential is either an API key (`sk-ant-api…`) OR
 * a subscription OAuth token from `claude setup-token` (`sk-ant-oat…`). An OAuth token authenticates
 * with `Authorization: Bearer`, NOT the `x-api-key` path the AI-SDK probe uses — so probing it
 * would 4xx a perfectly good token and mark it permanently unusable (getDecryptedKey refuses an
 * invalid row). The REAL end-to-end verification is the Integrations "Run test" button, which runs
 * the actual `claude` CLI with the credential. So we accept any `sk-ant-` token here and let Run
 * test be the truth. Returns false for an obviously-wrong value (empty / wrong prefix) so a paste
 * error still surfaces on save.
 */
export function validateClaudeCodeKey(token: string): Promise<boolean> {
  const t = token.trim();
  // Both API keys (sk-ant-api…) and setup-token OAuth tokens (sk-ant-oat…) share this prefix.
  return Promise.resolve(t.length > 0 && t.startsWith("sk-ant-"));
}

/**
 * Validate a tenant's Google (Gemini) key with a cheap 1-token call — mirrors the others
 * (4xx bad/exhausted key ⇒ invalid; 5xx/network ⇒ sanitized transient). gemini-2.5-flash is
 * the cheapest model to probe with.
 */
export async function validateGoogleKey(apiKey: string): Promise<boolean> {
  const [{ createGoogleGenerativeAI }, { generateText }] = await Promise.all([
    googleSdk(),
    ai(),
  ]);
  const google = createGoogleGenerativeAI({ apiKey });
  try {
    await generateText({
      model: google("gemini-2.5-flash"),
      prompt: "ping",
      maxOutputTokens: 1,
    });
    return true;
  } catch (e) {
    return classifyKeyError(e);
  }
}
