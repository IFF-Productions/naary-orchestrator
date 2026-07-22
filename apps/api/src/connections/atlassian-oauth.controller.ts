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
  completeAtlassianConsent,
  startAtlassianConsent,
} from "@naary/connections";
import type { Response } from "express";
import { Public } from "../auth/public.decorator";
import { ApiEndpoint } from "../swagger/api-decorators";
import { connectReturnUrl } from "./connect-return";
import { OAuthStartResponse } from "./connection.response";

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
    const redirectUri =
      process.env.ATLASSIAN_OAUTH_REDIRECT_URI ??
      `http://localhost:${process.env.PORT ?? 3000}/atlassian/oauth/callback`;
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
