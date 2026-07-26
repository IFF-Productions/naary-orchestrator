/**
 * "Where did I come from?" for the full-screen canvas.
 *
 * `/app/canvas` is a SIBLING of `/app` (router.tsx) — deliberately, so the canvas gets the
 * whole viewport — which means it renders outside AppShell and has no nav rail. Its only way
 * back used to be a hardcoded `navigate("/app")`, dumping a user who opened the editor from a
 * run or a workflow page onto the Overview screen instead of back where they were.
 *
 * The return target travels as a `?from=` SEARCH PARAM rather than router state because some
 * entry points build the canvas URL as a plain string (`catalog-data.ts`), which can't carry
 * state, and because a param survives a reload.
 *
 * A return target that comes off the URL is UNTRUSTED input, so it is validated to an in-app
 * path before it is ever handed to navigate().
 */

/** Search-param name carrying the canvas's return target. */
export const RETURN_PARAM = "from";

/** Where the canvas goes back to when it wasn't told (today's behaviour). */
export const CANVAS_HOME = "/app";

/** Longest `?from=` we'll consider — a return path, not a payload. */
const MAX_RETURN_LENGTH = 512;

/**
 * Validate an untrusted `?from=` value, returning a safe in-app path or null.
 *
 * Accepts ONLY paths under `/app`. That rejects, in order of how much they'd matter:
 *   · `https://evil.test/...` and `//evil.test` — an off-site redirect (the protocol-relative
 *     form is the one that looks like a path but isn't).
 *   · `/auth`, `/f/:id` — in-app but not somewhere "back" should ever land.
 *   · anything containing `..` — the browser normalizes traversal before we'd see it, so
 *     `/app/../x` would escape the `/app` prefix this function just checked for.
 *   · a backslash, which some parsers fold to `/`.
 */
export function safeReturnTo(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!value || value.length > MAX_RETURN_LENGTH) return null;
  if (value.includes("\\") || value.includes("..")) return null;
  // Must be an absolute in-app path under /app, and NOT protocol-relative ("//host").
  if (!/^\/app(?:[/?#]|$)/.test(value)) return null;
  return value;
}

/**
 * Build a canvas URL that remembers where the user was.
 * `to` is the canvas URL (may already carry `?key=`), `from` the current in-app location.
 */
export function canvasTo(to: string, from: string): string {
  const safe = safeReturnTo(from);
  if (!safe) return to;
  const sep = to.includes("?") ? "&" : "?";
  return `${to}${sep}${RETURN_PARAM}=${encodeURIComponent(safe)}`;
}

/**
 * Carry the return target forward when the canvas REWRITES its own search params.
 *
 * The canvas replaces its params outright when you switch workflows, start a new one, or
 * finish importing (`setSearchParams({ key })`). Passing a fresh object drops every other
 * param — so without this, `from` silently evaporates the first time a user switches
 * workflows and the back control reverts to /app mid-session.
 */
export function withReturn(
  params: Record<string, string>,
  from: string | null | undefined,
): Record<string, string> {
  const safe = safeReturnTo(from);
  return safe ? { ...params, [RETURN_PARAM]: safe } : params;
}

/**
 * A short human label for the back control, so it reads "Back to Runs" instead of a generic
 * arrow. Deliberately coarse: the SECTION is what a user recognises, and a label that tried to
 * name the specific record would need data this module doesn't have.
 */
export function returnLabel(path: string | null | undefined): string {
  const safe = safeReturnTo(path);
  if (!safe) return "Back to Naary";
  const segment = safe
    .slice("/app".length)
    .replace(/^\//, "")
    .split(/[/?#]/)[0];
  const SECTIONS: Record<string, string> = {
    "": "Overview",
    runs: "Runs",
    workflows: "Workflows",
    automations: "Automations",
    activity: "Activity",
    approvals: "Approvals",
    schedules: "Schedules",
    templates: "Templates",
    catalog: "Node catalog",
    integrations: "Integrations",
    observability: "Observability",
    billing: "Billing",
    team: "Team",
    groups: "Groups",
    company: "Company",
    workers: "Workers",
    settings: "Settings",
    "build-ai": "Build with AI",
    "connect-ai": "Connect AI",
  };
  const name = SECTIONS[segment];
  return name ? `Back to ${name}` : "Back to Naary";
}
