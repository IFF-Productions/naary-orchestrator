import {
  Body,
  Controller,
  Get,
  Logger,
  Param,
  Post,
  Res,
} from "@nestjs/common";
import { ApiOperation, ApiResponse } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Response } from "express";
import { Public } from "../auth/public.decorator";
import { appBaseUrl } from "../connections/connect-return";
import { spMetadataXml } from "./saml";
import { SSO_TOKEN_PREFIX } from "./sso-session.service";
import { SsoLoginError, SsoService, ssoConfig } from "./sso.service";

/**
 * The browser-facing SAML surface (design SAML-SSO.md, #455). All three routes are
 * `@Public()` — an IdP POST carries no bearer and an SP metadata document is public by
 * definition. Because `@Public()` skips the guard (and therefore the early-access allowlist
 * and `REQUIRE_MFA`), `SsoService` re-asserts BOTH policies itself before writing anything.
 *
 * House rule for browser-facing endpoints (connections/connect-return.ts): never render raw
 * JSON, never 500 — every outcome is a 302 with a coarse, non-sensitive code, and the real
 * cause is logged server-side.
 */
@Controller("sso")
export class SsoController {
  private readonly logger = new Logger(SsoController.name);
  constructor(private readonly sso: SsoService) {}

  /** Where the SPA lands. Always SERVER-derived (never a request parameter or RelayState) —
   *  the open-redirect rule from connect-return.ts. */
  private returnUrl(fragment?: string, error?: string): string {
    const base = `${appBaseUrl()}/app`;
    if (error) return `${base}?sso_error=${encodeURIComponent(error)}`;
    return `${base}#${fragment ?? ""}`;
  }

  @ApiOperation({
    summary: "SAML SP metadata",
    description:
      "The XML an IdP admin imports: our entity id, the ACS URL (HTTP-POST binding) and the supported NameID formats. Public and non-secret.",
  })
  @ApiResponse({ status: 200, description: "SP metadata XML." })
  @Public()
  @Get("metadata")
  metadata(@Res() res: Response): void {
    const config = ssoConfig();
    // `this.sso.enabled` as well as the config: a short/absent SSO_SESSION_SECRET leaves logins
    // disabled while the SP config is fine, and serving valid metadata in that state invites an
    // IdP admin to configure against an instance that will then refuse every login. Fail at
    // configuration time instead. This route is read by a human admin, not a browser mid-redirect,
    // so it says so plainly (still leaking nothing).
    if (!config || !this.sso.enabled) {
      res.status(503).type("text/plain").send("SAML SSO is not configured");
      return;
    }
    res.type("application/xml").send(spMetadataXml(config));
  }

  @ApiOperation({
    summary: "SAML assertion consumer service (ACS)",
    description:
      "The IdP POSTs a signed assertion here (form-urlencoded SAMLResponse). On success, redirects to the SPA with a short-lived session token in the URL FRAGMENT; on any failure, redirects with a coarse sso_error code.",
  })
  @ApiResponse({ status: 302, description: "Redirect to the SPA." })
  @Public()
  // Unauthenticated + does signature verification (CPU), so bound it per IP. The global
  // client-IP throttler applies too (#596).
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post("saml/acs")
  async acs(
    @Res() res: Response,
    @Body() body: { SAMLResponse?: string; RelayState?: string },
  ): Promise<void> {
    try {
      // RelayState is deliberately IGNORED: echoing a client-supplied return target is an
      // open redirect. The landing page is server-derived.
      const result = await this.sso.consumeAssertion(body?.SAMLResponse ?? "");
      // Fragment, not query: fragments are not sent to servers, so the session stays out of
      // access logs, referrers and proxy logs. (A one-time-code exchange is the deferred
      // hardening — see SAML-SSO.md.)
      res.redirect(
        this.returnUrl(
          `sso_token=${encodeURIComponent(result.token)}&workspace=${encodeURIComponent(
            result.tenantId,
          )}`,
        ),
      );
    } catch (err) {
      const code = err instanceof SsoLoginError ? err.code : "sso_failed";
      // The MESSAGE (which may name the connection/domain) goes to the log only; the browser
      // gets the coarse code.
      this.logger.warn(
        `SAML ACS rejected: ${err instanceof Error ? err.message : String(err)}`,
      );
      res.redirect(this.returnUrl(undefined, code));
    }
  }

  @ApiOperation({
    summary: "IdP-initiated login entry point",
    description:
      "Redirects to the IdP's SSO URL for this connection slug. Convenience only — the flow is IdP-initiated, so no AuthnRequest is generated.",
  })
  @ApiResponse({ status: 302, description: "Redirect to the IdP." })
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  // Declared AFTER /metadata and /saml/acs on purpose: Nest matches in declaration order, so a
  // greedy `:slug` first would swallow them.
  @Get(":slug")
  async start(
    @Res() res: Response,
    @Param("slug") slug: string,
  ): Promise<void> {
    try {
      res.redirect(await this.sso.ssoUrlForSlug(slug));
    } catch (err) {
      const code = err instanceof SsoLoginError ? err.code : "sso_failed";
      this.logger.warn(
        `SAML start rejected for slug=${slug}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      res.redirect(this.returnUrl(undefined, code));
    }
  }
}

/** Exported for the tests that assert the guard/token contract stays in sync. */
export const SSO_BEARER_PREFIX = SSO_TOKEN_PREFIX;
