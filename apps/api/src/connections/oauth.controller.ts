import {
  BadGatewayException,
  BadRequestException,
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
  OAuthDiscoveryError,
  completeConsent,
  startConsent,
} from "@naary/connections";
import type { Response } from "express";
import { Public } from "../auth/public.decorator";
import { ApiEndpoint } from "../swagger/api-decorators";
import { reportConnectCallbackFailure } from "./connect-callback-error";
import { connectReturnUrl } from "./connect-return";
import { OAuthStartResponse } from "./connection.response";
import { oauthRedirectUri } from "../config";

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
    // This route is DISCOVERY-based consent: `.well-known` metadata + dynamic client registration
    // against the connection's own serverUrl. That is right for an arbitrary MCP server and
    // impossible for a provider with a fixed platform app, which has its own route (Atlassian's
    // `/connections/atlassian/oauth/start`).
    //
    // Sent here anyway, this used to reach `discoverOAuthMetadata` with an *.atlassian.net URL (or
    // an empty one) and die inside a fetch/URL parse — a 500 that says nothing, on the one screen
    // someone is already stuck on. The SPA no longer misroutes it (#1085), but an endpoint whose
    // failure mode for a wrong-typed connection is a 500 will be found again by an older tab, a
    // cached bundle or a script; answering with the actual reason costs one branch.
    if (conn.type === "atlassian") {
      throw new BadRequestException(
        "Atlassian connections use their own consent flow — POST /tenants/:id/connections/atlassian/oauth/start.",
      );
    }
    // Trimmed ONCE and then used — not tested for emptiness and passed raw. `startConsent` stores
    // this verbatim as the state's `resource` and puts it in the authorize URL, so surrounding
    // whitespace on an existing row would survive the guard and then break consent somewhere that
    // names neither the value nor this endpoint.
    const serverUrl = conn.serverUrl?.trim();
    if (!serverUrl) {
      throw new BadRequestException(
        "This connection has no server URL, so there is nothing to discover OAuth metadata from.",
      );
    }
    const redirectUri = oauthRedirectUri();
    // Consent stores the refresh token in the connection's OWN env (Slice 5) — the callback is
    // @Public and can't send X-Environment-Id, so the env rides in the (encoded) state.
    try {
      return await startConsent({
        tenantId,
        environmentId: conn.environmentId,
        connectionId,
        serverUrl,
        redirectUri,
      });
    } catch (e) {
      // "This server doesn't do OAuth" is the USER's problem to fix (wrong URL, wrong kind of
      // server), not a fault of ours — a 500 puts it in the error budget and tells them nothing.
      // Production reported four of these as `BlockedEgressError: invalid URL` (Sentry
      // NAARY-API-4) because a 404'd discovery document became the string "undefined" and the
      // egress guard, last to touch it, got the blame.
      if (e instanceof OAuthDiscoveryError) {
        // 502 when the failure is THEIRS and may pass (a 5xx, a reset): "we couldn't reach them"
        // and "you asked for the wrong thing" are different sentences, and only one of them is
        // worth retrying. A 400 on an upstream outage tells the user to change a request that was
        // fine.
        throw e.transient
          ? new BadGatewayException(e.message)
          : new BadRequestException(e.message);
      }
      throw e;
    }
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
