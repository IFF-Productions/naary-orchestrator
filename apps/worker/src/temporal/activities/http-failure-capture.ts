/**
 * Redacted request/response capture for a FAILED HTTP-ish node (#916).
 *
 * The reported experience: a write that comes back non-2xx throws
 * `ApplicationFailure.nonRetryable`, so nothing is written to ctx and the run detail says
 * "No output was recorded for this step." Everything we knew at the single most diagnostic
 * moment — the resolved method and URL, the headers we set, what the provider actually sent
 * back — was discarded except one message string. #909 made the vendor's own MESSAGE visible;
 * this is the layer under it.
 *
 * The whole design is about bounding the blast radius, because a third-party response body is
 * CUSTOMER DATA and a request body can carry `$vars`/`$secrets`-bound values:
 *
 *   - FAILURES ONLY. A successful call captures nothing. A run's happy path must not accumulate
 *     copies of every payload it touched.
 *   - Headers by ALLOWLIST, never a denylist. A denylist is a list of the leaks we thought of;
 *     the header we forget is the one that leaks. Names are always kept (knowing that
 *     `Authorization` was sent is diagnostic), VALUES only survive for a short list of provably
 *     non-credential headers (content-type, retry-after, x-ratelimit-*, …).
 *   - Bodies TRUNCATED to ~2KB with a visible marker, then scrubbed twice: key-name scrubbing
 *     for structured bodies (@naary/observability's `deepScrub`) and secret-SHAPE scrubbing for
 *     the resulting text (`redactString`).
 *
 * The capture rides the failure's structured `details` — Temporal history, same retention as the
 * run — rather than a new store. That keeps it bounded by construction: ~5KB worst case against
 * the ~2MB payload cap, and no second lifecycle to reason about for deletion.
 *
 * PURE and TOTAL: no I/O, no clock, never throws whatever it is handed. This runs only on a path
 * that is ALREADY failing — a capture that throws would replace a diagnosable provider error with
 * a meaningless one, which is precisely the bug being fixed.
 */
import { deepScrub, redactString } from "@naary/observability";

const REDACTED = "[REDACTED]";

/** Body cap. Big enough for a real provider error envelope, small enough that four of them
 *  (two bodies + two header maps) stay far under Temporal's ~2MB payload cap. */
export const MAX_BODY_BYTES = 2048;

/** A URL is short; a pathological one (a data: URI bound from run data) is not. */
const MAX_URL = 1000;

/**
 * Largest body we will PARSE-and-key-scrub. Above this we go straight to the text passes on the
 * truncated window, which is all we store anyway.
 *
 * Not an arbitrary tidiness cap — a correctness one. `redactString`'s credentials-in-URL pattern
 * (`[a-z][a-z0-9+.-]*` before `://`) backtracks quadratically on a long run of letters, so handing
 * it a 500KB response body wedged the activity for over a minute (caught by the "stays small"
 * test below, as a 60s timeout). A failure path that hangs is worse than the missing data this
 * whole module exists to restore.
 */
const MAX_PARSE_BYTES = 16 * 1024;

/**
 * Extra characters kept past the cap while the text passes run, then cut. Without it a token
 * straddling the 2KB boundary would be sliced in half BEFORE the redaction saw it, and half a
 * credential is still a leaked prefix — the shape patterns need the whole thing to match.
 */
const TRUNCATION_SLACK = 512;

/** A response can legally carry hundreds of headers. Names only are cheap, but not unbounded. */
const MAX_HEADERS = 40;

/**
 * Header VALUES we are willing to store. Exact, lowercase names only — anything not listed keeps
 * its NAME and loses its VALUE. Every entry is a protocol/diagnostic header that cannot carry a
 * credential:
 *   - content negotiation + framing: what we asked for and what came back
 *   - rate limiting (`retry-after`, the `x-ratelimit-*` family below): the single most common
 *     cause of a 429/403 write failure, and useless without the numbers
 *   - request ids: what a vendor's support asks for first
 *
 * Deliberately NOT here, and worth stating so nobody "helpfully" adds them: `authorization`,
 * `proxy-authorization`, `cookie`, `set-cookie`, `from` (a user's email — PII, and the field
 * PagerDuty writes need), `www-authenticate` (can echo a realm/nonce), and `location` (an OAuth
 * redirect routinely carries a code or token in its query string).
 */
