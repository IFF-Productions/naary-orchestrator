import {
  Controller,
  Get,
  Logger,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiResponse } from "@nestjs/swagger";
import {
  ConnectionService,
  atlassianOAuthConfig,
  completeAtlassianConsent,
  startAtlassianConsent,
} from "@naary/connections";
import type { Response } from "express";
import { Public } from "../auth/public.decorator";
import { ApiEndpoint } from "../swagger/api-decorators";
import { connectReturnUrl } from "./connect-return";
import {
  AtlassianOAuthConfigResponse,
  OAuthStartResponse,
} from "./connection.response";
import { atlassianOauthRedirectUri } from "../config";

/**
 * Atlassian OAuth 2.0 3LO connect flow (docs/design/APP-AUTH.md §3b). Parallel to
 * OAuthController but FIXED-CLIENT: instead of `.well-known` discovery + DCR off the
 * connection's serverUrl, it uses our platform Atlassian app (`ATLASSIAN_OAUTH_*` env) with
 * fixed authorize/token endpoints, an explicit `audience`, and a post-exchange cloudId
 * resolution. Connection-first (like OAuthController.start): the atlassian/oauth connection
 * already exists; `start` returns the authorize URL, the callback stores the refresh grant.
 */
@Controller()
export class AtlassianOAuthController {
  private readonly logger = new Logger(AtlassianOAuthController.name);
  constructor(private readonly connections: ConnectionService) {}

  /**
   * What an admin needs to register the app at developer.atlassian.com — so the callback URL is
   * COPIED from us rather than retyped and hoped to match.
   *
   * This exists because of a real 20-minute debug: Atlassian answers a mismatched redirect with
   * "The app's callback URL is invalid", which names neither the value we sent nor the value it
   * expected. The only way to see ours was to URL-decode the authorize URL out of the browser's
   * address bar. Two systems must agree on one string exactly; the fix is to let one of them be
   * the source.
   *
   * NOT a secret. The redirect URI is a public URL that appears in every authorize request and in
   * the user's address bar. `configured` is a BOOLEAN over the client id/secret — never the values
   * — so this answers "can I connect?" without becoming a credential read. Same posture as the
   * SAML SP metadata route, which echoes SP config for an IdP admin for the same reason.
   */
  @ApiBearerAuth("bearer")
  @ApiEndpoint({
    summary:
      "Atlassian 3LO setup values (callback URL + whether the app is configured)",
    ok: AtlassianOAuthConfigResponse,
  })
  @Get("tenants/:id/connections/atlassian/oauth/config")
  oauthConfig(@Param("id") _tenantId: string): {
    redirectUri: string;
    configured: boolean;
    scopes: string[];
  } {
    const cfg = atlassianOAuthConfig();
    return {
      redirectUri: atlassianOauthRedirectUri(),
      // Null ⇒ ATLASSIAN_OAUTH_CLIENT_ID/_SECRET are unset, so `start` would refuse. Telling the
      // user that BEFORE they fill the form beats a failure after they have committed to it.
      configured: cfg !== null,
      // The scopes THIS deployment will actually request — not the ones in the source. They are
      // overridable by `ATLASSIAN_OAUTH_SCOPES`, and when that is set the built-in defaults are
      // dead: a scope added in a release simply never reaches the authorize URL. That is invisible
      // from outside and surfaces as a 401 on whichever action needed it, so the effective set is
      // reported here alongside the redirect URI, which exists for exactly the same reason.
      scopes: cfg?.scopes ?? [],
    };
  }

  @ApiBearerAuth("bearer")
  @ApiEndpoint({
    summary: "Start Atlassian (Jira/Confluence) OAuth 3LO consent",
    description:
      "Returns the auth.atlassian.com authorize URL for the browser to begin interactive consent.",
    ok: OAuthStartResponse,
    notFound: true,
  })
  @Post("tenants/:id/connections/:connectionId/atlassian/oauth/start")
  async start(
    @Param("id") tenantId: string,
    @Param("connectionId") connectionId: string,
  ): Promise<{ authorizeUrl: string }> {
    const conn = await this.connections.getById(tenantId, connectionId);
    if (!conn) throw new NotFoundException("Unknown connection");
    // The callback is @Public and can't send X-Environment-Id, so consent stores the refresh
    // token in the connection's OWN env — the env rides in the (encoded) state. The redirect
    // URI MUST match the one registered on the Atlassian app (…/atlassian/oauth/callback).
    const redirectUri = atlassianOauthRedirectUri();
    return startAtlassianConsent({
      tenantId,
      environmentId: conn.environmentId,
      connectionId,
      redirectUri,
    });
  }

  @ApiOperation({
    summary: "Atlassian OAuth callback (provider redirect target)",
    description:
      "Public: Atlassian redirects the BROWSER here with a single-use `state` and `code`; " +
      "exchanges the code, persists the encrypted refresh token, resolves the site cloudId, " +
      "then 302-redirects back to the SPA integrations page (`?connected=1` on success, " +
      "`?connect_error=…` otherwise).",
  })
  @ApiResponse({
    status: 302,
    description: "Redirect to the SPA integrations page.",
  })
  @Public() // provider redirect target; the single-use `state` is its credential
  @Get("atlassian/oauth/callback")
  async callback(
    @Res() res: Response,
    @Query("state") state: string,
    @Query("code") code: string,
    @Query("error") error?: string,
  ): Promise<void> {
    // Browser-facing: 302 back to the SPA rather than rendering JSON / a 500. A user-denied
    // consent (`?error=access_denied`) or a replayed/expired single-use `state` is benign;
    // catching it here keeps it out of Sentry as an unhandled 500.
    try {
      if (error) throw new Error(`Atlassian consent error: ${error}`);
      await completeAtlassianConsent({ state, code });
      // Land back on the Apps tab (where the atlassian connection lives — AppsTab
      // APP_CONNECTION_TYPES), matching the GitHub App callback.
      res.redirect(connectReturnUrl({ ok: true, tab: "apps" }));
    } catch (err) {
      this.logger.warn(
        `Atlassian OAuth callback failed: ${(err as Error).message}`,
      );
      res.redirect(
        connectReturnUrl({ ok: false, tab: "apps", error: "atlassian" }),
      );
    }
  }
}
