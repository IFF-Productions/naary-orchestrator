/**
 * Pull the vendor's own explanation out of a failed REST response body.
 *
 * The integration node used to read a TOP-LEVEL `message` and nothing else, so a provider that
 * nests its error — most of them do — had its explanation dropped and the user got
 * `res.statusText`. That is how acknowledging a PagerDuty incident reported
 *
 *     400 Bad Request [PUT /incidents/Q04U9HVHERUPBS]
 *
 * when PagerDuty had actually replied `{"error":{"message":"Caller must supply a From header",…}}`.
 * The one fact needed to fix it was in our hands and we threw it away, leaving the user to guess
 * at a request that was otherwise correct.
 *
 * Shapes handled, in the order a body is likeliest to carry the useful string:
 *   {message}                     GitHub REST, Slack, many
 *   {error: {message}}            PagerDuty, Google, Stripe, OpenAI, Anthropic
 *   {error: "…"}                  simple APIs, OAuth token endpoints
 *   {error_description}           OAuth 2.0 (RFC 6749)
 *   {detail}                      FastAPI, some Atlassian
 *   {errors: [{message}|"…"]}     GitHub GraphQL, Shopify, JSON:API
 *   {errorMessages: ["…"]}        Jira REST v2/v3
 *
 * PagerDuty's nested `error.errors[]` is appended when present: `error.message` is often the
 * generic "Invalid Input Provided" while the array holds the sentence that names the field.
 *
 * Pure and total — never throws, whatever shape the body is. A failure path must not fail.
 */

/** Longest detail we will surface. Vendor errors can embed whole HTML pages. */
const MAX_DETAIL = 300;

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** First usable string in an array of strings or `{message}` objects. */
function fromList(v: unknown): string | null {
  if (!Array.isArray(v)) return null;
  const parts: string[] = [];
  for (const item of v) {
    const s = str(item) ?? (isObj(item) ? str(item.message) : null);
    if (s) parts.push(s);
  }
  return parts.length > 0 ? parts.join("; ") : null;
}

/**
 * @param body   the parsed JSON body, or the raw text when it wasn't JSON
 * @param statusText the HTTP reason phrase — the last resort, and the thing we want to STOP
 *                   showing whenever the body says something better
 */
export function describeApiError(body: unknown, statusText: string): string {
  const fallback = str(statusText) ?? "request failed";

  // A non-JSON body (HTML error page, plain text) — hand back what there is.
  const raw = str(body);
  if (raw) return raw.slice(0, MAX_DETAIL);

  if (!isObj(body)) return fallback;

  const err = body.error;
  const nested = isObj(err) ? err : null;

  // `error.message` + `error.errors[]`: the array is usually the actionable half.
  if (nested) {
    const head = str(nested.message);
    const list = fromList(nested.errors);
    const joined = [head, list].filter(Boolean).join(" — ");
    if (joined) return joined.slice(0, MAX_DETAIL);
  }

  const candidate =
    str(body.message) ??
    str(err) ??
    str(body.error_description) ??
    str(body.detail) ??
    fromList(body.errors) ??
    fromList(body.errorMessages);

  return candidate ? candidate.slice(0, MAX_DETAIL) : fallback;
}

/** Case-insensitive, because a header name is. `From` is what the catalog emits, but nothing
 *  stops a future action (or a custom header integration) from spelling it `from`. */
export function hasFromHeader(
  headers: Record<string, string> | undefined,
): boolean {
  if (!headers) return false;
  return Object.entries(headers).some(
    ([k, v]) => k.toLowerCase() === "from" && typeof v === "string" && v.trim(),
  );
}