const SAFE_HEADER_NAMES = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "cache-control",
  "content-encoding",
  "content-length",
  "content-type",
  "date",
  "etag",
  "retry-after",
  "server",
  "user-agent",
  "vary",
  "x-correlation-id",
  "x-github-request-id",
  "x-request-id",
  "x-trace-id",
]);

/** Rate-limit headers are spelled at least three ways across vendors; a prefix is the only
 *  practical form. Every member of these families is a count or a timestamp. */
const SAFE_HEADER_PREFIXES = ["x-ratelimit-", "x-rate-limit-", "ratelimit-"];

function headerValueIsSafe(lowerName: string): boolean {
  return (
    SAFE_HEADER_NAMES.has(lowerName) ||
    SAFE_HEADER_PREFIXES.some((p) => lowerName.startsWith(p))
  );
}

/**
 * Credential headers echoed INSIDE a body — an HTML error page that dumps the request, a
 * curl-style debug envelope, a JSON `{"headers":{"Authorization":"Bearer …"}}`.
 *
 * `redactString`'s generic `key=value` rule stops at the first whitespace, so on
 * `Authorization: Bearer AbCdEf123456` it redacts the word "Bearer" and leaves the token —
 * this kills the rest of the value instead. Narrow on purpose: it targets the specific header
 * names that ARE the credential, rather than being a second general-purpose scrubber.
 */
const CREDENTIAL_IN_TEXT =
  /((?:authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|x[-_]?api[-_]?key)\s*["']?\s*[:=]\s*["']?)[^\r\n"}]+/gi;

/** A captured (already-redacted, already-truncated) body. */
export interface CapturedBody {
  /** Scrubbed text, with a `…[truncated …]` marker appended when it did not fit. */
  text: string;
  /** True when the scrubbed text exceeded the cap — the marker in `text` says so in-band too. */
  truncated: boolean;
  /**
   * Size of the ORIGINAL body as it came off the wire — deliberately NOT the length of `text`,
   * which redaction can shrink dramatically. Answering "how much did we not show you?" needs the
   * real number; the `text` marker is worded so the two can't be confused.
   */
  bytes: number;
}

/** The request as it actually went out — resolved, not as configured. */
export interface CapturedRequest {
  method: string;
  /** Absolute URL including the query string, redacted (a query param can hold an api key). */
  url: string;
  /** Lowercase header names → value or `[REDACTED]`. Sorted, so the capture is stable. */
  headers: Record<string, string>;
  body?: CapturedBody;
  /**
   * Why the body was NOT captured, when it wasn't. Set for a body that had a
   * `{{ $secrets.NAME }}` resolved into it: the substituted value is an opaque credential, so
   * neither key-name nor secret-shape scrubbing can be trusted to find it, and Tier-1 §4 says a
   * secret never enters Temporal history. Withholding is the only safe answer — but saying so
   * beats a silently missing field, which reads as "we captured nothing".
   */
  bodyWithheld?: string;
}

/** What came back. Absent when the failure happened before any response (DNS, timeout). */
export interface CapturedResponse {
  status: number;
  /** HTTP reason phrase ("Bad Request") — the thing #909 stopped showing INSTEAD of the body. */
  statusText?: string;
  headers: Record<string, string>;
  body?: CapturedBody;
}

/** The blob stored under the failure's `details[0].http`. */
export interface HttpFailureCapture {
  request: CapturedRequest;
  response?: CapturedResponse;
}

/** Loose shape of anything header-ish we might be handed: a plain record, a `Headers`, or
 *  nothing. Kept structural rather than `instanceof Headers` so it works on a fetch stub too. */
type HeadersLike =
  | Record<string, string>
  | { entries: () => Iterable<[string, string]> }
  | undefined
  | null;

function toEntries(h: HeadersLike): [string, string][] {
  if (!h) return [];
  try {
    if (typeof (h as { entries?: unknown }).entries === "function") {
      return Array.from(
        (h as { entries: () => Iterable<[string, string]> }).entries(),
      );
    }
    return Object.entries(h as Record<string, string>);
  } catch {
    // A Headers-like that misbehaves must not take down the failure path.
    return [];
  }
}

/**
 * Header names (lowercased, sorted, capped) with values kept ONLY for the allowlist.
 *
 * Pure — the caller's header object is never mutated. That matters: at every call site the
 * headers we are handed are the LIVE ones still attached to the in-flight request, and
 * `deepScrub` (the obvious reuse) redacts in place, which would corrupt them.
 */
export function redactHeaders(headers: HeadersLike): Record<string, string> {
  const out: Record<string, string> = {};
  const entries = toEntries(headers)
    .map(([k, v]) => [String(k).toLowerCase(), v] as [string, string])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, MAX_HEADERS);
  for (const [name, value] of entries) {
    if (!headerValueIsSafe(name)) {
      out[name] = REDACTED;
      continue;
    }
    // Even an allowlisted value goes through the shape scrubber: the allowlist is a human
    // judgement, and this costs nothing. Capped BEFORE scrubbing, never after — the scrubber's
    // patterns backtrack badly on long inputs (see MAX_PARSE_BYTES).
    const text = typeof value === "string" ? value : String(value ?? "");
    out[name] = redactString(text.slice(0, 200));
  }
  return out;
}

/** Serialize whatever a body is, without ever throwing (a cyclic object, a BigInt). */
function toText(body: unknown): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

/**
 * Scrub + truncate a body for storage.
 *
 * Two passes, because neither alone is enough:
 *   1. If the text parses as JSON, `deepScrub` the PARSED COPY by key name — that is what
 *      catches `{"headers":{"Authorization":"…"}}`, at any nesting depth and any casing.
 *      Parsing gives us a fresh object, so `deepScrub`'s in-place redaction can't reach the
 *      live body the caller is still reading (`describeApiError` runs on that same value).
 *   2. Then the text passes the credential-header killer and `redactString`, which catch
 *      secrets in a NON-JSON body (an HTML error page) and secret-SHAPED substrings
 *      (`ghp_…`, a JWT, a 64-hex key) that no key name would have flagged.
 *
 * Truncation sits BETWEEN the two — see MAX_PARSE_BYTES/TRUNCATION_SLACK for why. The text
 * passes only ever see ~2.5KB, which is both all we store and all the regexes can afford.
 */
export function captureBody(
  body: unknown,
  maxBytes = MAX_BODY_BYTES,
): CapturedBody | undefined {
  const raw = toText(body);
  if (raw === undefined || raw.length === 0) return undefined;

  let text = raw;
  if (raw.length <= MAX_PARSE_BYTES) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object") {
        text = JSON.stringify(deepScrub(parsed)) ?? raw;
      }
    } catch {
      // Not JSON (HTML, form-encoded, plain text) — the text passes below handle it.
    }
  }
  const overflowed = text.length > maxBytes;
  text = redactString(
    text
      .slice(0, maxBytes + TRUNCATION_SLACK)
      .replace(CREDENTIAL_IN_TEXT, `$1${REDACTED}`),
  );

  const bytes = raw.length;
  if (!overflowed) return { text, truncated: false, bytes };
  return {
    text: `${text.slice(0, maxBytes)}\n…[truncated to ${maxBytes} chars; the original body was ${bytes} bytes]`,
    truncated: true,
    bytes,
  };
}

