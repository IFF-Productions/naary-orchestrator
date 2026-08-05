import { ScimError } from "./scim.errors";

/**
 * SCIM filters (RFC 7644 §3.4.2.2) are a whole expression grammar — `and`/`or`/`not`,
 * grouping, `pr`/`co`/`sw`/`gt`, attribute paths. We implement exactly ONE production:
 *
 *     userName eq "someone@example.com"
 *
 * because that is the only filter an IdP issues on the provisioning path (it is how Okta and
 * Entra ask "do you already have this user?" before deciding to create them), and because a
 * general filter parser on an anonymous-until-authenticated endpoint is a ReDoS and a
 * query-injection surface for a capability nobody is asking for. Anything else is a 400
 * `invalidFilter`, which is a documented SCIM outcome an IdP handles — NOT a silent
 * "return everything", which would be a filter bypass dressed as leniency.
 *
 * The regex is anchored, has no nested quantifier, and bounds the value length, so it cannot
 * backtrack pathologically (the repo's ReDoS guard rule).
 */
const USERNAME_EQ = /^\s*userName\s+eq\s+"([^"]{1,320})"\s*$/i;

/** Parse a `filter` query param. `undefined`/empty ⇒ no filter (list everything in the
 *  tenant). Returns the lowercased userName to match, or throws a SCIM 400. */
export function parseScimFilter(filter?: string): { userName: string } | null {
  const raw = (filter ?? "").trim();
  if (raw.length === 0) return null;
  const m = USERNAME_EQ.exec(raw);
  if (!m) {
    throw ScimError.invalidFilter(
      'Only filters of the form `userName eq "value"` are supported.',
    );
  }
  return { userName: m[1].trim().toLowerCase() };
}

/** Pagination is 1-BASED in SCIM (`startIndex`), unlike every other list in this API.
 *  Out-of-range/garbage values clamp rather than error, per RFC 7644 §3.4.2.4. */
export const MAX_SCIM_PAGE = 200;
export const DEFAULT_SCIM_PAGE = 100;

export function parsePaging(
  startIndex?: string | number,
  count?: string | number,
): { start: number; count: number } {
  const s = Math.trunc(Number(startIndex));
  const c = Math.trunc(Number(count));
  return {
    start: Number.isFinite(s) && s >= 1 ? s : 1,
    // count=0 is legal and means "tell me totalResults without the rows".
    count:
      Number.isFinite(c) && c >= 0
        ? Math.min(c, MAX_SCIM_PAGE)
        : DEFAULT_SCIM_PAGE,
  };
}
