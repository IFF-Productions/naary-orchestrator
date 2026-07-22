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
  completeConsent,
  startConsent,
} from "@naary/connections";
import type { Response } from "express";
import { Public } from "../auth/public.decorator";
import { ApiEndpoint } from "../swagger/api-decorators";
import { reportConnectCallbackFailure } from "./connect-callback-error";
import { connectReturnUrl } from "./connect-return";
import { OAuthStartResponse } from "./connection.response";

/**
 * Interactive OAuth consent (B3) — runs once in the web app. `start` returns the
 * authorize URL for the browser; the provider redirects back to `callback`, which
 * exchanges the code and persists the encrypted refresh token. The activity then
 * refreshes non-interactively (B4). Browser consent is deferred-live this slice.
 */
@Controller()
export class OAuthController {
  private readonly logger = new Logger(OAuthController.name);
  constructor(private readonly connections: ConnectionService) {}

  @ApiBearerAuth("bearer")
  @ApiEndpoint({
    summary: "Start OAuth consent",
    description:
      "Returns the provider authorize URL for the browser to begin interactive consent.",
    ok: OAuthStartResponse,
    notFound: true,
  })
  @Post("tenants/:id/connections/:connectionId/oauth/start")
  async start(
    @Param("id") tenantId: string,
    @Param("connectionId") connectionId: string,
  ): Promise<{ authorizeUrl: string }> {
    const conn = await this.connections.getById(tenantId, connectionId);
    if (!conn) throw new NotFoundException("Unknown connection");
    const redirectUri =
      process.env.OAUTH_REDIRECT_URI ??
      `http://localhost:${process.env.PORT ?? 3000}/oauth/callback`;
    // Consent stores the refresh token in the connection's OWN env (Slice 5) — the callback is
    // @Public and can't send X-Environment-Id, so the env rides in the (encoded) state.
    return startConsent({
      tenantId,
      environmentId: conn.environmentId,
      connectionId,
      serverUrl: conn.serverUrl,
      redirectUri,
    });
  }

  @ApiOperation({
    summary: "OAuth callback (provider redirect target)",
    description:
      "Public: the provider redirects the BROWSER here with a single-use `state` and `code`; " +
      "exchanges the code, persists the encrypted refresh token, then 302-redirects back to the " +
      "SPA integrations page (`?connected=1` on success, `?connect_error=…` otherwise).",
  })
  @ApiResponse({
    status: 302,
    description: "Redirect to the SPA integrations page.",
  })
  @Public() // provider redirect target; the single-use `state` is its credential
  @Get("oauth/callback")
  async callback(
    @Res() res: Response,
    @Query("state") state: string,
    @Query("code") code: string,
    @Query("iss") iss?: string,
  ): Promise<void> {
    // Browser-facing: 302 back to the SPA rather than rendering JSON / a 500. A replayed or expired
    // single-use `state` is benign (stays a warn); a genuine fault still alerts, so an outage
    // during consent isn't masked by the redirect (see reportConnectCallbackFailure).
    try {
      await completeConsent({ state, code, iss });
      res.redirect(connectReturnUrl({ ok: true, tab: "providers" }));
    } catch (err) {
      reportConnectCallbackFailure(err, this.logger, "OAuth callback");
      res.redirect(
        connectReturnUrl({ ok: false, tab: "providers", error: "oauth" }),
      );
    }
  }
}
