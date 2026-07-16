import type { HttpMethod, HttpRequestNodeConfig } from "./types";

/** The httpRequest config a cURL maps to (the authoring-relevant subset), plus any warnings. */
export interface CurlImportResult {
  config: Pick<
    HttpRequestNodeConfig,
    "method" | "url" | "headers" | "query"
  > & {
    body?: unknown;
  };
  /** Non-fatal notes to surface in the UI (e.g. auth stripped, unsupported method clamped). */
  warnings: string[];
}

const SUPPORTED_METHODS: ReadonlySet<string> = new Set<HttpMethod>([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

/** Header names that carry auth material — NEVER put these in the graph (Tier-1 rule 4); the user
 *  wires a connection instead. Compared case-insensitively. */
const AUTH_HEADERS: ReadonlySet<string> = new Set(["authorization", "cookie"]);

/**
 * Tokenize a shell-ish cURL command: honors single quotes (literal), double quotes (with `\`
 * escapes), backslash escapes, and `\`+newline line continuations. Not a full shell — no variable
 * expansion, subshells, or pipes (a pasted cURL doesn't need them).
 */
function tokenize(s: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let inTok = false;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") {
      const next = s[i + 1];
      if (next === "\n" || next === "\r") {
        // line continuation — swallow the backslash + newline
        i += next === "\r" && s[i + 2] === "\n" ? 3 : 2;
        continue;
      }
      if (next !== undefined) {
        cur += next;
        inTok = true;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (c === "'") {
      inTok = true;
      i += 1;
      while (i < s.length && s[i] !== "'") {
        cur += s[i];
        i += 1;
      }
      i += 1; // skip closing quote
      continue;
    }
    if (c === '"') {
      inTok = true;
      i += 1;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === "\\" && s[i + 1] !== undefined) {
          cur += s[i + 1];
          i += 2;
          continue;
        }
        cur += s[i];
        i += 1;
      }
      i += 1; // skip closing quote
      continue;
    }
    if (/\s/.test(c)) {
      if (inTok) {
        tokens.push(cur);
        cur = "";
        inTok = false;
      }
      i += 1;
      continue;
    }
    cur += c;
    inTok = true;
    i += 1;
  }
  if (inTok) tokens.push(cur);
  return tokens;
}

/** Split "Key: Value" (or "Key:Value"). Returns null for a malformed header. */
function splitHeader(raw: string): [string, string] | null {
  const idx = raw.indexOf(":");
  if (idx <= 0) return null;
  return [raw.slice(0, idx).trim(), raw.slice(idx + 1).trim()];
}

/** No-arg cURL flags we simply ignore (transport/verbosity/etc. — no effect on the request shape). */
const IGNORED_NOARG: ReadonlySet<string> = new Set([
  "--compressed",
  "-s",
  "--silent",
  "-i",
  "--include",
  "-k",
  "--insecure",
  "-L",
  "--location",
  "-v",
  "--verbose",
  "-#",
  "--progress-bar",
  "-f",
  "--fail",
  "-S",
  "--show-error",
  "-g",
  "--globoff",
]);

/** Flags that take ONE argument we don't map — skip the flag and its value. */
const IGNORED_WITH_ARG: ReadonlySet<string> = new Set([
  "-o",
  "--output",
  "-w",
  "--write-out",
  "--connect-timeout",
  "--retry",
]);

/**
 * Parse a `curl …` command into an httpRequest node config. Pure + total (throws only when the input
 * has no URL at all). Security: any `Authorization`/`Cookie` header and `-u` basic-auth are STRIPPED
 * with a warning — auth belongs on a connection, never in the graph/history (Tier-1 rule 4).
 */
