import { json } from "express";
import type { NextFunction, Request, RequestHandler, Response } from "express";

/** RFC 7644 §3.1 — SCIM's own media type. Okta and Entra both send it on writes. */
export const SCIM_CONTENT_TYPE = "application/scim+json";

/** The one path prefix this parser is mounted on — `ScimController`'s `@Controller("scim/v2")`. */
export const SCIM_BASE_PATH = "/scim/v2";

/**
 * Parse `application/scim+json` request bodies (#1075 slice 2).
 *
 * Nest's built-in parser is `express.json()`, which matches `application/json` and NOTHING
 * else — a `+json` suffix is not a substring match. So without this, an IdP POSTing a
 * perfectly valid SCIM payload arrives with an EMPTY body and every create 400s with "a SCIM
 * User payload is required", which reads like a payload bug and is not one. This is the kind
 * of interop failure that only shows up against a real IdP, so it is fixed here and asserted
 * over a real HTTP round trip in apps/api/test/scim.http.spec.ts.
 *
 * Registered as its own middleware rather than by widening the global parser's `type`: every
 * other route should keep rejecting a body whose type it did not ask for, and body-parser
 * skips a request another parser has already consumed, so ordering is not delicate.
 *
 * MOUNTED ON {@link SCIM_BASE_PATH} ONLY — use {@link mountScimBodyParser}, never a bare
 * `app.use(scimBodyParser())`. A global mount would teach EVERY route in the API to accept and
 * parse `application/scim+json`, which is the opposite of the paragraph above: it widens the
 * request surface of ~168 paths so that one door can talk to an IdP. Only /scim/v2 speaks SCIM.
 *
 * ── THE WRAPPER IS LOAD-BEARING. DO NOT RETURN `json(...)` DIRECTLY. ─────────────────────
 * Nest decides whether to install its OWN body parsers by looking for a middleware layer whose
 * handler FUNCTION IS NAMED `jsonParser` (`ExpressAdapter.isMiddlewareApplied`, called from
 * `registerParserMiddleware` during `app.init()`), and `express.json()` returns a function with
 * exactly that name. Registering it bare from `main.ts` — which runs before `init()` — would
 * therefore make Nest skip its own parser and leave THIS one, matching `application/scim+json`
 * only, as the API's single JSON parser: every `application/json` body in the product would
 * silently arrive empty. Wrapping it under a different name means Nest still installs its own
 * (rawBody-aware) parser and both coexist. `scim.http.spec.ts` asserts both content types
 * against a server built in the same order main.ts builds it, so a regression here is red.
 * ────────────────────────────────────────────────────────────────────────────────────────
 *
 * The 100kb default limit is deliberate and unchanged — a User resource is a small document,
 * and this endpoint is authenticated by a bearer but is still an internet-facing door.
 */
export function scimBodyParser(): RequestHandler {
  const parse = json({ type: SCIM_CONTENT_TYPE });
  return function scimJsonParser(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    parse(req, res, next);
  };
}

/** The minimum of an INestApplication this needs — kept structural so the spec and main.ts
 *  can call the SAME function without the spec importing the whole app. */
interface PathMountable {
  use(path: string, handler: RequestHandler): unknown;
}

/**
 * Mount the SCIM body parser on /scim/v2 and nowhere else.
 *
 * ONE function, called by both `main.ts` and `apps/api/test/scim.http.spec.ts`, because the
 * spec's entire reason to exist is catching an ordering/mounting bug in main.ts — and a spec
 * that builds its app differently from main.ts cannot do that. If the mount ever needs to
 * change, it changes here and both move together.
 *
 * MUST be called before `app.init()` (main.ts's ordering), so the spec exercises the same
 * interleaving with Nest's own parser registration.
 */
export function mountScimBodyParser(app: PathMountable): void {
  app.use(SCIM_BASE_PATH, scimBodyParser());
}
