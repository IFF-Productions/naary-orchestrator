import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOkResponse, ApiOperation } from "@nestjs/swagger";
import {
  ConnectionService,
  completeConsent,
  startConsent,
} from "@naary/connections";
import { Public } from "../auth/public.decorator";
import { ApiEndpoint } from "../swagger/api-decorators";
import {
  OAuthCallbackResponse,
  OAuthStartResponse,
} from "./connection.response";

/**
 * Interactive OAuth consent (B3) — runs once in the web app. `start` returns the
 * authorize URL for the browser; the provider redirects back to `callback`, which
 * exchanges the code and persists the encrypted refresh token. The activity then
 * refreshes non-interactively (B4). Browser consent is deferred-live this slice.
 */
@Controller()
export class OAuthController {
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
      "Public: the provider redirects here with a single-use `state` (its credential) and `code`; exchanges the code and persists the encrypted refresh token.",
  })
  @ApiOkResponse({ type: OAuthCallbackResponse })
  @Public() // provider redirect target; the single-use `state` is its credential
  @Get("oauth/callback")
  callback(
    @Query("state") state: string,
    @Query("code") code: string,
    @Query("iss") iss?: string,
  ): Promise<{ connectionId: string }> {
    return completeConsent({ state, code, iss });
  }
}