export function parseCurl(input: string): CurlImportResult {
  const warnings: string[] = [];
  const tokens = tokenize(input.trim());
  if (tokens[0] === "curl") tokens.shift();

  let method: string | undefined;
  let url: string | undefined;
  const headers: Record<string, string> = {};
  const dataParts: string[] = [];
  let asGet = false;
  let jsonContentType = false;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    switch (t) {
      case "-X":
      case "--request":
        method = tokens[++i]?.toUpperCase();
        break;
      case "-H":
      case "--header": {
        const parsed = splitHeader(tokens[++i] ?? "");
        if (!parsed) break;
        const [name, value] = parsed;
        if (AUTH_HEADERS.has(name.toLowerCase())) {
          warnings.push(
            `Dropped the "${name}" header — configure a connection for auth (secrets never live in a workflow).`,
          );
          break;
        }
        if (
          name.toLowerCase() === "content-type" &&
          value.toLowerCase().includes("application/json")
        ) {
          jsonContentType = true;
        }
        headers[name] = value;
        break;
      }
      case "-d":
      case "--data":
      case "--data-raw":
      case "--data-binary":
      case "--data-ascii":
      case "--data-urlencode":
        dataParts.push(tokens[++i] ?? "");
        break;
      case "-G":
      case "--get":
        asGet = true;
        break;
      case "-u":
      case "--user":
        i++; // consume the credentials, never store them
        warnings.push(
          "Dropped `-u` basic-auth credentials — configure a connection for auth instead.",
        );
        break;
      case "-b":
      case "--cookie":
        i++; // consume + drop — cookies are session/auth material, not for the graph
        warnings.push(
          "Dropped `-b`/`--cookie` — cookies are session material and aren't imported.",
        );
        break;
      case "-A":
      case "--user-agent":
        headers["User-Agent"] = tokens[++i] ?? "";
        break;
      case "-e":
      case "--referer":
        headers.Referer = tokens[++i] ?? "";
        break;
      case "--url":
        url = tokens[++i];
        break;
      default:
        if (IGNORED_WITH_ARG.has(t)) {
          i++; // skip the flag's argument too
        } else if (IGNORED_NOARG.has(t)) {
          // no-op
        } else if (t.startsWith("-")) {
          // Unknown flag — skip it alone. (We can't know its arity; erring toward keeping the URL.)
          warnings.push(`Ignored unrecognized flag "${t}".`);
        } else if (!url) {
          url = t; // the sole positional argument is the URL
        }
        break;
    }
  }

  if (!url) {
    throw new Error("No URL found in the cURL command.");
  }

  // Default method: cURL uses POST when there's a body and no explicit -X (unless -G moves it to query).
  if (!method) method = dataParts.length > 0 && !asGet ? "POST" : "GET";
  if (!SUPPORTED_METHODS.has(method)) {
    warnings.push(`Method ${method} isn't supported — defaulting to GET.`);
    method = "GET";
  }

  // Split any query string off the URL into the editable `query` map (keeps the node's URL clean).
  const query: Record<string, string> = {};
  let cleanUrl = url;
  const qIdx = url.indexOf("?");
  if (qIdx >= 0) {
    cleanUrl = url.slice(0, qIdx);
    for (const pair of url.slice(qIdx + 1).split("&")) {
      if (!pair) continue;
      const eq = pair.indexOf("=");
      const k = decodeURIComponentSafe(eq >= 0 ? pair.slice(0, eq) : pair);
      const v = eq >= 0 ? decodeURIComponentSafe(pair.slice(eq + 1)) : "";
      query[k] = v;
    }
  }

  const dataJoined = dataParts.join("&");

  // -G: the data is query params, not a body.
  if (asGet && dataJoined) {
    for (const pair of dataJoined.split("&")) {
      if (!pair) continue;
      const eq = pair.indexOf("=");
      const k = decodeURIComponentSafe(eq >= 0 ? pair.slice(0, eq) : pair);
      const v = eq >= 0 ? decodeURIComponentSafe(pair.slice(eq + 1)) : "";
      query[k] = v;
    }
  }

  let body: unknown;
  if (!asGet && dataJoined) {
    // JSON body → parse to an object so the inspector shows structured fields; otherwise keep the
    // raw string (form-encoded, plain text, …).
    if (jsonContentType || looksLikeJson(dataJoined)) {
      try {
        body = JSON.parse(dataJoined);
      } catch {
        body = dataJoined; // declared JSON but not valid — keep raw so nothing is lost
      }
    } else {
      body = dataJoined;
    }
  }

  // A GET can't carry a body — the httpRequest activity ignores it — so importing one would show a
  // body in the UI that's never sent. Drop it with a warning (use -G to send data as query params).
  if (method === "GET" && body !== undefined) {
    warnings.push(
      "GET requests don't send a body — dropped it. Use `-G` to send data as query params instead.",
    );
    body = undefined;
  }

  const config: CurlImportResult["config"] = {
    method: method as HttpMethod,
    url: cleanUrl,
  };
  if (Object.keys(headers).length > 0) config.headers = headers;
  if (Object.keys(query).length > 0) config.query = query;
  if (body !== undefined) config.body = body;

  return { config, warnings };
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
}

function looksLikeJson(s: string): boolean {
  const t = s.trim();
  return (
    (t.startsWith("{") && t.endsWith("}")) ||
    (t.startsWith("[") && t.endsWith("]"))
  );
}
