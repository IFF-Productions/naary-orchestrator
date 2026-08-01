/**
 * DSN parsing shared by every caller that has to SSRF-check a database host before connecting.
 *
 * This lived in the worker's `sql` activity until the API needed the identical parse for
 * authoring-time schema introspection (#1004). It is here rather than duplicated because the next
 * SSRF audit fix must land in ONE place — a second copy is a copy that silently keeps the old bug.
 */

/**
 * Best-effort host extraction from a DSN — a URL (postgres:// / mssql://) or an mssql key=value
 * connection string (`Server=host,port;…`). null when unparseable (the driver will then fail on a
 * malformed DSN anyway).
 */
export function dsnHost(dsn: string): string | null {
  try {
    const u = new URL(dsn);
    if (u.hostname) return u.hostname.replace(/^\[|\]$/g, "");
  } catch {
    /* not a URL — try the mssql key=value form below */
  }
  const m = dsn.match(
    /(?:^|;)\s*(?:server|data source|address|addr|network address)\s*=\s*([^;]+)/i,
  );
  if (!m) return null;
  // strip a `tcp:` prefix, an instance suffix (host\INSTANCE), and a ,port suffix.
  const host = m[1]
    .trim()
    .replace(/^tcp:/i, "")
    .split("\\")[0]
    .split(",")[0]
    .trim();
  return host || null;
}
