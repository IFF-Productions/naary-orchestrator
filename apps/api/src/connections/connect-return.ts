/**
 * Where to bounce the browser after a connection callback (GitHub App install / OAuth consent).
 *
 * The provider redirects the user's browser to our @Public callback; instead of showing raw JSON
 * we 302 them back to the SPA's integrations page with a small status flag the UI can surface.
 *
 * The base is ALWAYS server-derived — `APP_BASE_URL`, else the first http(s) `CORS_ORIGINS` entry,
 * else empty (a same-origin RELATIVE redirect, which is correct in the tunnel topology where the
 * API and SPA share a host). It is NEVER taken from a request parameter, so this can't be turned
 * into an open redirect.
 */
function appBaseUrl(): string {
  const candidates = [
    process.env.APP_BASE_URL ?? "",
    ...(process.env.CORS_ORIGINS ?? "").split(","),
  ];
  for (const c of candidates) {
    const t = c.trim().replace(/\/+$/, "");
    if (/^https?:\/\//i.test(t)) return t;
  }
  return ""; // relative — same-origin as the callback
}

/** Build the SPA integrations return URL. `ok` ⇒ `?connected=1`; otherwise `?connect_error=<code>`
 *  (a coarse, non-sensitive reason — the real cause is logged server-side). `tab` selects the
 *  integrations sub-tab to land on. */
export function connectReturnUrl(opts: {
  ok: boolean;
  tab: string;
  error?: string;
}): string {
  const params = new URLSearchParams({ tab: opts.tab });
  if (opts.ok) params.set("connected", "1");
  else params.set("connect_error", opts.error || "1");
  return `${appBaseUrl()}/app/integrations?${params.toString()}`;
}