/**
 * Build the capture stored on a failing node's `ApplicationFailure` details.
 *
 * Call this ONLY on a failure. There is no success path into it by design — see the module
 * header for why a captured payload has to be the exception, not the rule.
 */
export function captureHttpFailure(input: {
  method: string;
  url: string;
  requestHeaders?: HeadersLike;
  requestBody?: unknown;
  /** Set instead of capturing `requestBody` — see {@link CapturedRequest.bodyWithheld}. */
  requestBodyWithheld?: string;
  status?: number;
  statusText?: string;
  responseHeaders?: HeadersLike;
  responseBody?: unknown;
}): HttpFailureCapture {
  const request: CapturedRequest = {
    method: String(input.method ?? "").toUpperCase(),
    url: redactString(String(input.url ?? "").slice(0, MAX_URL)),
    headers: redactHeaders(input.requestHeaders),
  };
  if (input.requestBodyWithheld) {
    request.bodyWithheld = input.requestBodyWithheld;
  } else {
    const reqBody = captureBody(input.requestBody);
    if (reqBody) request.body = reqBody;
  }

  const capture: HttpFailureCapture = { request };
  // No status means we never got a response (DNS, TLS, timeout, egress block) — say nothing
  // rather than inventing a zero status the UI would render as a real one.
  if (typeof input.status === "number") {
    const response: CapturedResponse = {
      status: input.status,
      headers: redactHeaders(input.responseHeaders),
    };
    if (input.statusText) response.statusText = String(input.statusText);
    const resBody = captureBody(input.responseBody);
    if (resBody) response.body = resBody;
    capture.response = response;
  }
  return capture;
}
