/**
 * Thin HTTP client over the public /api/v1 surface.
 *
 * Builds `${apiUrl}/api/v1/<path>`, sets `Authorization: Bearer <token>` and, when an
 * environment is selected, `X-Environment-Id: <env>`. On a non-2xx it throws a friendly
 * ApiError carrying the status and the server's error message (parsed from the JSON body
 * when present). `fetch` is injectable so the URL/header/error logic is unit-testable
 * without a real network.
 */

import type { ResolvedConfig } from "./config";

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText?: string;
  text: () => Promise<string>;
}>;

export class ApiError extends Error {
  readonly status: number;
  readonly body?: unknown;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/** Thrown when a command needs auth but no token is resolvable. */
export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export interface RequestOptions {
  method?: string;
  /** JSON-serializable request body. */
  body?: unknown;
  /** Query params appended to the URL (undefined values skipped). */
  query?: Record<string, string | number | undefined>;
  /** Require a token; throw AuthError if none is set. Default true. */
  requireAuth?: boolean;
}

/**
 * `/api` is a PROXY path, not the API's own. Three facts fix this:
 *   1. the controllers are `@Controller("v1/runs")` etc. — the API serves `/v1/...`;
 *   2. `apps/api/src/main.ts` sets no global prefix, so nothing adds `/api` server-side;
 *   3. `apps/web/nginx.conf` (and the vite dev proxy) rewrite `^/api/(.*)` → `/$1`.
 * So `apiUrl` must be an origin sitting BEHIND that rewrite — the web origin, not the API's
 * own port. Pointed straight at the API this prefix is dead weight and every call 404s.
 */
const API_PREFIX = "/api/v1";

/** Join base url + /api/v1 + path, normalizing slashes. */
export function buildUrl(
  apiUrl: string,
  path: string,
  query?: Record<string, string | number | undefined>,
): string {
  const base = apiUrl.replace(/\/+$/, "");
  const rel = path.startsWith("/") ? path : `/${path}`;
  let url = `${base}${API_PREFIX}${rel}`;
  if (query) {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === "") continue;
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    }
    if (parts.length) url += `?${parts.join("&")}`;
  }
  return url;
}

/** Build the request headers for a config (auth + optional environment). */
export function buildHeaders(
  config: ResolvedConfig,
  hasBody: boolean,
): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (config.token) headers["Authorization"] = `Bearer ${config.token}`;
  if (config.env) headers["X-Environment-Id"] = config.env;
  if (hasBody) headers["Content-Type"] = "application/json";
  return headers;
}

export class ApiClient {
  constructor(
    private readonly config: ResolvedConfig,
    private readonly fetchImpl: FetchLike = globalThis.fetch as FetchLike,
  ) {}

  async request<T = unknown>(
    path: string,
    opts: RequestOptions = {},
  ): Promise<T> {
    const requireAuth = opts.requireAuth ?? true;
    if (requireAuth && !this.config.token) {
      throw new AuthError(
        "No API token configured. Run `naary auth login --token <nry_...>` or set NAARY_TOKEN.",
      );
    }

    const url = buildUrl(this.config.apiUrl, path, opts.query);
    const hasBody = opts.body !== undefined;
    const res = await this.fetchImpl(url, {
      method: opts.method ?? "GET",
      headers: buildHeaders(this.config, hasBody),
      body: hasBody ? JSON.stringify(opts.body) : undefined,
    });

    const raw = await res.text();
    if (!res.ok) {
      throw toApiError(res.status, res.statusText, raw);
    }
    if (!raw) return undefined as T;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return raw as unknown as T;
    }
  }
}

/** Build a friendly ApiError from a non-2xx response body. */
export function toApiError(
  status: number,
  statusText: string | undefined,
  raw: string,
): ApiError {
  let body: unknown;
  let serverMessage: string | undefined;
  try {
    body = raw ? JSON.parse(raw) : undefined;
    if (body && typeof body === "object") {
      const b = body as Record<string, unknown>;
      const msg = b.message ?? b.error;
      if (Array.isArray(msg)) serverMessage = msg.join("; ");
      else if (typeof msg === "string") serverMessage = msg;
    }
  } catch {
    if (raw) serverMessage = raw.slice(0, 500);
  }

  const hint =
    status === 401
      ? " — check your token (`naary auth status`)."
      : status === 403
        ? " — your token lacks permission for this resource."
        : status === 404
          ? " — not found."
          : "";
  const detail = serverMessage ? `: ${serverMessage}` : "";
  return new ApiError(
    status,
    `Request failed (HTTP ${status}${statusText ? ` ${statusText}` : ""})${detail}${hint}`,
    body,
  );
}
